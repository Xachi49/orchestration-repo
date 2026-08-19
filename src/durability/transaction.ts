import { AsyncLocalStorage } from "node:async_hooks";
import { DurabilityError } from "./errors.js";

/**
 * Explicit application API: TransactionManager.withTransaction(fn).
 *
 * Postgres adapters join the active session so repository method signatures
 * stay identical to in-memory ports. This is connection scoping, not hidden
 * business authorization. Domain services must still call withTransaction
 * around coupled writes.
 *
 * Isolation: READ COMMITTED by default. Invariants use unique constraints,
 * CAS UPDATE predicates, row locks, and fencing tokens — not SERIALIZABLE.
 */
export interface TransactionManager {
  withTransaction<T>(fn: () => Promise<T>): Promise<T>;
}

/** No-op transaction manager for memory mode and unit tests. */
export class InMemoryTransactionManager implements TransactionManager {
  async withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return fn();
  }
}

export function withOptionalTransaction<T>(
  tx: TransactionManager | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tx) {
    return fn();
  }
  return tx.withTransaction(fn);
}

const transactionDepth = new AsyncLocalStorage<number>();

export function runInTransactionScope<T>(fn: () => Promise<T>): Promise<T> {
  const depth = (transactionDepth.getStore() ?? 0) + 1;
  return transactionDepth.run(depth, fn);
}

export function isInTransaction(): boolean {
  return (transactionDepth.getStore() ?? 0) > 0;
}

export function assertNotInTransaction(operation: string): void {
  if (isInTransaction()) {
    throw new DurabilityError(
      "SIDE_EFFECT_IN_TRANSACTION",
      `${operation} must not run while a database transaction is open`,
      { operation },
    );
  }
}

/**
 * Lock order for multi-record operations (avoid deadlocks):
 *
 * project/control-plane refs
 * → run
 * → coordinator/lease
 * → phase record
 * → append-only child records
 *
 * Sort IDs before acquiring multiple row locks.
 */
export const LOCK_ORDER = [
  "control-plane",
  "run",
  "coordinator",
  "phase-record",
  "append-only-child",
] as const;
