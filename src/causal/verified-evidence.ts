import { createHash } from "node:crypto";
import { z } from "zod";
import { CausalError } from "./errors.js";
import { QuantityUnitSchema } from "./variables.js";

/**
 * CALLER-SUPPLIED SAMPLE VALUES != CAUSAL ESTIMATION AUTHORITY.
 *
 * Estimator inputs must be resolved from authoritative persisted evidence
 * (ExperimentEvidenceBundle + plan + lineage + Phase 8), never trusted from
 * API/model payloads alone.
 */
export const ResolvedRandomizedEvidenceSchema = z
  .object({
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    experimentPlanVersion: z.number().int().positive(),
    assignmentMethod: z.literal("RANDOMIZED"),
    assignmentProvenance: z.string().min(1),
    assignmentFingerprint: z.string().min(1),
    evidenceBundleId: z.string().min(1),
    evidenceBundleHash: z.string().min(1),
    experimentResultId: z.string().min(1),
    outcomeVerificationIds: z.array(z.string().min(1)).min(1),
    verificationRefs: z.array(z.string().min(1)).min(1),
    measurementIds: z.array(z.string().min(1)).min(2),
    projectId: z.string().min(1),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    outcomeUnit: QuantityUnitSchema,
    quality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    treatmentMean: z.number().finite(),
    controlMean: z.number().finite(),
    treatmentSampleCount: z.number().int().positive(),
    controlSampleCount: z.number().int().positive(),
    /** Derived from persisted verified measurements — not caller arrays. */
    treatmentMeasurements: z.array(z.number().finite()).min(1),
    controlMeasurements: z.array(z.number().finite()).min(1),
    compiledRunId: z.string().min(1).optional(),
    lineageId: z.string().min(1).optional(),
  })
  .strict();

export type ResolvedRandomizedEvidence = z.infer<
  typeof ResolvedRandomizedEvidenceSchema
>;

export interface AuthoritativeExperimentEvidencePort {
  /**
   * Resolve and cross-check randomized experiment evidence for estimation.
   * Must fail closed on scope/plan/hash/project mismatches.
   */
  resolveForEstimation(input: {
    experimentId: string;
    expectedProjectIds: readonly string[];
    expectedEnvironment: string;
    expectedOutcomeUnit: string;
    /** When set, must match the persisted plan hash exactly. */
    expectedExperimentPlanHash?: string;
  }): Promise<ResolvedRandomizedEvidence>;
}

export function computeAssignmentFingerprint(input: {
  experimentId: string;
  experimentPlanHash: string;
  assignmentMethod: string;
  randomSeed?: string;
  unitOfAssignment?: string;
  measurementIds: readonly string[];
  treatmentMembership: readonly string[];
  controlMembership: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        experimentId: input.experimentId,
        experimentPlanHash: input.experimentPlanHash,
        assignmentMethod: input.assignmentMethod,
        randomSeed: input.randomSeed ?? null,
        unitOfAssignment: input.unitOfAssignment ?? null,
        measurementIds: [...input.measurementIds].sort(),
        treatmentMembership: [...input.treatmentMembership].sort(),
        controlMembership: [...input.controlMembership].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function assertResolvedEvidenceMatchesQuestion(
  resolved: ResolvedRandomizedEvidence,
  input: {
    expectedProjectIds: readonly string[];
    expectedEnvironment: string;
    expectedOutcomeUnit: string;
    expectedExperimentPlanHash?: string;
  },
): void {
  if (!input.expectedProjectIds.includes(resolved.projectId)) {
    throw new CausalError(
      "CAUSAL_EVIDENCE_INVALID",
      "Resolved evidence project not in causal question project scope",
      {
        evidenceProjectId: resolved.projectId,
        expectedProjectIds: input.expectedProjectIds,
      },
    );
  }
  if (resolved.environmentScope !== input.expectedEnvironment) {
    throw new CausalError(
      "CAUSAL_EVIDENCE_INVALID",
      "Resolved evidence environment does not match causal question",
      {
        evidenceEnvironment: resolved.environmentScope,
        expectedEnvironment: input.expectedEnvironment,
      },
    );
  }
  if (resolved.outcomeUnit !== input.expectedOutcomeUnit) {
    throw new CausalError(
      "UNIT_MIXING_REJECTED",
      "Resolved evidence outcome unit mismatches question",
      {
        evidenceUnit: resolved.outcomeUnit,
        expectedUnit: input.expectedOutcomeUnit,
      },
    );
  }
  if (
    input.expectedExperimentPlanHash &&
    resolved.experimentPlanHash !== input.expectedExperimentPlanHash
  ) {
    throw new CausalError(
      "CAUSAL_EVIDENCE_INVALID",
      "Resolved evidence experimentPlanHash mismatch",
      {
        evidencePlanHash: resolved.experimentPlanHash,
        expectedExperimentPlanHash: input.expectedExperimentPlanHash,
      },
    );
  }
  if (resolved.assignmentMethod !== "RANDOMIZED") {
    throw new CausalError(
      "CAUSAL_EVIDENCE_INVALID",
      "RANDOMIZED_TREATMENT requires ExperimentPlan assignmentMethod RANDOMIZED",
    );
  }
  if (resolved.quality !== "VALIDATED") {
    throw new CausalError(
      "CAUSAL_EVIDENCE_INVALID",
      "RANDOMIZED_TREATMENT estimation requires VALIDATED evidence quality",
      { quality: resolved.quality },
    );
  }
}

/**
 * In-memory authoritative store for unit tests.
 * Caller-supplied attachEvidence samples are NOT registered here.
 */
export class InMemoryAuthoritativeExperimentEvidencePort
  implements AuthoritativeExperimentEvidencePort
{
  private readonly byExperimentId = new Map<string, ResolvedRandomizedEvidence>();

  seed(resolved: ResolvedRandomizedEvidence): void {
    const parsed = ResolvedRandomizedEvidenceSchema.parse(resolved);
    this.byExperimentId.set(parsed.experimentId, parsed);
  }

  async resolveForEstimation(input: {
    experimentId: string;
    expectedProjectIds: readonly string[];
    expectedEnvironment: string;
    expectedOutcomeUnit: string;
    expectedExperimentPlanHash?: string;
  }): Promise<ResolvedRandomizedEvidence> {
    const resolved = this.byExperimentId.get(input.experimentId);
    if (!resolved) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        `No authoritative evidence for experiment ${input.experimentId}`,
      );
    }
    if (resolved.experimentId !== input.experimentId) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Cross-experiment evidence substitution rejected",
      );
    }
    assertResolvedEvidenceMatchesQuestion(resolved, input);
    return resolved;
  }
}

export function mintSeededRandomizedEvidence(input: {
  experimentId: string;
  projectId: string;
  environment: string;
  outcomeUnit?: "PERCENT" | "RATIO" | "COUNT" | "DIMENSIONLESS";
  experimentPlanHash?: string;
  treatmentMean?: number;
  controlMean?: number;
  treatmentSampleCount?: number;
  controlSampleCount?: number;
}): ResolvedRandomizedEvidence {
  const experimentPlanHash = input.experimentPlanHash ?? "eplan_hash_seeded_1";
  const treatmentSampleCount = input.treatmentSampleCount ?? 40;
  const controlSampleCount = input.controlSampleCount ?? 40;
  const treatmentMean = input.treatmentMean ?? 12;
  const controlMean = input.controlMean ?? 8;
  const treatmentMembership = ["meas_treatment_primary"];
  const controlMembership = ["meas_control_primary"];
  const measurementIds = [...treatmentMembership, ...controlMembership];
  const assignmentFingerprint = computeAssignmentFingerprint({
    experimentId: input.experimentId,
    experimentPlanHash,
    assignmentMethod: "RANDOMIZED",
    randomSeed: "seed_test_1",
    unitOfAssignment: "user",
    measurementIds,
    treatmentMembership,
    controlMembership,
  });
  const evidenceBundleId = `eeb_${input.experimentId}`;
  const evidenceBundleHash = createHash("sha256")
    .update(
      JSON.stringify({
        evidenceBundleId,
        experimentId: input.experimentId,
        experimentPlanHash,
        treatmentMean,
        controlMean,
      }),
      "utf8",
    )
    .digest("hex");
  return ResolvedRandomizedEvidenceSchema.parse({
    experimentId: input.experimentId,
    experimentVersion: 1,
    experimentPlanHash,
    experimentPlanVersion: 1,
    assignmentMethod: "RANDOMIZED",
    assignmentProvenance: `lineage:${input.experimentId}:assignment`,
    assignmentFingerprint,
    evidenceBundleId,
    evidenceBundleHash,
    experimentResultId: `eres_${input.experimentId}`,
    outcomeVerificationIds: [`ovr_${input.experimentId}`],
    verificationRefs: [`ovr_${input.experimentId}`],
    measurementIds,
    projectId: input.projectId,
    populationScope: input.projectId,
    environmentScope: input.environment,
    outcomeUnit: input.outcomeUnit ?? "PERCENT",
    quality: "VALIDATED",
    treatmentMean,
    controlMean,
    treatmentSampleCount,
    controlSampleCount,
    treatmentMeasurements: Array.from(
      { length: treatmentSampleCount },
      () => treatmentMean,
    ),
    controlMeasurements: Array.from(
      { length: controlSampleCount },
      () => controlMean,
    ),
    compiledRunId: `run_${input.experimentId}`,
    lineageId: `lin_${input.experimentId}`,
  });
}
