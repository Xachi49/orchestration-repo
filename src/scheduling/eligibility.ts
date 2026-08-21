import type { SchedulerWorkItem } from "./work-item.js";
import { isTerminalWorkStatus } from "./work-item.js";
import type { SchedulingReasonCode } from "./score.js";

export interface EligibilityInput {
  work: SchedulerWorkItem;
  nowIso: string;
  projectPaused: boolean;
  globalPaused: boolean;
  dependenciesSatisfied: boolean;
  dependencyUnsatisfiable: boolean;
  projectActiveClaims: number;
  projectMaxConcurrency: number;
  globalActiveClaims: number;
  globalMaxConcurrency: number;
  workerSupports: boolean;
}

export interface EligibilityResult {
  eligible: boolean;
  reason: SchedulingReasonCode;
}

/**
 * Operational eligibility. ELIGIBLE != AUTHORIZED.
 * Phase readiness must still run immediately before dispatch.
 */
export function evaluateEligibility(input: EligibilityInput): EligibilityResult {
  const { work } = input;
  if (isTerminalWorkStatus(work.status)) {
    return { eligible: false, reason: "SKIPPED" };
  }
  if (work.status === "CLAIMED" || work.status === "RUNNING") {
    return { eligible: false, reason: "SKIPPED" };
  }
  if (input.globalPaused) {
    return { eligible: false, reason: "GLOBAL_PAUSED" };
  }
  if (input.projectPaused) {
    return { eligible: false, reason: "PROJECT_PAUSED" };
  }
  if (input.dependencyUnsatisfiable) {
    return { eligible: false, reason: "DEPENDENCY_BLOCKED" };
  }
  if (!input.dependenciesSatisfied) {
    return { eligible: false, reason: "DEPENDENCY_BLOCKED" };
  }
  if (Date.parse(work.eligibleAt) > Date.parse(input.nowIso)) {
    return { eligible: false, reason: "NOT_YET_ELIGIBLE" };
  }
  if (input.projectActiveClaims >= input.projectMaxConcurrency) {
    return { eligible: false, reason: "PROJECT_CAPACITY" };
  }
  if (input.globalActiveClaims >= input.globalMaxConcurrency) {
    return { eligible: false, reason: "GLOBAL_CAPACITY" };
  }
  if (!input.workerSupports) {
    return { eligible: false, reason: "WORKER_CAPABILITY" };
  }
  if (work.status === "BLOCKED_DEPENDENCY") {
    return { eligible: false, reason: "DEPENDENCY_BLOCKED" };
  }
  if (work.status === "WAITING" || work.status === "ELIGIBLE") {
    return { eligible: true, reason: "SELECTED" };
  }
  return { eligible: false, reason: "SKIPPED" };
}
