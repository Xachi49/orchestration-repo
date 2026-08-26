import type { PortfolioState } from "../portfolio/portfolio-state.js";
import type { PortfolioSchedulerWorkKind } from "./work-kind.js";

/**
 * Maps Portfolio durable state to next Phase 15 scheduler work kinds.
 * AWAITING_AUTHORIZATION yields only ROUTE_PORTFOLIO_AUTHORIZATION
 * (never MATERIALIZE_PORTFOLIO_PROGRAMS) — human gate.
 */
export function candidatePortfolioWorkKinds(
  status: PortfolioState,
  paused: boolean,
): readonly PortfolioSchedulerWorkKind[] {
  if (paused) {
    return [];
  }
  switch (status) {
    case "ADMITTED":
      return ["ANALYZE_PORTFOLIO"];
    case "ANALYZING":
      return ["PLAN_PORTFOLIO"];
    case "PLANNED":
    case "VALIDATING":
      return ["VALIDATE_PORTFOLIO"];
    case "AWAITING_AUTHORIZATION":
      return ["ROUTE_PORTFOLIO_AUTHORIZATION"];
    case "AUTHORIZED":
      return ["MATERIALIZE_PORTFOLIO_PROGRAMS"];
    case "ACTIVE":
      return [
        "MATERIALIZE_PORTFOLIO_PROGRAMS",
        "RECONCILE_PORTFOLIO",
        "VERIFY_PORTFOLIO",
      ];
    case "REBALANCE_REQUIRED":
      return ["REBALANCE_PORTFOLIO"];
    case "VERIFYING":
      return ["VERIFY_PORTFOLIO"];
    default:
      return [];
  }
}

export function portfolioWorkBindingHash(input: {
  workKind: PortfolioSchedulerWorkKind;
  portfolioId: string;
  portfolioVersion: number;
  authorizationEnvelopeHash: string;
  policyBundleHash: string;
  capabilitySetFingerprint: string;
  portfolioPlanVersion?: number;
  portfolioPlanHash?: string;
  authorizationSubjectHash?: string;
  allocationPlanHash?: string;
}): string {
  switch (input.workKind) {
    case "ANALYZE_PORTFOLIO":
      return `analyze_pfo:${input.portfolioId}:${input.portfolioVersion}:${input.authorizationEnvelopeHash}:${input.policyBundleHash}:${input.capabilitySetFingerprint}`;
    case "PLAN_PORTFOLIO":
      return `plan_pfo:${input.portfolioId}:${input.portfolioVersion}:${input.authorizationEnvelopeHash}`;
    case "VALIDATE_PORTFOLIO":
      return `validate_pfo:${input.portfolioId}:${input.portfolioPlanVersion ?? 0}:${input.portfolioPlanHash ?? "none"}`;
    case "ROUTE_PORTFOLIO_AUTHORIZATION":
      return `route_pfo_auth:${input.portfolioId}:${input.portfolioPlanVersion ?? 0}:${input.portfolioPlanHash ?? "none"}:${input.authorizationEnvelopeHash}`;
    case "MATERIALIZE_PORTFOLIO_PROGRAMS":
      return `materialize_pfo:${input.portfolioId}:${input.authorizationSubjectHash ?? "none"}:${input.portfolioPlanHash ?? "none"}:${input.allocationPlanHash ?? "none"}`;
    case "RECONCILE_PORTFOLIO":
      return `reconcile_pfo:${input.portfolioId}:${input.portfolioPlanVersion ?? 0}:${input.portfolioPlanHash ?? "none"}`;
    case "VERIFY_PORTFOLIO":
      return `verify_pfo:${input.portfolioId}:${input.portfolioPlanVersion ?? 0}:${input.portfolioPlanHash ?? "none"}`;
    case "REBALANCE_PORTFOLIO":
      return `rebalance_pfo:${input.portfolioId}:${input.portfolioPlanVersion ?? 0}:${input.portfolioPlanHash ?? "none"}`;
    default: {
      const _exhaustive: never = input.workKind;
      return _exhaustive;
    }
  }
}
