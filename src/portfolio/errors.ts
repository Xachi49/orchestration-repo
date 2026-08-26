export const PORTFOLIO_ERROR_CODES = [
  "PORTFOLIO_NOT_FOUND",
  "PORTFOLIO_VERSION_CONFLICT",
  "PORTFOLIO_STATE_CONFLICT",
  "PORTFOLIO_CAS_CONFLICT",
  "INVALID_PORTFOLIO_TRANSITION",
  "PORTFOLIO_PLAN_INVALID",
  "PORTFOLIO_GOAL_INVALID",
  "PORTFOLIO_GRAPH_CYCLE",
  "PORTFOLIO_BUDGET_OVER_ALLOCATION",
  "PORTFOLIO_PROGRAM_COUNT_EXCEEDED",
  "PORTFOLIO_CONCURRENCY_EXCEEDED",
  "PORTFOLIO_ALLOCATION_CEILING_EXCEEDED",
  "PROJECT_OUTSIDE_ENVELOPE",
  "CROSS_PROJECT_DENIED",
  "REPOSITORY_OUTSIDE_ENVELOPE",
  "ENVIRONMENT_OUTSIDE_ENVELOPE",
  "CAPABILITY_EXPANSION_REJECTED",
  "PORTFOLIO_AUTHORIZATION_REQUIRED",
  "PORTFOLIO_AUTHORIZATION_INVALID",
  "PORTFOLIO_AUTHORIZATION_EXPIRED",
  "AUTHORITY_DRIFT",
  "PORTFOLIO_PAUSED",
  "PROGRAM_ADMISSION_FAILED",
  "PORTFOLIO_VERIFICATION_FAILED",
  "PORTFOLIO_INCONCLUSIVE",
  "GOAL_CONTRIBUTION_INCOMPLETE",
  "FALSE_CONTRIBUTION_BINDING",
  "DATABASE_UNAVAILABLE",
] as const;

export type PortfolioErrorCode = (typeof PORTFOLIO_ERROR_CODES)[number];

export class PortfolioError extends Error {
  readonly code: PortfolioErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: PortfolioErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PortfolioError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isPortfolioError(error: unknown): error is PortfolioError {
  return error instanceof PortfolioError;
}
