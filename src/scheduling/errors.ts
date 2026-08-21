export const SCHEDULING_ERROR_CODES = [
  "INVALID_WORK_ITEM",
  "WORK_ITEM_NOT_FOUND",
  "WORK_ITEM_NOT_ELIGIBLE",
  "WORK_ITEM_STALE",
  "WORK_ITEM_ALREADY_CLAIMED",
  "STALE_SCHEDULER_FENCE",
  "DEPENDENCY_CYCLE",
  "SELF_DEPENDENCY",
  "CROSS_PROJECT_DEPENDENCY_DENIED",
  "DEPENDENCY_UNSATISFIABLE",
  "PROJECT_PAUSED",
  "GLOBAL_PAUSED",
  "PROJECT_CAPACITY_EXCEEDED",
  "GLOBAL_CAPACITY_EXCEEDED",
  "WORKER_CAPABILITY_MISMATCH",
  "DISPATCH_READINESS_FAILED",
  "RETRY_BUDGET_EXHAUSTED",
  "SCHEDULER_CONFIG_INVALID",
  "SCHEDULER_CAS_CONFLICT",
  "UNAUTHORIZED_SCHEDULER_OPERATION",
] as const;

export type SchedulingErrorCode = (typeof SCHEDULING_ERROR_CODES)[number];

export class SchedulingError extends Error {
  readonly code: SchedulingErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: SchedulingErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "SchedulingError";
    this.code = code;
    this.details = details;
  }
}

export function isSchedulingError(error: unknown): error is SchedulingError {
  return error instanceof SchedulingError;
}
