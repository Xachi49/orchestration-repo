export { PROGRAM_STATES, ProgramStateSchema, canTransitionProgram, DISCOVERABLE_PROGRAM_STATES, isTerminalProgramState, type ProgramState } from "./program-state.js";
export {
  DelegationEnvelopeSchema,
  parseDelegationEnvelope,
  delegationEnvelopeHash,
  defaultDelegationEnvelope,
  type DelegationEnvelope,
} from "./delegation-envelope.js";
export {
  ProgramAuthorityFreezeSchema,
  intersectChildAuthority,
  childWeakensConstraints,
  type ProgramAuthorityFreeze,
} from "./authority.js";
export {
  ProgramSchema,
  ProgramRootIntentSchema,
  parseProgram,
  INITIAL_PROGRAM_VERSION,
  type Program,
  type ProgramRootIntent,
} from "./program.js";
export {
  ProgramPlanSchema,
  parseProgramPlan,
  programPlanHash,
  programNodeId,
  INITIAL_PROGRAM_PLAN_VERSION,
  PROGRAM_PLAN_COMPILER_VERSION,
  type ProgramPlan,
  type ChildProgramNode,
  type ProgramPlanEdge,
  type ProgramCriterionContributionBinding,
} from "./program-plan.js";
export {
  emptyBudgetEstimate,
  availableToReserve,
  canReserve,
  exceedsCeiling,
  sumNodeBudgets,
  addBudget,
  reservationIdFor,
  budgetAllocationFingerprint,
  BUDGET_RELEASE_CATEGORIES,
  type ProgramBudgetLedger,
  type ProgramBudgetReservation,
} from "./budget.js";
export { ProgramError, isProgramError, PROGRAM_ERROR_CODES, type ProgramErrorCode } from "./errors.js";
export {
  validateProgramPlan,
  assertValidProgramPlan,
  PROGRAM_VALIDATION_STEPS,
  type ProgramValidationResult,
  type ProgramValidationFinding,
} from "./validator.js";
export {
  FakeProgramDecompositionModel,
  parseDecompositionProposal,
  decompositionProposalHash,
  type ProgramDecompositionModel,
  type DecompositionProposal,
} from "./decomposition-model.js";
export {
  programIdempotencyKey,
  programContentFingerprint,
  childObjectiveIdentity,
} from "./identity.js";
export {
  ProgramLineageRecordSchema,
  ProgramMaterializationApprovalSchema,
  ProgramCompletionRecordSchema,
  PROGRAM_OUTCOME_CLASSES,
  lineageIdFor,
  type ProgramLineageRecord,
  type ProgramMaterializationApproval,
  type ProgramCompletionRecord,
  type ProgramOutcomeClass,
} from "./lineage.js";
export { compileProgramPlan } from "./compiler.js";
export {
  ProgramOrchestrationService,
  type ProgramAdmissionRequest,
  type ProgramAdmissionOutcome,
  type ProgramServiceDeps,
  type ProgramCompletionFailpoint,
  type ProgramCompletionFailpointStage,
  type ProgramMaterializationFailpoint,
} from "./service.js";
export type {
  ProgramRepository,
  ProgramPlanRepository,
  ProgramBudgetLedgerRepository,
  ProgramBudgetReservationRepository,
  ProgramLineageRepository,
  ProgramMaterializationApprovalRepository,
  ProgramCompletionRepository,
} from "./repositories.js";
export {
  InMemoryProgramRepository,
  InMemoryProgramPlanRepository,
  InMemoryProgramBudgetLedgerRepository,
  InMemoryProgramBudgetReservationRepository,
  InMemoryProgramLineageRepository,
  InMemoryProgramMaterializationApprovalRepository,
  InMemoryProgramCompletionRepository,
} from "./memory-repositories.js";
export { ProgramWorkMaterializer } from "./work-materializer.js";
export { proveRootCriterion } from "./criterion-proof.js";
export { ProgramProgressionLoop } from "./loops.js";
