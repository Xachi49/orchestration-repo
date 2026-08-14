import type { RunState } from "../domain/run/run-state.js";

export const IDEMPOTENCY_RECORD_STATUSES = [
  "RESERVED",
  "ACTIVE",
  "COMPLETED",
] as const;

export type IdempotencyRecordStatus =
  (typeof IDEMPOTENCY_RECORD_STATUSES)[number];

export interface IdempotencyRecord {
  key: string;
  fingerprint: string;
  status: IdempotencyRecordStatus;
  runId: string | null;
  reservedAt: string;
  updatedAt: string;
}

export type IdempotencyReserveResult =
  | { status: "NEW" }
  | { status: "ACTIVE_DUPLICATE"; runId: string | null; fingerprint: string }
  | { status: "COMPLETED_DUPLICATE"; runId: string | null; fingerprint: string }
  | {
      status: "OBJECTIVE_VERSION_CONFLICT";
      runId: string | null;
      fingerprint: string;
    };

/**
 * Persistence port for objective idempotency keys.
 * Future durable stores must enforce unique(key) and atomic reserve.
 * In-memory adapters do not provide distributed transactional guarantees.
 */
export interface IdempotencyStore {
  getByKey(key: string): Promise<IdempotencyRecord | null>;
  reserve(
    key: string,
    fingerprint: string,
    reservedAt: string,
  ): Promise<IdempotencyReserveResult>;
  /** Bind a reserved key to a run after successful admission (ACTIVE). */
  complete(key: string, runId: string, updatedAt: string): Promise<void>;
  /** Terminal completion of the bound run. */
  markCompleted(key: string, updatedAt: string): Promise<void>;
  /** Compensation: drop an unbound reservation. */
  release(key: string): Promise<void>;
}

export function duplicateOutcomeForRunState(
  state: RunState,
): "ACTIVE_DUPLICATE" | "COMPLETED_DUPLICATE" {
  return state === "COMPLETED" ? "COMPLETED_DUPLICATE" : "ACTIVE_DUPLICATE";
}
