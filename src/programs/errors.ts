export const PROGRAM_ERROR_CODES = [
  "PROGRAM_NOT_FOUND",
  "PROGRAM_VERSION_CONFLICT",
  "PROGRAM_STATE_CONFLICT",
  "PROGRAM_CAS_CONFLICT",
  "INVALID_PROGRAM_TRANSITION",
  "DECOMPOSITION_FAILED",
  "DECOMPOSITION_BUDGET_EXCEEDED",
  "PROGRAM_PLAN_INVALID",
  "PROGRAM_GRAPH_CYCLE",
  "PROGRAM_DEPTH_EXCEEDED",
  "PROGRAM_FAN_OUT_EXCEEDED",
  "PROGRAM_CHILD_COUNT_EXCEEDED",
  "PROGRAM_BUDGET_MULTIPLICATION",
  "PROGRAM_BUDGET_OVER_ALLOCATION",
  "CAPABILITY_EXPANSION_REJECTED",
  "POLICY_WEAKENING_REJECTED",
  "REPOSITORY_OUTSIDE_ENVELOPE",
  "PROJECT_OUTSIDE_ENVELOPE",
  "CROSS_PROJECT_DENIED",
  "ENVIRONMENT_OUTSIDE_ENVELOPE",
  "COMPLETION_BINDING_INCOMPLETE",
  "MATERIALIZATION_APPROVAL_REQUIRED",
  "MATERIALIZATION_APPROVAL_INVALID",
  "MATERIALIZATION_APPROVAL_EXPIRED",
  "AUTHORITY_DRIFT",
  "PROGRAM_PAUSED",
  "CHILD_ADMISSION_FAILED",
  "PROGRAM_VERIFICATION_FAILED",
  "PROGRAM_INCONCLUSIVE",
  "DATABASE_UNAVAILABLE",
] as const;

export type ProgramErrorCode = (typeof PROGRAM_ERROR_CODES)[number];

export class ProgramError extends Error {
  readonly code: ProgramErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: ProgramErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProgramError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isProgramError(error: unknown): error is ProgramError {
  return error instanceof ProgramError;
}
