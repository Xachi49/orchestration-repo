import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExperimentEvidenceQualitySchema,
  HypothesisOutcomeSchema,
} from "./doctrine.js";
import { QuantityUnitSchema } from "./hypothesis.js";

/**
 * Observed measurement payload. `quality` is untrusted caller/model DATA only —
 * never authoritative. Authoritative quality is derived from Phase 8 verification.
 */
export const MeasurementResultSchema = z
  .object({
    measurementId: z.string().min(1),
    observedValue: z.number().finite().optional(),
    unit: QuantityUnitSchema,
    sampleCount: z.number().int().nonnegative(),
    /** Untrusted suggested quality — never creates evidence authority. */
    quality: ExperimentEvidenceQualitySchema,
    evidenceRefs: z.array(z.string().min(1)).default([]),
    limitations: z.array(z.string()).default([]),
  })
  .strict();

export type MeasurementResult = z.infer<typeof MeasurementResultSchema>;

export const HypothesisResultSchema = z
  .object({
    hypothesisId: z.string().min(1),
    outcome: HypothesisOutcomeSchema,
    rationale: z.string().min(1),
    evidenceQuality: ExperimentEvidenceQualitySchema,
  })
  .strict();

export type HypothesisResult = z.infer<typeof HypothesisResultSchema>;

export const ExperimentResultSchema = z
  .object({
    experimentResultId: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    measurementResults: z.array(MeasurementResultSchema),
    hypothesisResults: z.array(HypothesisResultSchema),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    dataQuality: ExperimentEvidenceQualitySchema,
    limitations: z.array(z.string()).default([]),
    stoppingReason: z.string().min(1),
    executionLineageId: z.string().min(1).optional(),
    outcomeVerificationIds: z.array(z.string().min(1)).default([]),
    hypothesisCount: z.number().int().positive(),
    correctionPolicy: z
      .enum(["NONE", "MULTIPLE_TESTING_UNADJUSTED"])
      .default("MULTIPLE_TESTING_UNADJUSTED"),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ExperimentResult = z.infer<typeof ExperimentResultSchema>;

export const ExperimentEvidenceBundleSchema = z
  .object({
    evidenceBundleId: z.string().min(1),
    evidenceBundleHash: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    experimentResultId: z.string().min(1),
    verifiedMeasurementEvidence: z.array(MeasurementResultSchema),
    /** Derived from Phase 8 — never caller self-assertion. */
    qualityClassification: ExperimentEvidenceQualitySchema,
    artifactRefs: z.array(z.string().min(1)).default([]),
    /** Resolved Phase 8 OutcomeVerificationRecord identities. */
    outcomeVerificationIds: z.array(z.string().min(1)).default([]),
    verificationRefs: z.array(z.string().min(1)).default([]),
    hypothesisOutcomeRefs: z.array(z.string().min(1)).default([]),
    assumptionBindings: z.array(z.string().min(1)).default([]),
    limitations: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ExperimentEvidenceBundle = z.infer<
  typeof ExperimentEvidenceBundleSchema
>;

export const AssumptionRevisionKindSchema = z.enum([
  "NUMERIC_PROMOTION",
  "WIDEN_INTERVAL",
  "RETAIN_PRIOR",
  "INSUFFICIENT_EVIDENCE",
]);

export const AssumptionEvidenceUpdateCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    candidateHash: z.string().min(1),
    candidateCreationVersion: z.literal(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    hypothesisId: z.string().min(1),
    sourceAssumptionId: z.string().min(1),
    /** Alias retained for callers — equals sourceAssumptionId. */
    assumptionId: z.string().min(1),
    sourceAssumptionSetId: z.string().min(1).optional(),
    sourceAssumptionSetVersion: z.number().int().positive().optional(),
    sourceAssumptionSetHash: z.string().min(1).optional(),
    priorAssumptionSetHash: z.string().min(1).optional(),
    evidenceBundleId: z.string().min(1),
    evidenceBundleHash: z.string().min(1),
    outcomeVerificationIds: z.array(z.string().min(1)).default([]),
    proposedValue: z.number().finite().optional(),
    proposedLowerBound: z.number().finite().optional(),
    proposedUpperBound: z.number().finite().optional(),
    proposedUnit: QuantityUnitSchema.optional(),
    evidenceQuality: ExperimentEvidenceQualitySchema,
    revisionKind: AssumptionRevisionKindSchema,
    /** Never mutates AssumptionSet in place — Phase 16 re-analysis required. */
    requiresPhase16Reanalysis: z.literal(true),
    notes: z.string().default(""),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AssumptionEvidenceUpdateCandidate = z.infer<
  typeof AssumptionEvidenceUpdateCandidateSchema
>;

export const ExperimentCompletionRecordSchema = z
  .object({
    completionRecordId: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    executionLineageId: z.string().min(1).optional(),
    evidenceBundleId: z.string().min(1),
    evidenceBundleHash: z.string().min(1),
    experimentResultId: z.string().min(1),
    outcomeVerificationIds: z.array(z.string().min(1)).default([]),
    terminalStatus: z.enum(["COMPLETED", "INCONCLUSIVE"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ExperimentCompletionRecord = z.infer<
  typeof ExperimentCompletionRecordSchema
>;

export const ExperimentExecutionLineageSchema = z
  .object({
    lineageId: z.string().min(1),
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    experimentAuthorizationRecordId: z.string().min(1),
    compiledObjectiveId: z.string().min(1).optional(),
    compiledObjectiveVersion: z.number().int().positive().optional(),
    compiledRunId: z.string().min(1).optional(),
    phase2AdmissionOutcome: z
      .enum(["ADMITTED", "DUPLICATE_REUSED"])
      .optional(),
    phase6AuthorizationRecordId: z.string().min(1).optional(),
    executionAttemptId: z.string().min(1).optional(),
    verificationOutcome: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ExperimentExecutionLineage = z.infer<
  typeof ExperimentExecutionLineageSchema
>;

export function computeEvidenceBundleHash(
  bundle: Omit<ExperimentEvidenceBundle, "evidenceBundleHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        artifactRefs: [...bundle.artifactRefs].sort(),
        assumptionBindings: [...bundle.assumptionBindings].sort(),
        createdAt: bundle.createdAt,
        evidenceBundleId: bundle.evidenceBundleId,
        experimentId: bundle.experimentId,
        experimentPlanHash: bundle.experimentPlanHash,
        experimentResultId: bundle.experimentResultId,
        experimentVersion: bundle.experimentVersion,
        hypothesisOutcomeRefs: [...bundle.hypothesisOutcomeRefs].sort(),
        limitations: bundle.limitations,
        outcomeVerificationIds: [...bundle.outcomeVerificationIds].sort(),
        qualityClassification: bundle.qualityClassification,
        verificationRefs: [...bundle.verificationRefs].sort(),
        verifiedMeasurementEvidence: bundle.verifiedMeasurementEvidence,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withEvidenceBundleHash(
  bundle: Omit<ExperimentEvidenceBundle, "evidenceBundleHash">,
): ExperimentEvidenceBundle {
  return ExperimentEvidenceBundleSchema.parse({
    ...bundle,
    evidenceBundleHash: computeEvidenceBundleHash(bundle),
  });
}

export function mintExperimentResultId(input: {
  experimentId: string;
  experimentPlanHash: string;
}): string {
  return `eres_${input.experimentId}_${input.experimentPlanHash.slice(0, 8)}`.slice(
    0,
    120,
  );
}

export function mintEvidenceBundleId(input: {
  experimentId: string;
  experimentResultId: string;
}): string {
  return `eeb_${input.experimentId}_${input.experimentResultId}`.slice(0, 120);
}

export function mintAssumptionUpdateCandidateId(input: {
  experimentId: string;
  assumptionId: string;
  evidenceBundleId: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `aeuc_${digest}`;
}

export function mintCompletionRecordId(input: {
  experimentId: string;
  evidenceBundleId: string;
}): string {
  return `ecomp_${input.experimentId}_${input.evidenceBundleId.slice(0, 12)}`.slice(
    0,
    120,
  );
}

export function mintExecutionLineageId(input: {
  experimentId: string;
  experimentPlanHash: string;
}): string {
  return `eexl_${input.experimentId}_${input.experimentPlanHash.slice(0, 8)}`.slice(
    0,
    120,
  );
}
