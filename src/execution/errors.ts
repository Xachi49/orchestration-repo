export const EXECUTION_ERROR_CODES = [
  "EXECUTION_NOT_READY",
  "EXECUTION_IN_PROGRESS",
  "EXECUTION_BINDING_STALE",
  "EXECUTION_REPOSITORY_STALE",
  "EXECUTION_POLICY_CHANGED",
  "EXECUTION_CAPABILITY_CHANGED",
  "EXECUTION_MODE_DENIED",
  "EXECUTION_TARGET_INVALID",
  "EXECUTION_TARGET_PROTECTED",
  "EXECUTION_ARGUMENT_INVALID",
  "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
  "STEP_EXECUTION_IN_PROGRESS",
  "STEP_EXECUTION_FAILED",
  "STEP_EXECUTION_STATE_UNKNOWN",
  "EXECUTION_IDEMPOTENCY_CONFLICT",
  "ROLLBACK_NOT_AUTHORIZED",
  "ROLLBACK_LIMIT_EXCEEDED",
  "ROLLBACK_FAILED",
  "EXECUTION_CONTAINED",
  "EXECUTION_ARTIFACT_FAILED",
  "EXECUTION_UNSUPPORTED_ACTION",
  "EXECUTION_PRECONDITION_FAILED",
  "EXECUTION_FENCE_FAILED",
  "EXECUTION_NOT_FOUND",
  "EXECUTION_ALREADY_COMPLETED",
  "EXECUTION_TARGET_MISSING",
  "EXECUTION_CONFLICT",
  "EXECUTION_DRY_RUN_FAILED",
] as const;

export type ExecutionErrorCode = (typeof EXECUTION_ERROR_CODES)[number];

export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ExecutionErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isExecutionError(error: unknown): error is ExecutionError {
  return error instanceof ExecutionError;
}
