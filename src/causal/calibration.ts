import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Calibration candidate is a proposal only.
 * Never automatically mutates AssumptionSets, models, policy, or strategy.
 *
 * Required source: ACTIVE PromotedCausalClaim — never unreviewed estimates,
 * CausalClaimCandidate alone, or rejected claims.
 */
export const DecisionModelCalibrationCandidateSchema = z
  .object({
    candidateId: z.string().min(1),
    sourcePromotedCausalClaimIds: z.array(z.string().min(1)).min(1),
    promotedCausalClaimId: z.string().min(1),
    promotedClaimHash: z.string().min(1),
    reviewRecordId: z.string().min(1),
    sourceClaimHash: z.string().min(1),
    identificationAnalysisId: z.string().min(1),
    evidenceSynthesisHash: z.string().min(1),
    sourceExperimentIds: z.array(z.string().min(1)).default([]),
    affectedModelComponent: z.string().min(1),
    currentValueOrRelationship: z.string().min(1),
    proposedValueOrRelationship: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    scope: z.string().min(1),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    expectedImpact: z.string().min(1),
    limitations: z.array(z.string()).default([]),
    requiresPhase16Reanalysis: z.literal(true),
    candidateHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionModelCalibrationCandidate = z.infer<
  typeof DecisionModelCalibrationCandidateSchema
>;

export function withCalibrationCandidateHash(
  candidate: Omit<DecisionModelCalibrationCandidate, "candidateHash">,
): DecisionModelCalibrationCandidate {
  const { candidateId: _id, createdAt: _c, ...rest } = candidate;
  const candidateHash = createHash("sha256")
    .update(JSON.stringify(rest), "utf8")
    .digest("hex");
  return DecisionModelCalibrationCandidateSchema.parse({
    ...candidate,
    candidateHash,
  });
}

export function mintCalibrationCandidateId(input: {
  promotedCausalClaimId: string;
  affectedModelComponent: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `dmcc_${digest}`;
}

export const CausalEvidenceGapSchema = z
  .object({
    evidenceGapId: z.string().min(1),
    causalQuestionId: z.string().min(1),
    missingAssumption: z.string().optional(),
    missingConfounderMeasurement: z.string().optional(),
    insufficientSample: z.boolean().default(false),
    scopeGap: z.string().optional(),
    contradictoryEvidence: z.boolean().default(false),
    recommendedExperimentCharacteristics: z.array(z.string()).default([]),
    /** May feed Phase 17 ActiveLearningCandidate — never authorizes experiments. */
    mayFeedPhase17ActiveLearning: z.literal(true),
    doesNotAuthorizeExperiment: z.literal(true),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalEvidenceGap = z.infer<typeof CausalEvidenceGapSchema>;

export function mintEvidenceGapId(causalQuestionId: string): string {
  return `ceg_${causalQuestionId}_${createHash("sha256")
    .update(causalQuestionId, "utf8")
    .digest("hex")
    .slice(0, 8)}`;
}
