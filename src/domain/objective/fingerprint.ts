import { createHash } from "node:crypto";
import type { ObjectivePriority } from "./objective.js";

export interface ObjectiveFingerprintContent {
  requestedOutcome: string;
  acceptanceCriteria: readonly string[];
  nonGoals: readonly string[];
  constraints: readonly string[];
  priority: ObjectivePriority;
  deadline?: string;
}

/**
 * Canonicalize semantically unordered string collections for hashing only.
 * Does not mutate the caller's arrays.
 */
function canonicalizeStringCollection(
  values: readonly string[],
): readonly string[] {
  const unique = new Set<string>();
  for (const value of values) {
    unique.add(value.trim());
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Deterministic fingerprint of canonical objective content.
 * Unordered collections are normalized for hashing only; stored Objectives
 * are left unchanged.
 */
export function objectiveFingerprint(
  content: ObjectiveFingerprintContent,
): string {
  const payload = {
    acceptanceCriteria: canonicalizeStringCollection(content.acceptanceCriteria),
    constraints: canonicalizeStringCollection(content.constraints),
    deadline: content.deadline ?? null,
    nonGoals: canonicalizeStringCollection(content.nonGoals),
    priority: content.priority,
    requestedOutcome: content.requestedOutcome,
  };
  const canonical = JSON.stringify(payload);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
