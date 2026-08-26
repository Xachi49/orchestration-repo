import { z } from "zod";

/**
 * Strategic decision problem lifecycle.
 * Simulation never selects strategy — human STRATEGY_SELECTOR required.
 * Terminal: MATERIALIZED_AS_PROPOSAL | CANCELLED | STALE (STALE may restart).
 */
export const DECISION_PROBLEM_STATES = [
  "DRAFT",
  "ADMITTED",
  "GROUNDING",
  "SCENARIOS_PROPOSED",
  "SIMULATING",
  "ANALYZING",
  "VALIDATING",
  "AWAITING_SELECTION",
  "SELECTED",
  "MATERIALIZED_AS_PROPOSAL",
  "STALE",
  "CANCELLED",
] as const;

export const DecisionProblemStateSchema = z.enum(DECISION_PROBLEM_STATES);
export type DecisionProblemState = z.infer<typeof DecisionProblemStateSchema>;

export const TERMINAL_DECISION_PROBLEM_STATES = [
  "MATERIALIZED_AS_PROPOSAL",
  "CANCELLED",
] as const satisfies readonly DecisionProblemState[];

export function isTerminalDecisionProblemState(
  state: DecisionProblemState,
): boolean {
  return (TERMINAL_DECISION_PROBLEM_STATES as readonly string[]).includes(state);
}

export const DISCOVERABLE_DECISION_PROBLEM_STATES = [
  "ADMITTED",
  "GROUNDING",
  "SCENARIOS_PROPOSED",
  "SIMULATING",
  "ANALYZING",
  "VALIDATING",
  "AWAITING_SELECTION",
  "SELECTED",
  "STALE",
] as const satisfies readonly DecisionProblemState[];

export const DECISION_PROBLEM_TRANSITIONS: Readonly<
  Record<DecisionProblemState, readonly DecisionProblemState[]>
> = {
  DRAFT: ["ADMITTED", "CANCELLED"],
  ADMITTED: ["GROUNDING", "CANCELLED"],
  GROUNDING: ["SCENARIOS_PROPOSED", "STALE", "CANCELLED"],
  SCENARIOS_PROPOSED: ["SIMULATING", "STALE", "CANCELLED"],
  SIMULATING: ["ANALYZING", "STALE", "CANCELLED"],
  ANALYZING: ["VALIDATING", "STALE", "CANCELLED"],
  VALIDATING: ["AWAITING_SELECTION", "ANALYZING", "STALE", "CANCELLED"],
  AWAITING_SELECTION: ["SELECTED", "ANALYZING", "STALE", "CANCELLED"],
  SELECTED: ["MATERIALIZED_AS_PROPOSAL", "STALE", "CANCELLED"],
  MATERIALIZED_AS_PROPOSAL: [],
  STALE: ["GROUNDING", "CANCELLED"],
  CANCELLED: [],
};

export function canTransitionDecisionProblem(
  from: DecisionProblemState,
  to: DecisionProblemState,
): boolean {
  return DECISION_PROBLEM_TRANSITIONS[from].includes(to);
}
