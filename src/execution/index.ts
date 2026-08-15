/**
 * Executor authority boundary.
 * May execute only previously authorized actions.
 * Cannot create plans or approvals.
 * Phase 7: bounded SafeActuator execution only.
 */
export interface ExecutorPort {
  readonly authority: "EXECUTE_AUTHORIZED_ONLY";
}

export const EXECUTOR_AUTHORITY = {
  mayExecuteAuthorizedActions: true,
  mayCreatePlans: false,
  mayCreateApprovals: false,
} as const;

export {
  EXECUTION_ERROR_CODES,
  ExecutionError,
  isExecutionError,
  type ExecutionErrorCode,
} from "./errors.js";

export {
  ExecutionReadinessService,
  ExecutionReadinessCodeSchema,
  type ExecutionReadinessCode,
  type ExecutionReadinessResult,
  type ExecutionReadinessServiceDeps,
} from "./readiness.js";

export {
  ExecutionPreflightService,
  type ExecutionPreflightServiceDeps,
} from "./preflight.js";

export {
  InMemoryExecutionCoordinator,
  executionFenceKey,
  ExecutionFenceStatusSchema,
  ExecutionFenceKeySchema,
  ExecutionFenceSchema,
  type ExecutionCoordinator,
  type ExecutionFence,
  type ExecutionFenceKey,
  type ExecutionFenceStatus,
  type BeginExecutionResult,
} from "./coordinator.js";

export {
  DryRunCompiler,
  CompiledExecutionStepSchema,
  type CompiledExecutionStep,
} from "./dry-run.js";

export {
  PHASE7_ACTION_TYPES,
  PHASE7_ACTION_TYPE_SET,
  CapabilityExecutionSchemaMap,
  CreateLocalPatchArgsSchema,
  RunTestsArgsSchema,
  CreateTaskArgsSchema,
  PreparePullRequestArgsSchema,
  isPhase7ActionType,
  type Phase7ActionType,
  type CreateLocalPatchArgs,
  type RunTestsArgs,
  type CreateTaskArgs,
  type PreparePullRequestArgs,
} from "./action-schemas.js";

export { ExecutionTargetValidator } from "./target-validator.js";

export {
  stepIdempotencyKey,
  rollbackIdempotencyKey,
  fingerprintValue,
} from "./idempotency.js";

export {
  InMemoryStepExecutionRepository,
  type StepExecutionRepository,
} from "./step-repository.js";

export {
  ExecutionPreconditionService,
  type ExecutionPreconditionServiceDeps,
} from "./precondition.js";

export {
  ExecutionResourceLedger,
  type ExecutionResourceUsage,
} from "./resource-ledger.js";

export {
  capabilitySetFingerprint,
  uniqueCapabilitiesForPlanActions,
  type CapabilityAuthorityFields,
} from "./capability-fingerprint.js";

export {
  type SafeActuator,
  type LocalPatchActuatorResult,
  type RegisteredTestActuatorResult,
  type LocalTaskActuatorResult,
  type PullRequestPreparationResult,
} from "./actuator.js";

export {
  TestProfileRegistry,
  TestProfileIdSchema,
  type TestProfileId,
  type RegisteredTestProfile,
} from "./test-profiles.js";

export {
  InMemoryExecutionArtifactRepository,
  type ExecutionArtifactRepository,
} from "./artifact-repository.js";

export { RollbackService } from "./rollback.js";

export { buildContainmentResult } from "./containment.js";

export { ExecutionService, type ExecutionServiceDeps } from "./service.js";

export {
  SequenceExecutionIdentityGenerator,
  type ExecutionIdentityGenerator,
} from "./identity.js";

export {
  InMemoryExecutionAttemptRepository,
  type ExecutionAttemptRepository,
} from "./attempt-repository.js";

export { artifactRootFor } from "./paths.js";

export { createExecutionFriendlyPlanningModel } from "./friendly-planning-model.js";
