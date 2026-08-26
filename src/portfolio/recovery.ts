/**
 * Recovery classification for abandoned Phase 15 Portfolio states.
 * Recovery must never blindly replay unknown external effects.
 * Program admission itself is internal/durable and idempotent.
 */
export const PORTFOLIO_RECOVERY_CLASSES = [
  "SAFE_TO_RETRY",
  "REQUIRES_RECONCILIATION",
  "UNSAFE_TO_RETRY",
  "HUMAN_INTERVENTION_REQUIRED",
] as const;

export type PortfolioRecoveryClass =
  (typeof PORTFOLIO_RECOVERY_CLASSES)[number];

export function classifyPortfolioRecovery(input: {
  status: string;
  paused: boolean;
  hasPartialLineage: boolean;
  hasApprovedAuthorization: boolean;
  hasCompletionRecord: boolean;
}): PortfolioRecoveryClass {
  if (input.hasCompletionRecord && input.status === "COMPLETED") {
    return "SAFE_TO_RETRY"; // idempotent read / no-op verify
  }
  switch (input.status) {
    case "ANALYZING":
    case "PLANNED":
    case "VALIDATING":
      return "SAFE_TO_RETRY";
    case "AWAITING_AUTHORIZATION":
      return "HUMAN_INTERVENTION_REQUIRED";
    case "AUTHORIZED":
      return input.hasApprovedAuthorization
        ? "SAFE_TO_RETRY"
        : "REQUIRES_RECONCILIATION";
    case "ACTIVE":
      return input.hasPartialLineage
        ? "REQUIRES_RECONCILIATION"
        : "SAFE_TO_RETRY";
    case "VERIFYING":
      return "REQUIRES_RECONCILIATION";
    case "REBALANCE_REQUIRED":
      return "HUMAN_INTERVENTION_REQUIRED";
    case "PAUSED":
      return "HUMAN_INTERVENTION_REQUIRED";
    case "FAILED":
    case "CANCELLED":
      return "UNSAFE_TO_RETRY";
    default:
      return "UNSAFE_TO_RETRY";
  }
}
