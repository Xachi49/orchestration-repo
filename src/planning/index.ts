/**
 * Planner authority boundary.
 * May propose actions. Cannot authorize or execute.
 * Phase 0: contract only — no planner implementation.
 */
export interface PlannerPort {
  readonly authority: "PROPOSE_ONLY";
}

export const PLANNER_AUTHORITY = {
  mayProposeActions: true,
  mayAuthorizeActions: false,
  mayExecuteActions: false,
} as const;
