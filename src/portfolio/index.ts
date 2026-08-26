export {
  PORTFOLIO_STATES,
  PortfolioStateSchema,
  canTransitionPortfolio,
  DISCOVERABLE_PORTFOLIO_STATES,
  isTerminalPortfolioState,
  TERMINAL_PORTFOLIO_STATES,
  type PortfolioState,
} from "./portfolio-state.js";
export {
  PortfolioAuthorizationEnvelopeSchema,
  parsePortfolioAuthorizationEnvelope,
  portfolioAuthorizationEnvelopeHash,
  defaultPortfolioEnvelope,
  ConcentrationBasisSchema,
  type PortfolioAuthorizationEnvelope,
  type ConcentrationBasis,
} from "./authorization-envelope.js";
export {
  PortfolioSchema,
  parsePortfolio,
  INITIAL_PORTFOLIO_VERSION,
  portfolioContentFingerprint,
  portfolioIdempotencyKey,
  environmentScopeFingerprint,
  type Portfolio,
  type PortfolioAuthorityFreeze,
} from "./portfolio.js";
export {
  PortfolioIntentSchema,
  parsePortfolioIntent,
  portfolioIntentHash,
  mintPortfolioId,
  type PortfolioIntent,
} from "./intent.js";
export {
  PortfolioGoalSchema,
  PortfolioGoalStatusSchema,
  parsePortfolioGoals,
  validatePortfolioGoals,
  portfolioGoalsHash,
  assertWeightsAreMetadataOnly,
  type PortfolioGoal,
  type PortfolioGoalStatus,
} from "./goals.js";
export {
  PortfolioPlanSchema,
  INITIAL_PORTFOLIO_PLAN_VERSION,
  PORTFOLIO_PLAN_COMPILER_VERSION,
  withPortfolioPlanHash,
  computePortfolioPlanHash,
  mintProgramIdFromPortfolioProposal,
  PortfolioProgramDispositionSchema,
  type PortfolioPlan,
  type PortfolioProgramProposal,
  type PortfolioProgramReference,
  type PortfolioProgramDisposition,
  type PortfolioGoalContributionBinding,
} from "./plan.js";
export {
  emptyBudgetEstimate,
  portfolioAvailableToReserve,
  canReserve,
  exceedsCeiling,
  sumAllocations,
  reservationIdFor,
  portfolioAllocationFingerprint,
  PortfolioBudgetLedgerSchema,
  PortfolioBudgetReservationSchema,
  type PortfolioBudgetLedger,
  type PortfolioBudgetReservation,
} from "./budget.js";
export { PortfolioError, isPortfolioError, PORTFOLIO_ERROR_CODES, type PortfolioErrorCode } from "./errors.js";
export {
  validatePortfolioPlan,
  assertValidPortfolioPlan,
  PORTFOLIO_VALIDATION_STEPS,
  type PortfolioValidationResult,
  type PortfolioValidationFinding,
  type PortfolioValidationOutcome,
} from "./validator.js";
export {
  FakePortfolioStrategyModel,
  PortfolioStrategyProposalSchema,
  StrategyRecommendationSchema,
  type PortfolioStrategyModel,
  type PortfolioStrategyProposal,
  type StrategyRecommendation,
} from "./strategy-model.js";
export {
  PortfolioAnalysisContextSchema,
  LabeledEvidenceSchema,
  labelEvidence,
  PORTFOLIO_EVIDENCE_AUTHORITY_CLASSES,
  type PortfolioAnalysisContext,
  type LabeledEvidence,
  type PortfolioEvidenceAuthorityClass,
} from "./analysis-context.js";
export {
  PortfolioProgramLineageSchema,
  PortfolioAuthorizationRequestSchema,
  PortfolioAuthorizationRecordSchema,
  PortfolioCompletionRecordSchema,
  PortfolioRebalanceProposalSchema,
  PortfolioProgressSchema,
  PORTFOLIO_OUTCOME_CLASSES,
  portfolioLineageIdFor,
  computeAuthorizationSubjectHash,
  type PortfolioProgramLineage,
  type PortfolioAuthorizationRequest,
  type PortfolioAuthorizationRecord,
  type PortfolioAuthorizationDecision,
  type PortfolioCompletionRecord,
  type PortfolioRebalanceProposal,
  type PortfolioProgress,
  type PortfolioOutcomeClass,
} from "./lineage.js";
export {
  compilePortfolioPlan,
  computeConcentrationScore,
  evaluateConcentration,
  type ConcentrationEvaluation,
} from "./compiler.js";
export { provePortfolioGoal, type GoalProofResult } from "./goal-proof.js";
export {
  PortfolioOrchestrationService,
  PORTFOLIO_AUTHORITY_BOUNDARIES,
  assertPortfolioAuthoritySeparation,
  assertPortfolioApprovalIsDistinctFromProgramMaterialization,
  assertPortfolioApprovalIsDistinctFromPhase6Execution,
  type PortfolioAdmissionRequest,
  type PortfolioAdmissionOutcome,
  type PortfolioServiceDeps,
  type PortfolioCompletionFailpoint,
  type PortfolioCompletionFailpointStage,
  type PortfolioMaterializationFailpoint,
} from "./service.js";
export type {
  PortfolioRepository,
  PortfolioPlanRepository,
  PortfolioBudgetLedgerRepository,
  PortfolioBudgetReservationRepository,
  PortfolioProgramLineageRepository,
  PortfolioAuthorizationRequestRepository,
  PortfolioAuthorizationRecordRepository,
  PortfolioCompletionRepository,
  PortfolioRebalanceRepository,
} from "./repositories.js";
export {
  InMemoryPortfolioRepository,
  InMemoryPortfolioPlanRepository,
  InMemoryPortfolioBudgetLedgerRepository,
  InMemoryPortfolioBudgetReservationRepository,
  InMemoryPortfolioProgramLineageRepository,
  InMemoryPortfolioAuthorizationRequestRepository,
  InMemoryPortfolioAuthorizationRecordRepository,
  InMemoryPortfolioCompletionRepository,
  InMemoryPortfolioRebalanceRepository,
} from "./memory-repositories.js";
export { PortfolioProgressionLoop } from "./loops.js";
export {
  classifyPortfolioRecovery,
  PORTFOLIO_RECOVERY_CLASSES,
  type PortfolioRecoveryClass,
} from "./recovery.js";
export { PortfolioWorkMaterializer } from "./work-materializer.js";
