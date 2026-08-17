import { z } from "zod";
import {
  LearningCandidateTypeSchema,
} from "./candidate.js";
import {
  PrecedentApplicabilitySchema,
  RiskClassSchema,
  ScopeClassSchema,
} from "./applicability.js";
import { HistoricalOutcomeSchema } from "./historical-run.js";
import { ClaimGroundingVerdictSchema } from "./claim.js";

export const PrecedentPromotionReadinessStatusSchema = z.enum([
  "READY_FOR_AUTO_PROMOTION",
  "READY_FOR_HUMAN_REVIEW",
  "NOT_ELIGIBLE",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
  "INVALID_PROVENANCE",
  "PROMOTION_GROUNDING_INSUFFICIENT",
]);
export type PrecedentPromotionReadinessStatus = z.infer<
  typeof PrecedentPromotionReadinessStatusSchema
>;

/**
 * Deterministic metadata governing memory promotion.
 * This is NOT Control Plane policy.
 */
export const PrecedentPromotionPolicySchema = z
  .object({
    minimumOutcomeQuality: z.array(HistoricalOutcomeSchema).min(1),
    minimumEvidenceCount: z.number().int().nonnegative().default(0),
    allowedCandidateTypes: z.array(LearningCandidateTypeSchema).min(1),
    maximumRiskClassForAutoPromotion: RiskClassSchema.default("LOW"),
    requiresHumanReviewForScopeClasses: z
      .array(ScopeClassSchema)
      .default(["PROJECT_CLASS", "GLOBAL_ADVISORY"]),
    requireNoUnresolvedContradictions: z.boolean().default(true),
    minimumIndependentRunCount: z.number().int().positive().default(1),
    allowAutoPromotion: z.boolean().default(true),
  })
  .strict();

export type PrecedentPromotionPolicy = z.infer<
  typeof PrecedentPromotionPolicySchema
>;

export const PrecedentPromotionDecisionKindSchema = z.enum([
  "PROMOTE",
  "REJECT",
  "REQUEST_NARROWER_SCOPE",
]);
export type PrecedentPromotionDecisionKind = z.infer<
  typeof PrecedentPromotionDecisionKindSchema
>;

/**
 * Human review decision for memory promotion.
 * Separate from Phase 6 execution AuthorizationRecord.
 */
export const PrecedentPromotionDecisionSchema = z
  .object({
    promotionDecisionId: z.string().min(1),
    learningCandidateId: z.string().min(1),
    candidateHash: z.string().min(1),
    groundingVerdict: ClaimGroundingVerdictSchema,
    reviewerId: z.string().min(1),
    decision: PrecedentPromotionDecisionKindSchema,
    approvedApplicability: PrecedentApplicabilitySchema.optional(),
    decidedAt: z.string().datetime(),
    note: z.string().optional(),
    decisionHash: z.string().min(1),
  })
  .strict();

export type PrecedentPromotionDecision = z.infer<
  typeof PrecedentPromotionDecisionSchema
>;

export function parsePrecedentPromotionPolicy(
  input: unknown,
): PrecedentPromotionPolicy {
  return PrecedentPromotionPolicySchema.parse(input);
}

export function parsePrecedentPromotionDecision(
  input: unknown,
): PrecedentPromotionDecision {
  return PrecedentPromotionDecisionSchema.parse(input);
}
