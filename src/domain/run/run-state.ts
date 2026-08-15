import { z } from "zod";

export const RunStateSchema = z.enum([
  "RECEIVED",
  "ADMITTED",
  "INGESTING",
  "PLANNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "COMPLETED",
  "ADMISSION_REJECTED",
  "BLOCKED",
  "REVISING",
  "ESCALATED",
  "REJECTED",
  "EXPIRED",
  "SUPERSEDED",
  "FAILED",
  "CONTAINED",
  "ROLLBACK_REQUIRED",
  "CANCELLED",
]);

export type RunState = z.infer<typeof RunStateSchema>;

/** Primary happy-path progression. */
export const PRIMARY_RUN_STATES = [
  "RECEIVED",
  "ADMITTED",
  "INGESTING",
  "PLANNING",
  "VALIDATING",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTING",
  "VERIFYING",
  "COMPLETED",
] as const satisfies readonly RunState[];

/** States that cannot transition further (fail closed / terminal). */
export const TERMINAL_RUN_STATES = [
  "COMPLETED",
  "ADMISSION_REJECTED",
  "REJECTED",
  "EXPIRED",
  "SUPERSEDED",
  "FAILED",
  "CANCELLED",
  "CONTAINED",
] as const satisfies readonly RunState[];

export type TerminalRunState = (typeof TERMINAL_RUN_STATES)[number];

export function isTerminalRunState(state: RunState): state is TerminalRunState {
  return (TERMINAL_RUN_STATES as readonly string[]).includes(state);
}

/**
 * Explicit legal transitions. Anything not listed is illegal and fails closed.
 */
export const RUN_TRANSITIONS: Readonly<Record<RunState, readonly RunState[]>> =
  {
    RECEIVED: ["ADMITTED", "ADMISSION_REJECTED", "EXPIRED", "CANCELLED"],
    ADMITTED: ["INGESTING", "BLOCKED", "EXPIRED", "CANCELLED", "SUPERSEDED"],
    INGESTING: [
      "PLANNING",
      "BLOCKED",
      "FAILED",
      "EXPIRED",
      "CANCELLED",
      "SUPERSEDED",
    ],
    PLANNING: [
      "VALIDATING",
      "BLOCKED",
      "FAILED",
      "EXPIRED",
      "CANCELLED",
      "SUPERSEDED",
    ],
    // Phase 5 has no approval authority: VALIDATING → APPROVED is illegal.
    // Phase 6 routes VALIDATING → AWAITING_APPROVAL | BLOCKED.
    // Only Phase 6 may then transition AWAITING_APPROVAL → APPROVED.
    VALIDATING: [
      "AWAITING_APPROVAL",
      "BLOCKED",
      "REVISING",
      "REJECTED",
      "FAILED",
      "EXPIRED",
      "CANCELLED",
    ],
    // Phase 6 human authorization outcomes.
    AWAITING_APPROVAL: [
      "APPROVED",
      "REJECTED",
      "REVISING",
      "ESCALATED",
      "EXPIRED",
      "CANCELLED",
      "SUPERSEDED",
    ],
    APPROVED: [
      "EXECUTING",
      "CANCELLED",
      "EXPIRED",
      "SUPERSEDED",
      "BLOCKED",
    ],
    EXECUTING: [
      "VERIFYING",
      "FAILED",
      "BLOCKED",
      "CONTAINED",
      "ROLLBACK_REQUIRED",
      "CANCELLED",
      "ESCALATED",
    ],
    VERIFYING: [
      "COMPLETED",
      "FAILED",
      "ROLLBACK_REQUIRED",
      "CONTAINED",
      "ESCALATED",
      "BLOCKED",
    ],
    COMPLETED: [],
    ADMISSION_REJECTED: [],
    BLOCKED: [
      "REVISING",
      "ESCALATED",
      "REJECTED",
      "CANCELLED",
      "EXPIRED",
      "SUPERSEDED",
    ],
    REVISING: [
      "PLANNING",
      "VALIDATING",
      "BLOCKED",
      "REJECTED",
      "CANCELLED",
      "EXPIRED",
      "SUPERSEDED",
    ],
    ESCALATED: [
      "AWAITING_APPROVAL",
      "REVISING",
      "REJECTED",
      "CANCELLED",
      "EXPIRED",
      "SUPERSEDED",
      "CONTAINED",
    ],
    REJECTED: [],
    EXPIRED: [],
    SUPERSEDED: [],
    FAILED: ["ROLLBACK_REQUIRED", "CONTAINED"],
    CONTAINED: [],
    ROLLBACK_REQUIRED: ["FAILED", "CONTAINED", "CANCELLED", "ESCALATED"],
    CANCELLED: [],
  };

export class IllegalRunTransitionError extends Error {
  readonly code = "ILLEGAL_RUN_TRANSITION" as const;
  readonly from: RunState;
  readonly to: RunState;

  constructor(from: RunState, to: RunState) {
    super(`Illegal run-state transition: ${from} → ${to}`);
    this.name = "IllegalRunTransitionError";
    this.from = from;
    this.to = to;
  }
}

export type TransitionResult =
  | { ok: true; state: RunState }
  | {
      ok: false;
      error: IllegalRunTransitionError;
    };

/**
 * Deterministic transition service. Never mutates caller state.
 * Illegal transitions fail closed.
 */
export function transitionRunState(
  current: RunState,
  requested: RunState,
): TransitionResult {
  const allowed = RUN_TRANSITIONS[current];
  if (!allowed.includes(requested)) {
    return {
      ok: false,
      error: new IllegalRunTransitionError(current, requested),
    };
  }
  return { ok: true, state: requested };
}

export function assertTransition(
  current: RunState,
  requested: RunState,
): RunState {
  const result = transitionRunState(current, requested);
  if (!result.ok) {
    throw result.error;
  }
  return result.state;
}
