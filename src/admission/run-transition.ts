import type { RunRecord } from "./run-repository.js";
import type { RunRepository } from "./run-repository.js";
import { assertTransition, type RunState } from "../domain/run/run-state.js";

/**
 * Commit a legal run transition using CAS when the repository supports it.
 * Domain transition graph is enforced before persistence.
 */
export async function commitRunTransition(
  runs: RunRepository,
  record: RunRecord,
  next: RunState,
  updatedAt: string,
  extras: { admittedAt?: string; failureReasonCode?: string } = {},
): Promise<RunRecord> {
  assertTransition(record.state, next);
  return runs.transition(
    record.runId,
    record.state,
    record.recordRevision,
    next,
    updatedAt,
    extras,
  );
}
