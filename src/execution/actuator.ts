import type {
  CreateLocalPatchArgs,
  CreateTaskArgs,
  CreateCallbackTaskArgs,
  PreparePullRequestArgs,
  RunTestsArgs,
  SendRecoveryEmailArgs,
  SendRecoverySmsArgs,
} from "./action-schemas.js";
import type { StepExecutionResult } from "../domain/execution/index.js";

export interface LocalPatchActuatorResult {
  artifactRelativePath: string;
  contentHash: string;
  size: number;
  affectedPaths: readonly string[];
}

export interface RegisteredTestActuatorResult {
  testProfileId: string;
  argv: readonly string[];
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  timedOut?: boolean;
  artifactRelativePath?: string;
  contentHash?: string;
}

export interface LocalTaskActuatorResult {
  taskId: string;
  title: string;
  description: string;
  status: "CREATED";
  artifactRelativePath: string;
  contentHash: string;
}

export interface PullRequestPreparationResult {
  artifactRelativePath: string;
  contentHash: string;
  size: number;
  title: string;
  baseBranch: string;
  proposedHeadBranchName: string;
  githubWritePerformed: false;
}

export interface RecoveryOutreachActuatorResult {
  artifactRelativePath: string;
  contentHash: string;
  size: number;
  attemptId: string;
  channel: "SMS" | "EMAIL" | "CALL_TASK";
  deliveryOutcome: "SENT" | "FAILED" | "SIMULATED";
  providerMessageId?: string;
  replayed: boolean;
}

export interface ActuatorRuntimeBounds {
  /** Strictest allowed runtime for this invocation (ms). */
  timeoutMs: number;
}

/**
 * Narrow safe actuator port. No generic execute/shell/http.
 * Domain/application depends only on these explicit operations.
 */
export interface SafeActuator {
  createLocalPatch(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    workspaceRoot: string;
    artifactRoot: string;
    args: CreateLocalPatchArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<LocalPatchActuatorResult>;

  runRegisteredTestProfile(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    workspaceRoot: string;
    artifactRoot: string;
    args: RunTestsArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RegisteredTestActuatorResult>;

  createLocalTask(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    planId: string;
    artifactRoot: string;
    args: CreateTaskArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<LocalTaskActuatorResult>;

  preparePullRequestArtifact(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    artifactRoot: string;
    args: PreparePullRequestArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<PullRequestPreparationResult>;

  sendRecoverySms(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    args: SendRecoverySmsArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult>;

  sendRecoveryEmail(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    args: SendRecoveryEmailArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult>;

  createRecoveryCallbackTask(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    stepIdempotencyKey: string;
    artifactRoot: string;
    args: CreateCallbackTaskArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RecoveryOutreachActuatorResult>;

  /**
   * Optional actuator-specific reconciliation after crash while RUNNING.
   * Return proven completion evidence or null if unprovable.
   */
  reconcileRunningStep?(input: {
    idempotencyKey: string;
    stepId: string;
    actionType: string;
    runId: string;
    executionAttemptId: string;
  }): Promise<StepExecutionResult | null>;
}
