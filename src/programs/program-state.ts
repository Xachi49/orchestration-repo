import { z } from "zod";

/**
 * Explicit Program state machine. AUTHORITY is never inferred from status alone.
 * Terminal: COMPLETED | CANCELLED. Operational hold: BLOCKED | ESCALATED | PAUSED.
 */
export const PROGRAM_STATES = [
  "ADMITTED",
  "DECOMPOSING",
  "DECOMPOSED",
  "VALIDATING",
  "AWAITING_MATERIALIZATION_APPROVAL",
  "MATERIALIZING",
  "ACTIVE",
  "VERIFYING",
  "COMPLETED",
  "BLOCKED",
  "ESCALATED",
  "CANCELLED",
  "PAUSED",
] as const;

export const ProgramStateSchema = z.enum(PROGRAM_STATES);
export type ProgramState = z.infer<typeof ProgramStateSchema>;

export const TERMINAL_PROGRAM_STATES = [
  "COMPLETED",
  "CANCELLED",
] as const satisfies readonly ProgramState[];

export function isTerminalProgramState(state: ProgramState): boolean {
  return (TERMINAL_PROGRAM_STATES as readonly string[]).includes(state);
}

/** Discoverable states that may yield Phase 14 scheduler work. */
export const DISCOVERABLE_PROGRAM_STATES = [
  "ADMITTED",
  "DECOMPOSING",
  "DECOMPOSED",
  "VALIDATING",
  "AWAITING_MATERIALIZATION_APPROVAL",
  "MATERIALIZING",
  "ACTIVE",
  "VERIFYING",
] as const satisfies readonly ProgramState[];

/**
 * Legal transitions. Owner is documentary — enforcement lives in services.
 */
export const PROGRAM_TRANSITIONS: Readonly<
  Record<ProgramState, readonly ProgramState[]>
> = {
  ADMITTED: ["DECOMPOSING", "CANCELLED", "BLOCKED"],
  DECOMPOSING: ["DECOMPOSED", "BLOCKED", "ESCALATED", "CANCELLED"],
  DECOMPOSED: ["VALIDATING", "CANCELLED"],
  VALIDATING: [
    "AWAITING_MATERIALIZATION_APPROVAL",
    "DECOMPOSING",
    "BLOCKED",
    "ESCALATED",
    "CANCELLED",
  ],
  AWAITING_MATERIALIZATION_APPROVAL: [
    "MATERIALIZING",
    "DECOMPOSING",
    "BLOCKED",
    "CANCELLED",
  ],
  MATERIALIZING: ["ACTIVE", "BLOCKED", "ESCALATED", "CANCELLED"],
  ACTIVE: ["VERIFYING", "PAUSED", "BLOCKED", "ESCALATED", "CANCELLED"],
  PAUSED: ["ACTIVE", "CANCELLED"],
  VERIFYING: ["COMPLETED", "ACTIVE", "ESCALATED", "BLOCKED"],
  COMPLETED: [],
  BLOCKED: ["DECOMPOSING", "VALIDATING", "ACTIVE", "CANCELLED"],
  ESCALATED: ["DECOMPOSING", "VALIDATING", "ACTIVE", "CANCELLED"],
  CANCELLED: [],
};

export function canTransitionProgram(
  from: ProgramState,
  to: ProgramState,
): boolean {
  return PROGRAM_TRANSITIONS[from].includes(to);
}
