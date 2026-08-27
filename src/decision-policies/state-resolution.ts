import { createHash } from "node:crypto";
import { z } from "zod";
import type { DecisionContext } from "./context.js";
import { DecisionPolicyError } from "./errors.js";
import type { DecisionStateValues } from "./predicates.js";
import {
  DecisionStateSnapshotSchema,
  mintDecisionStateSnapshotId,
  type DecisionStateSnapshot,
} from "./snapshot.js";
import type {
  DecisionStateVariable,
  QuantityUnit,
  StateSourceClass,
} from "./variables-actions.js";

/**
 * CALLER/MODEL STATE VALUES != AUTHORITATIVE DECISION STATE.
 *
 * DecisionStateSnapshot is built only from source-class resolution.
 * Caller hints are DATA, never authority.
 */
export const DECISION_STATE_RESOLVER_VERSION = "decision_state_resolver_v1";

export const ResolvedStateObservationSchema = z
  .object({
    variableId: z.string().min(1),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    unit: z.string().min(1),
    sourceId: z.string().min(1),
    sourceHash: z.string().min(1),
    sourceClass: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    observedAt: z.string().datetime(),
    validUntil: z.string().datetime().optional(),
    quality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    missing: z.boolean().default(false),
  })
  .strict();

export type ResolvedStateObservation = z.infer<
  typeof ResolvedStateObservationSchema
>;

export interface DecisionStateSourcePort {
  /**
   * Resolve one declared state variable from its sourceClass.
   * Return null when the source is absent (missingValuePolicy applies).
   */
  resolve(input: {
    variable: DecisionStateVariable;
    projectIds: readonly string[];
    environment: string;
  }): Promise<ResolvedStateObservation | null>;
}

export class InMemoryDecisionStateSourcePort implements DecisionStateSourcePort {
  private readonly byVariableId = new Map<string, ResolvedStateObservation>();

  seed(observation: ResolvedStateObservation): void {
    this.byVariableId.set(
      observation.variableId,
      ResolvedStateObservationSchema.parse(observation),
    );
  }

  clear(variableId?: string): void {
    if (variableId) this.byVariableId.delete(variableId);
    else this.byVariableId.clear();
  }

  async resolve(input: {
    variable: DecisionStateVariable;
    projectIds: readonly string[];
    environment: string;
  }): Promise<ResolvedStateObservation | null> {
    return this.byVariableId.get(input.variable.variableId) ?? null;
  }
}

export function computeResolverConfigHash(input: {
  resolverVersion: string;
  stateVariableIds: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        resolverVersion: input.resolverVersion,
        stateVariableIds: [...input.stateVariableIds].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

export class DecisionStateResolutionService {
  constructor(
    private readonly deps: {
      source: DecisionStateSourcePort;
      nowIso: () => string;
      resolverVersion?: string;
    },
  ) {}

  /**
   * Build an authoritative snapshot. `hints` are never copied into values.
   */
  async resolve(input: {
    context: DecisionContext;
    environment: string;
    hints?: DecisionStateValues;
  }): Promise<DecisionStateSnapshot> {
    void input.hints;
    if (!input.context.environmentScope.includes(input.environment)) {
      throw new DecisionPolicyError(
        "DECISION_STATE_SCOPE_MISMATCH",
        `Environment ${input.environment} is not in decision context scope`,
      );
    }
    const resolverVersion =
      this.deps.resolverVersion ?? DECISION_STATE_RESOLVER_VERSION;
    const values: Record<string, string | number | boolean | null> = {};
    const sourceIdentities: Record<string, string> = {};
    const sourceHashes: Record<string, string> = {};
    const capturedAtByVariable: Record<string, string> = {};
    const measurementQualityByVariable: Record<
      string,
      "VALIDATED" | "PARTIAL" | "DEGRADED" | "UNKNOWN"
    > = {};
    const units: Record<string, string> = {};
    const sourceClasses: Record<string, StateSourceClass> = {};
    const nowMs = Date.parse(this.deps.nowIso());

    for (const variable of input.context.stateVariables) {
      const observation = await this.deps.source.resolve({
        variable,
        projectIds: input.context.projectIds,
        environment: input.environment,
      });
      const applied = this.applyObservation({
        variable,
        observation,
        context: input.context,
        environment: input.environment,
        nowMs,
      });
      values[variable.variableId] = applied.value;
      sourceIdentities[variable.variableId] = applied.sourceId;
      sourceHashes[variable.variableId] = applied.sourceHash;
      capturedAtByVariable[variable.variableId] = applied.observedAt;
      measurementQualityByVariable[variable.variableId] = applied.quality;
      units[variable.variableId] = variable.unit;
      sourceClasses[variable.variableId] = variable.sourceClass;
    }

    const variableDefinitionIds = input.context.stateVariables.map(
      (v) => v.variableId,
    );
    const resolverConfigHash = computeResolverConfigHash({
      resolverVersion,
      stateVariableIds: variableDefinitionIds,
    });

    return buildAuthoritativeSnapshot({
      decisionContextId: input.context.decisionContextId,
      decisionContextVersion: input.context.decisionContextVersion,
      projectIds: input.context.projectIds,
      environment: input.environment,
      values,
      units,
      sourceClasses,
      variableDefinitionIds,
      sourceIdentities,
      sourceHashes,
      observedAtByVariable: capturedAtByVariable,
      measurementQualityByVariable,
      resolverVersion,
      resolverConfigHash,
    });
  }

  private applyObservation(input: {
    variable: DecisionStateVariable;
    observation: ResolvedStateObservation | null;
    context: DecisionContext;
    environment: string;
    nowMs: number;
  }): {
    value: string | number | boolean | null;
    sourceId: string;
    sourceHash: string;
    observedAt: string;
    quality: "VALIDATED" | "PARTIAL" | "DEGRADED" | "UNKNOWN";
  } {
    const { variable, observation } = input;
    if (!observation || observation.missing || observation.value === null) {
      return this.applyMissing(variable);
    }
    if (!input.context.projectIds.includes(observation.projectId)) {
      throw new DecisionPolicyError(
        "DECISION_STATE_SCOPE_MISMATCH",
        `State source project ${observation.projectId} is outside decision context`,
        { variableId: variable.variableId },
      );
    }
    if (observation.environment !== input.environment) {
      throw new DecisionPolicyError(
        "DECISION_STATE_SCOPE_MISMATCH",
        `State source environment ${observation.environment} does not match request`,
        { variableId: variable.variableId },
      );
    }
    if (observation.unit !== variable.unit) {
      throw new DecisionPolicyError(
        "DECISION_STATE_UNIT_MISMATCH",
        `State source unit ${observation.unit} does not match variable unit ${variable.unit}`,
        { variableId: variable.variableId },
      );
    }
    const age = input.nowMs - Date.parse(observation.observedAt);
    if (age > variable.freshnessRequirementMs) {
      throw new DecisionPolicyError(
        "DECISION_STATE_STALE",
        `State variable ${variable.variableId} is stale`,
        { ageMs: age, freshnessRequirementMs: variable.freshnessRequirementMs },
      );
    }
    if (
      observation.validUntil &&
      Date.parse(observation.validUntil) < input.nowMs
    ) {
      throw new DecisionPolicyError(
        "DECISION_STATE_STALE",
        `State variable ${variable.variableId} validUntil elapsed`,
      );
    }
    if (
      variable.qualityRequirement === "VALIDATED" &&
      observation.quality !== "VALIDATED"
    ) {
      throw new DecisionPolicyError(
        "DECISION_STATE_INSUFFICIENT",
        `State variable ${variable.variableId} quality ${observation.quality} below VALIDATED`,
      );
    }
    if (variable.allowedRange && typeof observation.value === "number") {
      if (
        variable.allowedRange.min !== undefined &&
        observation.value < variable.allowedRange.min
      ) {
        throw new DecisionPolicyError(
          "DECISION_STATE_INSUFFICIENT",
          `State variable ${variable.variableId} below allowed range`,
        );
      }
      if (
        variable.allowedRange.max !== undefined &&
        observation.value > variable.allowedRange.max
      ) {
        throw new DecisionPolicyError(
          "DECISION_STATE_INSUFFICIENT",
          `State variable ${variable.variableId} above allowed range`,
        );
      }
    }
    return {
      value: observation.value,
      sourceId: observation.sourceId,
      sourceHash: observation.sourceHash,
      observedAt: observation.observedAt,
      quality: observation.quality,
    };
  }

  private applyMissing(variable: DecisionStateVariable): {
    value: string | number | boolean | null;
    sourceId: string;
    sourceHash: string;
    observedAt: string;
    quality: "VALIDATED" | "PARTIAL" | "DEGRADED" | "UNKNOWN";
  } {
    if (variable.missingValuePolicy === "FAIL_CLOSED") {
      throw new DecisionPolicyError(
        "DECISION_STATE_INSUFFICIENT",
        `Missing required state variable ${variable.variableId}`,
      );
    }
    if (variable.missingValuePolicy === "USE_DEFAULT") {
      if (variable.defaultValue === undefined) {
        throw new DecisionPolicyError(
          "DECISION_STATE_INSUFFICIENT",
          `USE_DEFAULT configured but no defaultValue for ${variable.variableId}`,
        );
      }
      return {
        value: variable.defaultValue,
        sourceId: `missing:${variable.variableId}`,
        sourceHash: "missing_default",
        observedAt: this.deps.nowIso(),
        quality: "UNKNOWN",
      };
    }
    // NO_ACTION — persist null; policy default action applies. No fabricated value.
    return {
      value: null,
      sourceId: `missing:${variable.variableId}`,
      sourceHash: "missing_null",
      observedAt: this.deps.nowIso(),
      quality: "UNKNOWN",
    };
  }
}

export function buildAuthoritativeSnapshot(input: {
  decisionContextId: string;
  decisionContextVersion: number;
  projectIds: readonly string[];
  environment: string;
  values: Record<string, string | number | boolean | null>;
  units: Record<string, string>;
  sourceClasses: Record<string, StateSourceClass>;
  variableDefinitionIds: readonly string[];
  sourceIdentities: Record<string, string>;
  sourceHashes: Record<string, string>;
  observedAtByVariable: Record<string, string>;
  measurementQualityByVariable: Record<
    string,
    "VALIDATED" | "PARTIAL" | "DEGRADED" | "UNKNOWN"
  >;
  resolverVersion: string;
  resolverConfigHash: string;
}): DecisionStateSnapshot {
  const snapshotHash = computeAuthoritativeSnapshotHash(input);
  return DecisionStateSnapshotSchema.parse({
    decisionStateSnapshotId: mintDecisionStateSnapshotId(snapshotHash),
    decisionContextId: input.decisionContextId,
    decisionContextVersion: input.decisionContextVersion,
    projectIds: [...input.projectIds],
    environment: input.environment,
    values: input.values,
    units: input.units,
    sourceClasses: input.sourceClasses,
    variableDefinitionIds: [...input.variableDefinitionIds],
    sourceIdentities: input.sourceIdentities,
    sourceHashes: input.sourceHashes,
    capturedAtByVariable: input.observedAtByVariable,
    measurementQualityByVariable: input.measurementQualityByVariable,
    resolverVersion: input.resolverVersion,
    resolverConfigHash: input.resolverConfigHash,
    snapshotHash,
  });
}

/**
 * Hash binds provenance identities — not wall-clock resolution time.
 */
export function computeAuthoritativeSnapshotHash(input: {
  decisionContextId: string;
  decisionContextVersion: number;
  projectIds: readonly string[];
  environment: string;
  values: Record<string, string | number | boolean | null>;
  units: Record<string, string>;
  sourceClasses: Record<string, StateSourceClass>;
  variableDefinitionIds: readonly string[];
  sourceIdentities: Record<string, string>;
  sourceHashes: Record<string, string>;
  observedAtByVariable: Record<string, string>;
  measurementQualityByVariable: Record<string, string>;
  resolverVersion: string;
  resolverConfigHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        decisionContextId: input.decisionContextId,
        decisionContextVersion: input.decisionContextVersion,
        projectIds: [...input.projectIds].sort(),
        environment: input.environment,
        variableDefinitionIds: [...input.variableDefinitionIds].sort(),
        values: input.values,
        units: input.units,
        sourceClasses: input.sourceClasses,
        sourceIdentities: input.sourceIdentities,
        sourceHashes: input.sourceHashes,
        observedAtByVariable: input.observedAtByVariable,
        measurementQualityByVariable: input.measurementQualityByVariable,
        resolverVersion: input.resolverVersion,
        resolverConfigHash: input.resolverConfigHash,
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintSeededObservation(input: {
  variableId: string;
  value: string | number | boolean;
  unit: QuantityUnit;
  sourceClass: StateSourceClass;
  projectId: string;
  environment: string;
  observedAt: string;
  quality?: ResolvedStateObservation["quality"];
  sourceId?: string;
  sourceHash?: string;
}): ResolvedStateObservation {
  return ResolvedStateObservationSchema.parse({
    variableId: input.variableId,
    value: input.value,
    unit: input.unit,
    sourceId: input.sourceId ?? `src_${input.variableId}`,
    sourceHash: input.sourceHash ?? `sh_${input.variableId}`,
    sourceClass: input.sourceClass,
    projectId: input.projectId,
    environment: input.environment,
    observedAt: input.observedAt,
    quality: input.quality ?? "VALIDATED",
    missing: false,
  });
}
