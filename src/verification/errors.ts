/**
 * Phase 8 verification process errors.
 * Criterion/outcome failures are findings + OutcomeDecisionEngine verdicts,
 * not thrown errors (except process failures: readiness, fencing, persistence).
 */
export const VERIFICATION_ERROR_CODES = [
  "VERIFICATION_NOT_READY",
  "VERIFICATION_IN_PROGRESS",
  "VERIFICATION_EXECUTION_RESULT_MISSING",
  "VERIFICATION_BINDING_MISMATCH",
  "VERIFICATION_AUTHORITY_MISMATCH",
  "VERIFICATION_STEP_STATE_UNKNOWN",
  "VERIFICATION_ARTIFACT_MISSING",
  "VERIFICATION_ARTIFACT_HASH_MISMATCH",
  "VERIFICATION_ARTIFACT_IDENTITY_MISMATCH",
  "VERIFICATION_EVIDENCE_MISSING",
  "VERIFICATION_EVIDENCE_CONFLICT",
  "VERIFICATION_CRITERION_UNMAPPED",
  "VERIFICATION_POSTCONDITION_FAILED",
  "VERIFICATION_SCOPE_VIOLATION",
  "VERIFICATION_GOVERNANCE_VIOLATION",
  "VERIFICATION_MODEL_UNAVAILABLE",
  "VERIFICATION_MODEL_TIMEOUT",
  "VERIFICATION_MODEL_INVALID_OUTPUT",
  "VERIFICATION_RESOURCE_BUDGET_EXCEEDED",
  "VERIFICATION_PERSISTENCE_FAILED",
  "COMPLETION_NOT_AUTHORIZED",
  "COMPLETION_RECORD_CONFLICT",
  "VERIFICATION_FENCE_FAILED",
  "VERIFICATION_ALREADY_DECIDED",
  "INVALID_VERIFICATION_STATE",
] as const;

export type VerificationErrorCode = (typeof VERIFICATION_ERROR_CODES)[number];

export class VerificationError extends Error {
  readonly code: VerificationErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: VerificationErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "VerificationError";
    this.code = code;
    this.details = details;
  }
}

export function isVerificationError(
  error: unknown,
): error is VerificationError {
  return error instanceof VerificationError;
}

/**
 * Raised when a verification model call fails before provider dispatch.
 * Releases the token reservation without charging it.
 */
export class VerificationPreDispatchError extends Error {
  readonly preDispatch = true as const;

  constructor(message: string) {
    super(message);
    this.name = "VerificationPreDispatchError";
  }
}

export function isVerificationPreDispatchError(
  error: unknown,
): error is VerificationPreDispatchError {
  return (
    error instanceof VerificationPreDispatchError ||
    (typeof error === "object" &&
      error !== null &&
      "preDispatch" in error &&
      (error as { preDispatch: unknown }).preDispatch === true)
  );
}
