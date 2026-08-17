import type {
  PrecedentPromotionPolicy,
} from "../domain/memory/promotion.js";
import type { LearningCandidateType } from "../domain/memory/candidate.js";
import type { HistoricalOutcome } from "../domain/memory/historical-run.js";

/**
 * Conservative default promotion policy.
 * Auto-promote only low-risk PROJECT_LOCAL with complete provenance.
 */
export const DEFAULT_PROMOTION_POLICY: PrecedentPromotionPolicy = {
  minimumOutcomeQuality: [
    "VERIFIED_SUCCESS",
    "PARTIAL_SUCCESS",
    "VERIFICATION_FAILED",
    "INCONCLUSIVE",
    "CONTAINED",
    "BLOCKED",
    "REJECTED",
    "EXPIRED",
    "ESCALATED",
  ],
  minimumEvidenceCount: 0,
  allowedCandidateTypes: [
    "SUCCESS_PATTERN",
    "FAILURE_PATTERN",
    "CONTAINMENT_PATTERN",
    "RESOURCE_PATTERN",
    "VERIFICATION_PATTERN",
    "DEPENDENCY_PATTERN",
    "SECURITY_PATTERN",
    "PROCESS_PATTERN",
    "EVIDENCE_GAP_PATTERN",
  ],
  maximumRiskClassForAutoPromotion: "LOW",
  requiresHumanReviewForScopeClasses: [
    "PROJECT_CLASS",
    "GLOBAL_ADVISORY",
  ],
  requireNoUnresolvedContradictions: true,
  minimumIndependentRunCount: 1,
  allowAutoPromotion: true,
};

export function createPromotionPolicy(
  overrides?: Partial<PrecedentPromotionPolicy>,
): PrecedentPromotionPolicy {
  return {
    ...DEFAULT_PROMOTION_POLICY,
    ...overrides,
    minimumOutcomeQuality: (overrides?.minimumOutcomeQuality ??
      DEFAULT_PROMOTION_POLICY.minimumOutcomeQuality) as HistoricalOutcome[],
    allowedCandidateTypes: (overrides?.allowedCandidateTypes ??
      DEFAULT_PROMOTION_POLICY.allowedCandidateTypes) as LearningCandidateType[],
  };
}
