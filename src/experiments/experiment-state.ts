/**
 * Phase 17 experiment lifecycle.
 *
 * AUTHORIZED ≠ EXECUTABLE — Phase 6 still required for operational execution.
 * Experiments produce evidence; they do not produce authority.
 */
export const EXPERIMENT_STATES = [
  "DRAFT",
  "ADMITTED",
  "DESIGNING",
  "PLANNED",
  "VALIDATING",
  "AWAITING_AUTHORIZATION",
  "AUTHORIZED",
  "AWAITING_EXECUTION_AUTHORIZATION",
  "EXECUTING",
  "VERIFYING",
  "COMPLETED",
  "INCONCLUSIVE",
  "FAILED",
  "PAUSED",
  "CANCELLED",
  "STALE",
] as const;

export type ExperimentState = (typeof EXPERIMENT_STATES)[number];

export const TERMINAL_EXPERIMENT_STATES = [
  "COMPLETED",
  "INCONCLUSIVE",
  "FAILED",
  "CANCELLED",
] as const satisfies readonly ExperimentState[];

export type TerminalExperimentState =
  (typeof TERMINAL_EXPERIMENT_STATES)[number];

export function isTerminalExperimentState(
  state: ExperimentState,
): state is TerminalExperimentState {
  return (TERMINAL_EXPERIMENT_STATES as readonly string[]).includes(state);
}

export const DISCOVERABLE_EXPERIMENT_STATES = [
  "ADMITTED",
  "DESIGNING",
  "PLANNED",
  "VALIDATING",
  "AWAITING_AUTHORIZATION",
  "AUTHORIZED",
  "AWAITING_EXECUTION_AUTHORIZATION",
  "EXECUTING",
  "VERIFYING",
] as const satisfies readonly ExperimentState[];

export const EXPERIMENT_TRANSITIONS: Record<
  ExperimentState,
  readonly ExperimentState[]
> = {
  DRAFT: ["ADMITTED", "CANCELLED"],
  ADMITTED: ["DESIGNING", "STALE", "CANCELLED"],
  DESIGNING: ["PLANNED", "STALE", "CANCELLED"],
  PLANNED: ["VALIDATING", "STALE", "CANCELLED"],
  VALIDATING: ["AWAITING_AUTHORIZATION", "DESIGNING", "STALE", "CANCELLED"],
  AWAITING_AUTHORIZATION: ["AUTHORIZED", "DESIGNING", "STALE", "CANCELLED"],
  AUTHORIZED: [
    "AWAITING_EXECUTION_AUTHORIZATION",
    "STALE",
    "CANCELLED",
    "PAUSED",
  ],
  AWAITING_EXECUTION_AUTHORIZATION: [
    "EXECUTING",
    "STALE",
    "CANCELLED",
    "PAUSED",
  ],
  EXECUTING: ["VERIFYING", "FAILED", "STALE", "CANCELLED", "PAUSED"],
  VERIFYING: [
    "COMPLETED",
    "INCONCLUSIVE",
    "FAILED",
    "STALE",
    "CANCELLED",
  ],
  COMPLETED: [],
  INCONCLUSIVE: [],
  FAILED: [],
  PAUSED: ["EXECUTING", "AWAITING_EXECUTION_AUTHORIZATION", "CANCELLED", "STALE"],
  CANCELLED: [],
  STALE: ["DESIGNING", "CANCELLED"],
};

export function canTransitionExperiment(
  from: ExperimentState,
  to: ExperimentState,
): boolean {
  return EXPERIMENT_TRANSITIONS[from].includes(to);
}
