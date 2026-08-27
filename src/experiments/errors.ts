export const EXPERIMENT_ERROR_CODES = [
  "EXPERIMENT_NOT_FOUND",
  "EXPERIMENT_VERSION_CONFLICT",
  "EXPERIMENT_STATE_CONFLICT",
  "EXPERIMENT_CAS_CONFLICT",
  "INVALID_EXPERIMENT_TRANSITION",
  "HYPOTHESIS_INVALID",
  "MEASUREMENT_INVALID",
  "UNIT_MIXING_REJECTED",
  "ASSUMPTION_BINDING_INVALID",
  "EXPERIMENT_PLAN_INVALID",
  "EXPERIMENT_BUDGET_EXCEEDED",
  "EXPERIMENT_AUTHORIZATION_REQUIRED",
  "EXPERIMENT_AUTHORIZATION_INVALID",
  "EXPERIMENT_AUTHORIZATION_EXPIRED",
  "EXPERIMENT_SPONSOR_SCOPE_INSUFFICIENT",
  "EXPERIMENT_AUTH_DOES_NOT_EXECUTE",
  "EXECUTION_COMPILATION_FAILED",
  "EXECUTION_AUTHORIZATION_REQUIRED",
  "EVIDENCE_BUNDLE_INVALID",
  "ASSUMPTION_UPDATE_REJECTED",
  "PHASE8_VERIFICATION_REQUIRED",
  "PHASE8_VERIFICATION_INVALID",
  "PHASE8_VERIFICATION_RUN_MISMATCH",
  "PHASE8_VERIFICATION_PROJECT_MISMATCH",
  "OBJECTIVE_ADMISSION_UNAVAILABLE",
  "OBJECTIVE_ADMISSION_REJECTED",
  "TRUTH_DRIFT",
  "PACKAGE_STALE",
  "SAFETY_STOP",
  "PORTFOLIO_ADMISSION_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
] as const;

export type ExperimentErrorCode = (typeof EXPERIMENT_ERROR_CODES)[number];

export class ExperimentError extends Error {
  readonly code: ExperimentErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: ExperimentErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ExperimentError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isExperimentError(error: unknown): error is ExperimentError {
  return error instanceof ExperimentError;
}
