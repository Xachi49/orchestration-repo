import { createHash } from "node:crypto";
import { z } from "zod";
import type { DecisionContext } from "./context.js";
import { DecisionPolicyError } from "./errors.js";
import type { DecisionStateValues } from "./predicates.js";

export const DecisionStateSnapshotSchema = z
  .object({
    decisionStateSnapshotId: z.string().min(1),
    decisionContextId: z.string().min(1),
    decisionContextVersion: z.number().int().positive(),
    projectIds: z.array(z.string().min(1)).min(1),
    environment: z.string().min(1),
    values: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
    units: z.record(z.string(), z.string().min(1)).default({}),
    sourceClasses: z.record(z.string(), z.string().min(1)).default({}),
    variableDefinitionIds: z.array(z.string().min(1)).default([]),
    sourceIdentities: z.record(z.string(), z.string().min(1)),
    sourceHashes: z.record(z.string(), z.string().min(1)),
    capturedAtByVariable: z.record(z.string(), z.string().datetime()),
    measurementQualityByVariable: z.record(
      z.string(),
      z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    ),
    resolverVersion: z.string().min(1).default("decision_state_resolver_v1"),
    resolverConfigHash: z.string().min(1).default("unspecified"),
    snapshotHash: z.string().min(1),
  })
  .strict();

export type DecisionStateSnapshot = z.infer<typeof DecisionStateSnapshotSchema>;

export function computeSnapshotHash(
  input: Omit<DecisionStateSnapshot, "snapshotHash" | "decisionStateSnapshotId">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        decisionContextId: input.decisionContextId,
        decisionContextVersion: input.decisionContextVersion,
        projectIds: [...input.projectIds].sort(),
        environment: input.environment,
        variableDefinitionIds: [...(input.variableDefinitionIds ?? [])].sort(),
        values: input.values,
        units: input.units ?? {},
        sourceClasses: input.sourceClasses ?? {},
        sourceIdentities: input.sourceIdentities,
        sourceHashes: input.sourceHashes,
        observedAtByVariable: input.capturedAtByVariable,
        measurementQualityByVariable: input.measurementQualityByVariable,
        resolverVersion: input.resolverVersion,
        resolverConfigHash: input.resolverConfigHash,
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintDecisionStateSnapshotId(snapshotHash: string): string {
  return `dss_${snapshotHash.slice(0, 24)}`;
}

export function buildDecisionStateSnapshot(input: {
  decisionContextId: string;
  decisionContextVersion: number;
  projectIds: readonly string[];
  environment: string;
  values: DecisionStateValues;
  sourceIdentities: Record<string, string>;
  sourceHashes: Record<string, string>;
  capturedAtByVariable: Record<string, string>;
  measurementQualityByVariable: Record<
    string,
    "VALIDATED" | "PARTIAL" | "DEGRADED" | "UNKNOWN"
  >;
  capturedAt: string;
}): DecisionStateSnapshot {
  const base = {
    decisionContextId: input.decisionContextId,
    decisionContextVersion: input.decisionContextVersion,
    projectIds: [...input.projectIds],
    environment: input.environment,
    values: Object.fromEntries(
      Object.entries(input.values).map(([k, v]) => [k, v ?? null]),
    ),
    units: {} as Record<string, string>,
    sourceClasses: {} as Record<string, string>,
    variableDefinitionIds: Object.keys(input.values).sort(),
    sourceIdentities: input.sourceIdentities,
    sourceHashes: input.sourceHashes,
    capturedAtByVariable: input.capturedAtByVariable,
    measurementQualityByVariable: input.measurementQualityByVariable,
    resolverVersion: "legacy_buildSnapshot",
    resolverConfigHash: "legacy_buildSnapshot",
  };
  const snapshotHash = computeSnapshotHash(base);
  return DecisionStateSnapshotSchema.parse({
    ...base,
    decisionStateSnapshotId: mintDecisionStateSnapshotId(snapshotHash),
    snapshotHash,
  });
}

export function assertSnapshotFreshness(input: {
  context: DecisionContext;
  snapshot: DecisionStateSnapshot;
  nowMs: number;
}): void {
  for (const variable of input.context.stateVariables) {
    const capturedAt = input.snapshot.capturedAtByVariable[variable.variableId];
    const value = input.snapshot.values[variable.variableId];
    if (value === null || value === undefined) {
      if (variable.missingValuePolicy === "FAIL_CLOSED") {
        throw new DecisionPolicyError(
          "DECISION_STATE_INSUFFICIENT",
          `Missing required state variable ${variable.variableId}`,
        );
      }
      continue;
    }
    if (!capturedAt) {
      throw new DecisionPolicyError(
        "DECISION_STATE_STALE",
        `Missing capture timestamp for ${variable.variableId}`,
      );
    }
    const age = input.nowMs - Date.parse(capturedAt);
    if (age > variable.freshnessRequirementMs) {
      throw new DecisionPolicyError(
        "DECISION_STATE_STALE",
        `State variable ${variable.variableId} is stale`,
        { ageMs: age, freshnessRequirementMs: variable.freshnessRequirementMs },
      );
    }
    const quality =
      input.snapshot.measurementQualityByVariable[variable.variableId];
    if (
      variable.qualityRequirement === "VALIDATED" &&
      quality !== "VALIDATED"
    ) {
      throw new DecisionPolicyError(
        "DECISION_STATE_INSUFFICIENT",
        `State variable ${variable.variableId} quality ${quality} below VALIDATED`,
      );
    }
  }
}
