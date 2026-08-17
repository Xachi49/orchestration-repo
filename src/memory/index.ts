/**
 * Memory authority boundary.
 * May store verified outcomes as governed precedents.
 * Cannot override policy, budgets, capabilities, authorization, or current repo truth.
 *
 * HISTORICAL DATA ≠ TRUSTED PRECEDENT ≠ POLICY ≠ AUTHORIZATION ≠ CURRENT TRUTH
 */
export interface MemoryPort {
  readonly authority: "STORE_VERIFIED_OUTCOMES_ONLY";
}

export const MEMORY_AUTHORITY = {
  mayStoreVerifiedOutcomes: true,
  mayOverridePolicy: false,
  mayOverrideVerifiedProjectState: false,
  mayAuthorizeExecution: false,
  mayChangeCapabilities: false,
  mayChangeBudgets: false,
  mayPromoteFromModelAlone: false,
} as const;

export {
  MEMORY_ERROR_CODES,
  MemoryError,
  isMemoryError,
  LearningPreDispatchError,
  isLearningPreDispatchError,
  type MemoryErrorCode,
} from "./errors.js";

export {
  SequenceMemoryIdentityGenerator,
  type MemoryIdentityGenerator,
} from "./identity.js";

export {
  HistoricalRunRecordHasher,
  ProvenanceHasher,
  CandidateHasher,
  PrecedentHasher,
  PromotionDecisionHasher,
} from "./hasher.js";

export {
  InMemoryHistoricalRunRepository,
  type HistoricalRunRepository,
} from "./historical-run-repository.js";

export {
  InMemoryLearningCandidateRepository,
  type LearningCandidateRepository,
} from "./candidate-repository.js";

export {
  InMemoryPromotedPrecedentRepository,
  type PromotedPrecedentRepository,
} from "./promoted-precedent-repository.js";

export {
  InMemoryPrecedentPromotionDecisionRepository,
  type PrecedentPromotionDecisionRepository,
} from "./promotion-decision-repository.js";

export {
  InMemoryLearningLedgerRepository,
  type LearningLedgerRepository,
} from "./ledger-repository.js";

export {
  InMemoryPrecedentContradictionRepository,
  type PrecedentContradictionRepository,
} from "./contradiction-repository.js";

export {
  InMemoryLearningCoordinator,
  learningFenceKey,
  LearningFenceStatusSchema,
  LearningFenceKeySchema,
  LearningFenceSchema,
  type LearningCoordinator,
  type LearningFence,
  type LearningFenceKey,
  type LearningFenceStatus,
  type BeginLearningResult,
} from "./coordinator.js";

export {
  LearningExtractionService,
  containsAuthorityLikeLanguage,
  eligibleCandidateTypesForOutcome,
  isCandidateTypeEligibleForOutcome,
  type LearningExtractionInput,
} from "./extraction.js";

export {
  type LearningModel,
  type LearningModelInput,
  type LearningModelOutput,
  type LearningModelSuggestion,
  type LearningModelTokenUsage,
  LearningModelSuggestionSchema,
  LearningModelOutputSchema,
  parseLearningModelOutput,
} from "./model.js";

export { FakeLearningModel } from "./fake-model.js";

export {
  InMemoryLearningInferenceLedger,
  LearningInferenceBudget,
  LEARNING_OPERATION_CATEGORY,
  type LearningInferenceLedger,
  type LearningInferenceRecord,
  type LearningOperationCategory,
} from "./inference-ledger.js";

export {
  DEFAULT_PROMOTION_POLICY,
  createPromotionPolicy,
} from "./promotion-policy.js";

export {
  LearningClaimGroundingService,
  type ClaimGroundingInput,
} from "./grounding.js";

export {
  isAutoPromotableGrounding,
  isHumanPromotableGrounding,
  isNeverPromotableGrounding,
  isHumanPromoteBlockedByPartialGrounding,
  isCorroborationEligibleGrounding,
} from "./promotion-grounding.js";

export {
  PrecedentPromotionReadinessService,
  type PromotionReadinessResult,
  type PrecedentPromotionReadinessServiceDeps,
} from "./promotion-readiness.js";

export {
  PrecedentPromotionService,
  type PrecedentPromotionServiceDeps,
  type PromotionAttemptResult,
} from "./promotion.js";

export {
  PrecedentContradictionService,
  type PrecedentContradictionServiceDeps,
} from "./contradiction.js";

export {
  PrecedentCorroborationService,
  type CorroborationStats,
} from "./corroboration.js";

export {
  PrecedentIntegrityService,
  type IntegrityCheckResult,
} from "./integrity.js";

export {
  PrecedentRetriever,
  DEFAULT_RETRIEVAL_BUDGET,
  type PrecedentRetrievalQuery,
  type PrecedentRetrievalBudget,
  type PrecedentRetrievalResult,
} from "./retriever.js";

export {
  GovernedMemoryService,
  type GovernedMemoryServiceDeps,
} from "./service.js";

export {
  LocalPrecedentReviewApplicator,
  PrecedentReviewRequestSchema,
  type PrecedentReviewRequest,
} from "./review.js";
