export const SCENARIO_ERROR_CODES = [
  "DECISION_PROBLEM_NOT_FOUND",
  "DECISION_PROBLEM_VERSION_CONFLICT",
  "DECISION_PROBLEM_STATE_CONFLICT",
  "DECISION_PROBLEM_CAS_CONFLICT",
  "INVALID_DECISION_TRANSITION",
  "ASSUMPTION_INVALID",
  "ASSUMPTION_SET_HASH_MISMATCH",
  "SCENARIO_INVALID",
  "SCENARIO_SET_INVALID",
  "UNIT_MIXING_REJECTED",
  "SIMULATION_BUDGET_EXCEEDED",
  "SIMULATION_IDENTITY_CONFLICT",
  "DECISION_PACKAGE_INVALID",
  "STRATEGY_SELECTION_REQUIRED",
  "STRATEGY_SELECTION_INVALID",
  "STRATEGY_SELECTION_EXPIRED",
  "STRATEGY_SELECTOR_SCOPE_INSUFFICIENT",
  "TRUTH_DRIFT",
  "PACKAGE_STALE",
  "SELECTION_DOES_NOT_ALLOCATE",
  "PORTFOLIO_PROPOSAL_FAILED",
  "PORTFOLIO_ADMISSION_UNAVAILABLE",
  "DATABASE_UNAVAILABLE",
] as const;

export type ScenarioErrorCode = (typeof SCENARIO_ERROR_CODES)[number];

export class ScenarioError extends Error {
  readonly code: ScenarioErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: ScenarioErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ScenarioError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isScenarioError(error: unknown): error is ScenarioError {
  return error instanceof ScenarioError;
}
