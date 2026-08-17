/**
 * Phase 9 governed memory process errors.
 * Learning quality / promotion eligibility use findings + readiness statuses,
 * not thrown errors (except process failures).
 */
export const MEMORY_ERROR_CODES = [
  "LEARNING_NOT_READY",
  "LEARNING_IN_PROGRESS",
  "LEARNING_ALREADY_PROCESSED",
  "LEARNING_RUN_NOT_TERMINAL",
  "LEARNING_OUTCOME_MISSING",
  "LEARNING_FENCE_FAILED",
  "INVALID_LEARNING_STATE",
  "HISTORICAL_RUN_CONFLICT",
  "CANDIDATE_NOT_FOUND",
  "PRECEDENT_NOT_FOUND",
  "PROMOTION_NOT_ELIGIBLE",
  "PROMOTION_GROUNDING_INSUFFICIENT",
  "PROMOTION_PROVENANCE_INVALID",
  "PROMOTION_CONTRADICTED",
  "PRECEDENT_INTEGRITY_FAILED",
  "LEARNING_RESOURCE_BUDGET_EXCEEDED",
  "LEARNING_MODEL_INVALID_OUTPUT",
  "LEARNING_PERSISTENCE_FAILED",
  "INVALID_PROMOTION_DECISION",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryError extends Error {
  readonly code: MemoryErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MemoryErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "MemoryError";
    this.code = code;
    this.details = details;
  }
}

export function isMemoryError(error: unknown): error is MemoryError {
  return error instanceof MemoryError;
}

export class LearningPreDispatchError extends Error {
  readonly preDispatch = true as const;

  constructor(message: string) {
    super(message);
    this.name = "LearningPreDispatchError";
  }
}

export function isLearningPreDispatchError(
  error: unknown,
): error is LearningPreDispatchError {
  return (
    error instanceof LearningPreDispatchError ||
    (typeof error === "object" &&
      error !== null &&
      "preDispatch" in error &&
      (error as { preDispatch: unknown }).preDispatch === true)
  );
}
