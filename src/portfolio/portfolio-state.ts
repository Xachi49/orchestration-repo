import { z } from "zod";

/**
 * Explicit Portfolio state machine. Strategy proposes; humans authorize;
 * evidence completes. Terminal: COMPLETED | CANCELLED | FAILED.
 */
export const PORTFOLIO_STATES = [
  "DRAFT",
  "ADMITTED",
  "ANALYZING",
  "PLANNED",
  "VALIDATING",
  "AWAITING_AUTHORIZATION",
  "AUTHORIZED",
  "ACTIVE",
  "REBALANCE_REQUIRED",
  "PAUSED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export const PortfolioStateSchema = z.enum(PORTFOLIO_STATES);
export type PortfolioState = z.infer<typeof PortfolioStateSchema>;

export const TERMINAL_PORTFOLIO_STATES = [
  "COMPLETED",
  "CANCELLED",
  "FAILED",
] as const satisfies readonly PortfolioState[];

export function isTerminalPortfolioState(state: PortfolioState): boolean {
  return (TERMINAL_PORTFOLIO_STATES as readonly string[]).includes(state);
}

export const DISCOVERABLE_PORTFOLIO_STATES = [
  "ADMITTED",
  "ANALYZING",
  "PLANNED",
  "VALIDATING",
  "AWAITING_AUTHORIZATION",
  "AUTHORIZED",
  "ACTIVE",
  "REBALANCE_REQUIRED",
  "VERIFYING",
] as const satisfies readonly PortfolioState[];

export const PORTFOLIO_TRANSITIONS: Readonly<
  Record<PortfolioState, readonly PortfolioState[]>
> = {
  DRAFT: ["ADMITTED", "CANCELLED"],
  ADMITTED: ["ANALYZING", "CANCELLED", "FAILED"],
  ANALYZING: ["PLANNED", "FAILED", "CANCELLED"],
  PLANNED: ["VALIDATING", "CANCELLED"],
  VALIDATING: [
    "AWAITING_AUTHORIZATION",
    "ANALYZING",
    "FAILED",
    "CANCELLED",
  ],
  AWAITING_AUTHORIZATION: [
    "AUTHORIZED",
    "ANALYZING",
    "CANCELLED",
    "FAILED",
  ],
  AUTHORIZED: ["ACTIVE", "FAILED", "CANCELLED"],
  ACTIVE: [
    "VERIFYING",
    "REBALANCE_REQUIRED",
    "PAUSED",
    "FAILED",
    "CANCELLED",
  ],
  REBALANCE_REQUIRED: ["ANALYZING", "PAUSED", "FAILED", "CANCELLED"],
  PAUSED: ["ACTIVE", "ANALYZING", "CANCELLED"],
  VERIFYING: ["COMPLETED", "ACTIVE", "REBALANCE_REQUIRED", "FAILED"],
  COMPLETED: [],
  FAILED: ["ANALYZING", "CANCELLED"],
  CANCELLED: [],
};

export function canTransitionPortfolio(
  from: PortfolioState,
  to: PortfolioState,
): boolean {
  return PORTFOLIO_TRANSITIONS[from].includes(to);
}
