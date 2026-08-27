/**
 * Phase 18 causal question lifecycle.
 *
 * No direct ESTIMATING → PROMOTED.
 * No model-created promotion.
 */
export const CAUSAL_QUESTION_STATES = [
  "DRAFT",
  "ADMITTED",
  "GRAPH_PROPOSED",
  "IDENTIFICATION_ANALYSIS",
  "ESTIMATING",
  "SYNTHESIZING",
  "VALIDATING",
  "AWAITING_CAUSAL_REVIEW",
  "REVIEWED",
  "PROMOTED",
  "REJECTED",
  "INCONCLUSIVE",
  "STALE",
  "SUPERSEDED",
  "CANCELLED",
] as const;

export type CausalQuestionState = (typeof CAUSAL_QUESTION_STATES)[number];

export const TERMINAL_CAUSAL_QUESTION_STATES = [
  "PROMOTED",
  "REJECTED",
  "INCONCLUSIVE",
  "CANCELLED",
  "SUPERSEDED",
] as const satisfies readonly CausalQuestionState[];

export type TerminalCausalQuestionState =
  (typeof TERMINAL_CAUSAL_QUESTION_STATES)[number];

export function isTerminalCausalQuestionState(
  state: CausalQuestionState,
): state is TerminalCausalQuestionState {
  return (TERMINAL_CAUSAL_QUESTION_STATES as readonly string[]).includes(state);
}

export const DISCOVERABLE_CAUSAL_QUESTION_STATES = [
  "ADMITTED",
  "GRAPH_PROPOSED",
  "IDENTIFICATION_ANALYSIS",
  "ESTIMATING",
  "SYNTHESIZING",
  "VALIDATING",
  "AWAITING_CAUSAL_REVIEW",
  "REVIEWED",
] as const satisfies readonly CausalQuestionState[];

export const CAUSAL_QUESTION_TRANSITIONS: Record<
  CausalQuestionState,
  readonly CausalQuestionState[]
> = {
  DRAFT: ["ADMITTED", "CANCELLED"],
  ADMITTED: ["GRAPH_PROPOSED", "STALE", "CANCELLED"],
  GRAPH_PROPOSED: ["IDENTIFICATION_ANALYSIS", "STALE", "CANCELLED"],
  IDENTIFICATION_ANALYSIS: [
    "ESTIMATING",
    "INCONCLUSIVE",
    "STALE",
    "CANCELLED",
  ],
  ESTIMATING: ["SYNTHESIZING", "INCONCLUSIVE", "STALE", "CANCELLED"],
  SYNTHESIZING: ["VALIDATING", "INCONCLUSIVE", "STALE", "CANCELLED"],
  VALIDATING: [
    "AWAITING_CAUSAL_REVIEW",
    "GRAPH_PROPOSED",
    "INCONCLUSIVE",
    "STALE",
    "CANCELLED",
  ],
  AWAITING_CAUSAL_REVIEW: [
    "REVIEWED",
    "REJECTED",
    "GRAPH_PROPOSED",
    "STALE",
    "CANCELLED",
  ],
  REVIEWED: ["PROMOTED", "REJECTED", "STALE", "CANCELLED"],
  PROMOTED: ["STALE", "SUPERSEDED"],
  REJECTED: [],
  INCONCLUSIVE: [],
  STALE: ["GRAPH_PROPOSED", "CANCELLED"],
  SUPERSEDED: [],
  CANCELLED: [],
};

export function canTransitionCausalQuestion(
  from: CausalQuestionState,
  to: CausalQuestionState,
): boolean {
  return CAUSAL_QUESTION_TRANSITIONS[from].includes(to);
}
