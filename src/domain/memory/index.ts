export {
  HistoricalOutcomeSchema,
  HistoricalRunRecordSchema,
  LEARNABLE_TERMINAL_RUN_STATES,
  isLearnableTerminalRunState,
  parseHistoricalRunRecord,
  type HistoricalOutcome,
  type HistoricalRunRecord,
  type LearnableTerminalRunState,
} from "./historical-run.js";

export {
  CandidateOriginSchema,
  ClaimGroundingVerdictSchema,
  ClaimPolaritySchema,
  ClaimGroundingResultSchema,
  LearningClaimSchema,
  parseLearningClaim,
  parseClaimGroundingResult,
  claimIdentityKey,
  polarityForCandidateType,
  renderClaimStatement,
  type CandidateOrigin,
  type ClaimGroundingVerdict,
  type ClaimPolarity,
  type ClaimGroundingResult,
  type LearningClaim,
} from "./claim.js";

export {
  LearningCandidateTypeSchema,
  ConfidenceClassSchema,
  LearningCandidateStatusSchema,
  LearningCandidateSchema,
  parseLearningCandidate,
  type LearningCandidateType,
  type ConfidenceClass,
  type LearningCandidateStatus,
  type LearningCandidate,
} from "./candidate.js";

export {
  PrecedentProvenanceSchema,
  parsePrecedentProvenance,
  type PrecedentProvenance,
} from "./provenance.js";

export {
  ScopeClassSchema,
  RiskClassSchema,
  PrecedentApplicabilitySchema,
  parsePrecedentApplicability,
  type ScopeClass,
  type RiskClass,
  type PrecedentApplicability,
} from "./applicability.js";

export {
  PrecedentTrustClassSchema,
  PrecedentStatusSchema,
  PrecedentPromotionMethodSchema,
  PromotedPrecedentSchema,
  parsePromotedPrecedent,
  type PrecedentTrustClass,
  type PrecedentStatus,
  type PrecedentPromotionMethod,
  type PromotedPrecedent,
} from "./precedent.js";

export {
  PrecedentPromotionReadinessStatusSchema,
  PrecedentPromotionPolicySchema,
  PrecedentPromotionDecisionKindSchema,
  PrecedentPromotionDecisionSchema,
  parsePrecedentPromotionPolicy,
  parsePrecedentPromotionDecision,
  type PrecedentPromotionReadinessStatus,
  type PrecedentPromotionPolicy,
  type PrecedentPromotionDecisionKind,
  type PrecedentPromotionDecision,
} from "./promotion.js";

export {
  ContradictionClassificationSchema,
  ContradictionResolutionStatusSchema,
  PrecedentContradictionRecordSchema,
  parsePrecedentContradictionRecord,
  type ContradictionClassification,
  type ContradictionResolutionStatus,
  type PrecedentContradictionRecord,
} from "./contradiction.js";

export {
  PrecedentSupersessionSchema,
  parsePrecedentSupersession,
  type PrecedentSupersession,
} from "./supersession.js";

export {
  MemoryQualityFindingCategorySchema,
  MemoryQualityFindingSeveritySchema,
  MemoryQualityFindingSchema,
  parseMemoryQualityFinding,
  type MemoryQualityFindingCategory,
  type MemoryQualityFindingSeverity,
  type MemoryQualityFinding,
} from "./finding.js";

export {
  RetrievedPrecedentContextSchema,
  GovernedMemoryResultSchema,
  parseRetrievedPrecedentContext,
  parseGovernedMemoryResult,
  type RetrievedPrecedentContext,
  type GovernedMemoryResult,
} from "./result.js";

export {
  LearningLedgerEventTypeSchema,
  LearningLedgerEventSchema,
  parseLearningLedgerEvent,
  type LearningLedgerEventType,
  type LearningLedgerEvent,
} from "./ledger.js";

export {
  PrecedentInvalidationReasonSchema,
  PrecedentInvalidationRecordSchema,
  parsePrecedentInvalidationRecord,
  type PrecedentInvalidationReason,
  type PrecedentInvalidationRecord,
} from "./invalidation.js";
