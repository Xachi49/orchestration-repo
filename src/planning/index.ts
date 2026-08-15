/**
 * Planner authority boundary.
 * May propose actions. Cannot authorize or execute.
 */
export type { PlannerPort } from "./port.js";
export { PLANNER_AUTHORITY } from "./port.js";

export {
  PLANNING_ERROR_CODES,
  PlanningError,
  isPlanningError,
  type PlanningErrorCode,
} from "./errors.js";

export {
  PlanningReadinessService,
  PlanningReadinessCodeSchema,
  type PlanningReadinessCode,
  type PlanningReadinessResult,
  type PlanningReadinessServiceDeps,
} from "./readiness.js";

export {
  PlanningFenceStatusSchema,
  PlanningFenceSchema,
  InMemoryPlanningCoordinator,
  type PlanningFenceStatus,
  type PlanningFence,
  type BeginPlanningResult,
  type PlanningCoordinator,
} from "./coordinator.js";

export {
  PlanningEvidenceExcerptSchema,
  PlanningContextSchema,
  CONTEXT_COMPILER_VERSION,
  PLANNING_PROMPT_VERSION,
  type PlanningEvidenceExcerpt,
  type PlanningContext,
  type CompiledPlanningContext,
} from "./context.js";

export {
  ContextBudgetController,
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudgetConfig,
  type ContextBudgetControllerInput,
} from "./budget-controller.js";

export {
  GapAnalysisSchema,
  PlanProposalSchema,
  ProposedStepSchema,
  parsePlanProposal,
  type GapAnalysis,
  type PlanProposal,
  type ProposedStep,
} from "./proposal.js";

export type {
  PlanningModel,
  PlanningModelOutput,
  PlanningModelTokenUsage,
  PlanningModelUsage,
  PlanningModelOperation,
  PlanningModelUsageStatus,
  PlanningUsageAggregate,
  PlanningUsageLedger,
  PlanningTokenReservationRequest,
  PlanningUsageSettle,
} from "./model.js";
export {
  InMemoryPlanningUsageLedger,
  aggregatePlanningUsage,
  resolveChargedTokenTotal,
  PlanningPreDispatchError,
  isPlanningPreDispatchError,
} from "./model.js";

export { PlanningInferenceBudget } from "./inference-budget.js";
export {
  DEFAULT_PLANNING_MAX_OUTPUT_TOKENS,
  ByteLengthPlanningTokenEstimator,
  FixedPlanningTokenEstimator,
  computeTokenReservation,
  type PlanningMaxOutputTokensByOperation,
  type PlanningTokenReservationEstimator,
} from "./token-reservation.js";

export { FakePlanningModel } from "./fake-planning-model.js";
export { EvidenceReferenceValidator } from "./evidence-ref-validator.js";
export { CapabilityReferenceValidator } from "./capability-ref-validator.js";
export { DependencyGraphService } from "./dependency-graph.js";
export { PlanResourceAnalyzer } from "./resource-analyzer.js";
export {
  PlanQualityScorer,
  DEFAULT_QUALITY_CONFIG,
  type PlanQualityScore,
} from "./quality-scorer.js";
export {
  PlanCompiler,
  SequencePlanIdentityGenerator,
  type PlanIdentityGenerator,
} from "./plan-compiler.js";
export { PlanningPromptAssembler } from "./prompt-assembler.js";
export {
  StoredPlanStatusSchema,
  StoredPlanRecordSchema,
  InMemoryPlanRepository,
  type StoredPlanStatus,
  type StoredPlanRecord,
  type PlanRepository,
} from "./plan-repository.js";
export {
  PlanningService,
  type PlanningServiceDeps,
  type PlanningResult,
} from "./service.js";
