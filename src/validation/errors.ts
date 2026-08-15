/**
 * Phase 5 validation error codes.
 *
 * Validation failures that are *findings* about a plan are never thrown —
 * they are returned as structured `ValidationFinding` records and adjudicated
 * by `ValidationDecisionEngine`. These errors describe failures of the
 * validation *process* itself (missing authority, fencing, budget, adapters).
 */
export const VALIDATION_ERROR_CODES = [
  "VALIDATION_NOT_READY",
  "VALIDATION_IN_PROGRESS",
  "VALIDATION_CONTEXT_STALE",
  "PLAN_NOT_FOUND",
  "PLAN_NOT_VALIDATABLE",
  "OBJECTIVE_NOT_FOUND",
  "POLICY_BUNDLE_UNAVAILABLE",
  "VALIDATION_MODEL_UNAVAILABLE",
  "VALIDATION_MODEL_TIMEOUT",
  "VALIDATION_MODEL_REFUSED",
  "VALIDATION_MODEL_INVALID_OUTPUT",
  "VALIDATION_MODEL_BUDGET_EXCEEDED",
  "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION",
  "VALIDATION_DECISION_PERSISTENCE_FAILED",
  "VALIDATION_RECONCILIATION_FAILED",
  "INVALID_VALIDATION_STATE",
  "REVISION_NOT_PERMITTED",
  "REVISION_LIMIT_EXCEEDED",
  "REVISION_BUDGET_EXCEEDED",
  "REVISION_MODEL_INVALID_OUTPUT",
  "REVISION_COMPILATION_FAILED",
  "REVISION_PERSISTENCE_FAILED",
] as const;

export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[number];

export class ValidationError extends Error {
  readonly code: ValidationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ValidationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ValidationError";
    this.code = code;
    this.details = details;
  }
}

export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Raised when a validation model call fails before provider dispatch.
 * Releases the token reservation without charging it.
 */
export class ValidationPreDispatchError extends Error {
  readonly preDispatch = true as const;

  constructor(message: string) {
    super(message);
    this.name = "ValidationPreDispatchError";
  }
}

export function isValidationPreDispatchError(
  error: unknown,
): error is ValidationPreDispatchError {
  return (
    error instanceof ValidationPreDispatchError ||
    (typeof error === "object" &&
      error !== null &&
      "preDispatch" in error &&
      (error as { preDispatch: unknown }).preDispatch === true)
  );
}
