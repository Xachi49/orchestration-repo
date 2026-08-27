/**
 * Phase 19 decision policy lifecycle.
 *
 * No direct VALIDATED → ACTIVE.
 * Shadow approval ≠ activation.
 */
export const DECISION_POLICY_STATES = [
  "DRAFT",
  "SYNTHESIZED",
  "VALIDATED",
  "AWAITING_APPROVAL",
  "APPROVED_FOR_SHADOW",
  "SHADOW_RUNNING",
  "AWAITING_ACTIVATION",
  "ACTIVE",
  "PAUSED",
  "RETIRED",
  "STALE",
  "REJECTED",
] as const;

export type DecisionPolicyState = (typeof DECISION_POLICY_STATES)[number];

export const TERMINAL_DECISION_POLICY_STATES = [
  "RETIRED",
  "REJECTED",
] as const satisfies readonly DecisionPolicyState[];

export type TerminalDecisionPolicyState =
  (typeof TERMINAL_DECISION_POLICY_STATES)[number];

export function isTerminalDecisionPolicyState(
  state: DecisionPolicyState,
): state is TerminalDecisionPolicyState {
  return (TERMINAL_DECISION_POLICY_STATES as readonly string[]).includes(state);
}

export const DISCOVERABLE_DECISION_POLICY_STATES = [
  "DRAFT",
  "SYNTHESIZED",
  "VALIDATED",
  "AWAITING_APPROVAL",
  "APPROVED_FOR_SHADOW",
  "SHADOW_RUNNING",
  "AWAITING_ACTIVATION",
  "ACTIVE",
  "PAUSED",
] as const satisfies readonly DecisionPolicyState[];

export const DECISION_POLICY_TRANSITIONS: Record<
  DecisionPolicyState,
  readonly DecisionPolicyState[]
> = {
  DRAFT: ["SYNTHESIZED", "REJECTED"],
  SYNTHESIZED: ["VALIDATED", "DRAFT", "REJECTED", "STALE"],
  VALIDATED: ["AWAITING_APPROVAL", "SYNTHESIZED", "REJECTED", "STALE"],
  AWAITING_APPROVAL: [
    "APPROVED_FOR_SHADOW",
    "REJECTED",
    "SYNTHESIZED",
    "STALE",
  ],
  APPROVED_FOR_SHADOW: ["SHADOW_RUNNING", "REJECTED", "STALE", "PAUSED"],
  SHADOW_RUNNING: ["AWAITING_ACTIVATION", "PAUSED", "STALE", "REJECTED"],
  AWAITING_ACTIVATION: ["ACTIVE", "SHADOW_RUNNING", "REJECTED", "STALE"],
  ACTIVE: ["PAUSED", "STALE", "RETIRED"],
  PAUSED: ["AWAITING_ACTIVATION", "STALE", "RETIRED", "SHADOW_RUNNING"],
  RETIRED: [],
  STALE: ["DRAFT", "RETIRED"],
  REJECTED: [],
};

export function canTransitionDecisionPolicy(
  from: DecisionPolicyState,
  to: DecisionPolicyState,
): boolean {
  return DECISION_POLICY_TRANSITIONS[from].includes(to);
}
