export const CAUSAL_ERROR_CODES = [
  "CAUSAL_QUESTION_NOT_FOUND",
  "CAUSAL_QUESTION_VERSION_CONFLICT",
  "CAUSAL_STATE_CONFLICT",
  "CAUSAL_CAS_CONFLICT",
  "INVALID_CAUSAL_TRANSITION",
  "CAUSAL_GRAPH_INVALID",
  "CAUSAL_GRAPH_CYCLE_UNSUPPORTED",
  "CAUSAL_VARIABLE_INVALID",
  "UNIT_MIXING_REJECTED",
  "CAUSAL_EVIDENCE_INVALID",
  "IDENTIFICATION_NOT_SUPPORTED",
  "NOT_IDENTIFIED",
  "UNSUPPORTED_ESTIMATOR",
  "INCOMPARABLE_EFFECTS",
  "CAUSAL_CLAIM_INVALID",
  "CAUSAL_VALIDATION_FAILED",
  "CAUSAL_REVIEW_REQUIRED",
  "CAUSAL_REVIEW_INVALID",
  "CAUSAL_REVIEW_EXPIRED",
  "CAUSAL_REVIEWER_SCOPE_INSUFFICIENT",
  "CAUSAL_PROMOTION_REJECTED",
  "CAUSAL_CLAIM_STALE",
  "CAUSAL_BUDGET_EXCEEDED",
  "PACKAGE_STALE",
  "DATABASE_UNAVAILABLE",
] as const;

export type CausalErrorCode = (typeof CAUSAL_ERROR_CODES)[number];

export class CausalError extends Error {
  readonly code: CausalErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: CausalErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CausalError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isCausalError(error: unknown): error is CausalError {
  return error instanceof CausalError;
}
