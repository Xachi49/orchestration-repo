import type {
  IdempotencyRecord,
  IdempotencyReserveResult,
  IdempotencyStore,
} from "../../admission/idempotency-store.js";

/**
 * In-memory idempotency store.
 * Not distributed and not transactional with run/event persistence.
 * Future durable implementations must enforce unique(key), atomic reserve,
 * and coordinate run persistence, event persistence, and idempotency binding
 * in a single transaction or outbox pattern.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async getByKey(key: string): Promise<IdempotencyRecord | null> {
    return this.records.get(key) ?? null;
  }

  async reserve(
    key: string,
    fingerprint: string,
    reservedAt: string,
  ): Promise<IdempotencyReserveResult> {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return {
          status: "OBJECTIVE_VERSION_CONFLICT",
          runId: existing.runId,
          fingerprint: existing.fingerprint,
        };
      }
      if (existing.status === "COMPLETED") {
        return {
          status: "COMPLETED_DUPLICATE",
          runId: existing.runId,
          fingerprint: existing.fingerprint,
        };
      }
      return {
        status: "ACTIVE_DUPLICATE",
        runId: existing.runId,
        fingerprint: existing.fingerprint,
      };
    }
    this.records.set(key, {
      key,
      fingerprint,
      status: "RESERVED",
      runId: null,
      reservedAt,
      updatedAt: reservedAt,
    });
    return { status: "NEW" };
  }

  async complete(key: string, runId: string, updatedAt: string): Promise<void> {
    const existing = this.records.get(key);
    if (!existing || existing.status !== "RESERVED") {
      throw new Error(`Cannot complete idempotency key ${key}`);
    }
    this.records.set(key, {
      ...existing,
      status: "ACTIVE",
      runId,
      updatedAt,
    });
  }

  async markCompleted(key: string, updatedAt: string): Promise<void> {
    const existing = this.records.get(key);
    if (!existing || existing.status !== "ACTIVE" || existing.runId === null) {
      throw new Error(`Cannot mark idempotency key completed: ${key}`);
    }
    this.records.set(key, {
      ...existing,
      status: "COMPLETED",
      updatedAt,
    });
  }

  async release(key: string): Promise<void> {
    const existing = this.records.get(key);
    if (!existing) {
      return;
    }
    if (existing.status !== "RESERVED") {
      return;
    }
    this.records.delete(key);
  }
}
