export const PLANNING_ERROR_CODES = [
  "PLANNING_NOT_READY",
  "REPOSITORY_CONTEXT_STALE",
  "PLANNING_IN_PROGRESS",
  "PLANNING_MODEL_UNAVAILABLE",
  "PLANNING_MODEL_TIMEOUT",
  "PLANNING_MODEL_REFUSED",
  "PLANNING_MODEL_INVALID_OUTPUT",
  "PLANNING_MODEL_BUDGET_EXCEEDED",
  "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
  "PLANNING_CONTEXT_BUDGET_EXCEEDED",
  "INVALID_EVIDENCE_REFERENCE",
  "INVALID_CAPABILITY_REFERENCE",
  "PLAN_DEPENDENCY_CYCLE",
  "PLAN_DEPENDENCY_MISSING",
  "PLAN_RESOURCE_BUDGET_EXCEEDED",
  "PLAN_RESOURCE_UNESTIMATED",
  "PLAN_QUALITY_BELOW_THRESHOLD",
  "PLAN_PERSISTENCE_FAILED",
  "PLANNING_CONTEXT_MISMATCH",
  "PLANNING_RECONCILIATION_FAILED",
  "INVALID_PLANNING_STATE",
  "OBJECTIVE_NOT_FOUND",
] as const;

export type PlanningErrorCode = (typeof PLANNING_ERROR_CODES)[number];

export class PlanningError extends Error {
  readonly code: PlanningErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PlanningErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PlanningError";
    this.code = code;
    this.details = details;
  }
}

export function isPlanningError(error: unknown): error is PlanningError {
  return error instanceof PlanningError;
}
