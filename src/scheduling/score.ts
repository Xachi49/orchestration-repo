import { PRIORITY_RANK, type PriorityClass } from "./priority.js";

export const SCHEDULING_REASON_CODES = [
  "HIGHER_PRIORITY",
  "FAIR_SHARE",
  "AGING",
  "DEADLINE",
  "PROJECT_CAPACITY",
  "GLOBAL_CAPACITY",
  "DEPENDENCY_BLOCKED",
  "PROJECT_PAUSED",
  "GLOBAL_PAUSED",
  "NOT_YET_ELIGIBLE",
  "WORKER_CAPABILITY",
  "SELECTED",
  "SKIPPED",
] as const;

export type SchedulingReasonCode = (typeof SCHEDULING_REASON_CODES)[number];

export interface ScoreInputs {
  priorityClass: PriorityClass;
  /** Milliseconds waited since eligibleAt (injected clock). */
  waitingAgeMs: number;
  projectWeight: number;
  /** Non-negative deficit for deficit round-robin fairness. */
  projectDeficit: number;
  /** Milliseconds until deadline; undefined if no deadline. */
  deadlineProximityMs?: number;
}

/**
 * Deterministic scheduling score. Higher wins.
 * Aging raises score without mutating priorityClass.
 */
export function computeSchedulingScore(input: ScoreInputs): number {
  const priority = PRIORITY_RANK[input.priorityClass];
  const ageBoost = Math.min(400, Math.floor(input.waitingAgeMs / 60_000) * 10);
  // Weight affects share only through durable deficit accrual (fairness.ts),
  // not a permanent score bias that cancels DRR.
  const deficitBoost = Math.min(300, input.projectDeficit);
  let deadlineBoost = 0;
  if (input.deadlineProximityMs !== undefined) {
    if (input.deadlineProximityMs <= 0) {
      deadlineBoost = 150;
    } else if (input.deadlineProximityMs < 3_600_000) {
      deadlineBoost = Math.floor(
        100 * (1 - input.deadlineProximityMs / 3_600_000),
      );
    }
  }
  return priority + ageBoost + deficitBoost + deadlineBoost;
}

export function compareCandidates(
  a: { score: number; workItemId: string; createdAt: string },
  b: { score: number; workItemId: string; createdAt: string },
): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.createdAt !== b.createdAt) {
    return a.createdAt < b.createdAt ? -1 : 1;
  }
  return a.workItemId < b.workItemId ? -1 : a.workItemId > b.workItemId ? 1 : 0;
}
