export {
  EXPERIMENT_STATES,
  TERMINAL_EXPERIMENT_STATES,
  DISCOVERABLE_EXPERIMENT_STATES,
  EXPERIMENT_TRANSITIONS,
  canTransitionExperiment,
  isTerminalExperimentState,
  type ExperimentState,
  type TerminalExperimentState,
} from "./experiment-state.js";
export {
  ExperimentStateSchema,
} from "./experiment-state-schema.js";
export {
  ExperimentError,
  isExperimentError,
  EXPERIMENT_ERROR_CODES,
  type ExperimentErrorCode,
} from "./errors.js";
export {
  EXPERIMENT_DOCTRINE,
  EXPERIMENT_EVIDENCE_QUALITY,
  ExperimentEvidenceQualitySchema,
  HYPOTHESIS_OUTCOMES,
  HypothesisOutcomeSchema,
  EXPERIMENT_FAILURE_REASONS,
  ExperimentFailureReasonSchema,
  type ExperimentEvidenceQuality,
  type HypothesisOutcome,
  type ExperimentFailureReason,
} from "./doctrine.js";
export {
  QUANTITY_UNITS,
  QuantityUnitSchema,
  ExperimentHypothesisSchema,
  ExperimentMeasurementSchema,
  assertCompatibleUnits,
  validateHypothesisMeasurability,
  type QuantityUnit,
  type ExperimentHypothesis,
  type ExperimentMeasurement,
} from "./hypothesis.js";
export {
  INITIAL_EXPERIMENT_VERSION,
  ExperimentAssumptionBindingSchema,
  ExperimentBudgetEnvelopeSchema,
  GovernedExperimentSchema,
  parseGovernedExperiment,
  assertExperimentTransition,
  experimentContentFingerprint,
  experimentIdempotencyKey,
  mintExperimentId,
  type ExperimentAssumptionBinding,
  type ExperimentBudgetEnvelope,
  type GovernedExperiment,
} from "./experiment.js";
export {
  INITIAL_EXPERIMENT_PLAN_VERSION,
  ExperimentStoppingRuleSchema,
  ExperimentPlanSchema,
  experimentPlanCanonicalPayload,
  computeExperimentPlanHash,
  withExperimentPlanHash,
  type ExperimentStoppingRule,
  type ExperimentPlan,
} from "./plan.js";
export {
  QualitativeClassSchema,
  ValueOfInformationResultSchema,
  ActiveLearningCandidateSchema,
  analyzeValueOfInformation,
  rankActiveLearningCandidates,
  type QualitativeClass,
  type ValueOfInformationResult,
  type ActiveLearningCandidate,
} from "./voi.js";
export {
  EXPERIMENT_SPONSOR_AUTHORITY_BOUNDARIES,
  ExperimentAuthorizationDecisionSchema,
  ExperimentAuthorizationRequestSchema,
  ExperimentAuthorizationRecordSchema,
  computeExperimentAuthSubjectHash,
  mintExperimentAuthorizationId,
  mintExperimentAuthorizationRecordId,
  budgetFingerprint,
  assertExperimentAuthorizationDoesNotExecute,
  assertExperimentSponsorDistinctFromApprover,
  assertExperimentSponsorDistinctFromStrategySelector,
  type ExperimentAuthorizationDecision,
  type ExperimentAuthorizationRequest,
  type ExperimentAuthorizationRecord,
} from "./authorization.js";
export {
  ExperimentDesignProposalSchema,
  FakeExperimentDesignModel,
  fakeAssumptionBindingsFor,
  type ExperimentDesignProposal,
  type ExperimentDesignModel,
} from "./design-model.js";
export {
  MeasurementResultSchema,
  HypothesisResultSchema,
  ExperimentResultSchema,
  ExperimentEvidenceBundleSchema,
  AssumptionEvidenceUpdateCandidateSchema,
  AssumptionRevisionKindSchema,
  ExperimentCompletionRecordSchema,
  ExperimentExecutionLineageSchema,
  computeEvidenceBundleHash,
  withEvidenceBundleHash,
  mintExperimentResultId,
  mintEvidenceBundleId,
  mintAssumptionUpdateCandidateId,
  mintCompletionRecordId,
  mintExecutionLineageId,
  type MeasurementResult,
  type HypothesisResult,
  type ExperimentResult,
  type ExperimentEvidenceBundle,
  type AssumptionEvidenceUpdateCandidate,
  type ExperimentCompletionRecord,
  type ExperimentExecutionLineage,
} from "./evidence.js";
export {
  resolveHypothesisOutcomes,
  assertAssumptionBindingMatches,
  selectAssumptionRevisionKind,
  buildAssumptionUpdateCandidate,
  computeAssumptionUpdateCandidateHash,
  withCandidateHash,
  type AssumptionRevisionKind,
} from "./assumption-candidates.js";
export {
  compileExperimentToObjective,
  type CompiledExperimentObjective,
} from "./execution-compiler.js";
export {
  Phase2ExperimentObjectiveAdmissionPort,
  FakeExperimentObjectiveAdmissionPort,
  mintExperimentObjectiveIdentity,
  type ExperimentObjectiveAdmissionPort,
  type ExperimentObjectiveAdmissionRequest,
  type ExperimentObjectiveAdmissionOutcome,
} from "./objective-admission-port.js";
export {
  Phase8ExperimentOutcomeVerificationPort,
  FakeExperimentOutcomeVerificationPort,
  deriveEvidenceQualityFromVerdict,
  resolveBoundPhase8Verifications,
  phase8AllowsConclusiveHypothesis,
  worstAuthoritativeQuality,
  type ExperimentOutcomeVerificationPort,
  type BoundPhase8Verification,
} from "./outcome-verification-port.js";
export {
  reserveExperimentUsage,
  applyUsageDelta,
  assertWithinBudget,
  sampleCountDelta,
  type ExperimentUsageDelta,
} from "./budget-ledger.js";
export {
  validateExperimentPlan,
  assertValidExperimentPlan,
  EXPERIMENT_VALIDATION_STEPS,
  type ExperimentValidationStep,
  type ExperimentValidationOutcome,
  type ExperimentValidationFinding,
  type ExperimentValidationResult,
} from "./validator.js";
export type {
  ExperimentUsageLedger,
  ExperimentRepository,
  ExperimentPlanRepository,
  ExperimentAuthorizationRequestRepository,
  ExperimentAuthorizationRecordRepository,
  ExperimentResultRepository,
  ExperimentEvidenceBundleRepository,
  AssumptionEvidenceUpdateCandidateRepository,
  ExperimentCompletionRecordRepository,
  ExperimentExecutionLineageRepository,
  ExperimentUsageLedgerRepository,
} from "./repositories.js";
export { hydrateExperimentUsageLedger } from "./repositories.js";
export {
  InMemoryExperimentRepository,
  InMemoryExperimentPlanRepository,
  InMemoryExperimentAuthorizationRequestRepository,
  InMemoryExperimentAuthorizationRecordRepository,
  InMemoryExperimentResultRepository,
  InMemoryExperimentEvidenceBundleRepository,
  InMemoryAssumptionEvidenceUpdateCandidateRepository,
  InMemoryExperimentCompletionRecordRepository,
  InMemoryExperimentExecutionLineageRepository,
  InMemoryExperimentUsageLedgerRepository,
} from "./memory-repositories.js";
export {
  ExperimentOrchestrationService,
  EXPERIMENT_AUTHORITY_BOUNDARIES,
  assertExperimentAuthoritySeparation,
  type ExperimentAdmissionRequest,
  type ExperimentAdmissionOutcome,
  type ExperimentOrchestrationServiceDeps,
  type ExperimentCompletionFailpoint,
  type ExperimentCompileFailpoint,
} from "./service.js";
export { ExperimentProgressionLoop } from "./loops.js";
export { ExperimentWorkMaterializer } from "./work-materializer.js";
