import type { OutboxMessage, OutboxStatus } from "../../domain/durability/index.js";
import { DurabilityError } from "../../durability/errors.js";
import type { PostgresDatabase } from "./database.js";

function mapOutbox(row: {
  outbox_id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  created_at: Date;
  available_at: Date;
  status: string;
  attempt_count: number;
  lease_owner_id: string | null;
  fence_token: string | number | null;
  lease_expires_at: Date | null;
  delivered_at: Date | null;
}): OutboxMessage {
  const message: OutboxMessage = {
    outboxId: row.outbox_id,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    createdAt: row.created_at.toISOString(),
    availableAt: row.available_at.toISOString(),
    status: row.status as OutboxStatus,
    attemptCount: row.attempt_count,
  };
  if (row.lease_owner_id) {
    message.leaseOwnerId = row.lease_owner_id;
  }
  if (row.fence_token !== null) {
    message.fenceToken = Number(row.fence_token);
  }
  if (row.lease_expires_at) {
    message.leaseExpiresAt = row.lease_expires_at.toISOString();
  }
  if (row.delivered_at) {
    message.deliveredAt = row.delivered_at.toISOString();
  }
  return message;
}

export class PostgresTransactionalOutbox {
  constructor(private readonly db: PostgresDatabase) {}

  async enqueue(input: {
    outboxId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: unknown;
  }): Promise<OutboxMessage> {
    const result = await this.db.query<{
      outbox_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: unknown;
      created_at: Date;
      available_at: Date;
      status: string;
      attempt_count: number;
      lease_owner_id: string | null;
      fence_token: string | number | null;
      lease_expires_at: Date | null;
      delivered_at: Date | null;
    }>(
      `INSERT INTO transactional_outbox (
         outbox_id, aggregate_type, aggregate_id, event_type, payload, status
       ) VALUES ($1, $2, $3, $4, $5::jsonb, 'PENDING')
       RETURNING *`,
      [
        input.outboxId,
        input.aggregateType,
        input.aggregateId,
        input.eventType,
        JSON.stringify(input.payload),
      ],
    );
    return mapOutbox(result.rows[0]!);
  }

  async claimBatch(input: {
    ownerId: string;
    limit: number;
    leaseSeconds?: number;
  }): Promise<OutboxMessage[]> {
    const leaseSeconds = input.leaseSeconds ?? 30;
    const result = await this.db.query<{
      outbox_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: unknown;
      created_at: Date;
      available_at: Date;
      status: string;
      attempt_count: number;
      lease_owner_id: string | null;
      fence_token: string | number | null;
      lease_expires_at: Date | null;
      delivered_at: Date | null;
    }>(
      `WITH claimed AS (
         SELECT outbox_id
         FROM transactional_outbox
         WHERE status IN ('PENDING', 'LEASED')
           AND available_at <= NOW()
           AND (status = 'PENDING' OR lease_expires_at < NOW())
         ORDER BY created_at ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE transactional_outbox AS o
       SET status = 'LEASED',
           lease_owner_id = $1,
           fence_token = COALESCE(o.fence_token, 0) + 1,
           lease_expires_at = NOW() + make_interval(secs => $3),
           attempt_count = o.attempt_count + 1
       FROM claimed
       WHERE o.outbox_id = claimed.outbox_id
       RETURNING o.*`,
      [input.ownerId, input.limit, leaseSeconds],
    );
    return result.rows.map(mapOutbox);
  }

  async markDelivered(outboxId: string, ownerId: string, fenceToken: number): Promise<void> {
    const result = await this.db.query(
      `UPDATE transactional_outbox
       SET status = 'DELIVERED', delivered_at = NOW()
       WHERE outbox_id = $1 AND lease_owner_id = $2 AND fence_token = $3`,
      [outboxId, ownerId, fenceToken],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "OUTBOX_DELIVERY_FAILED",
        `Could not mark outbox ${outboxId} delivered`,
      );
    }
  }

  async markFailed(outboxId: string, ownerId: string, fenceToken: number): Promise<void> {
    await this.db.query(
      `UPDATE transactional_outbox
       SET status = 'PENDING', available_at = NOW() + INTERVAL '5 seconds'
       WHERE outbox_id = $1 AND lease_owner_id = $2 AND fence_token = $3`,
      [outboxId, ownerId, fenceToken],
    );
  }

  async listByAggregate(aggregateId: string): Promise<OutboxMessage[]> {
    const result = await this.db.query<{
      outbox_id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: unknown;
      created_at: Date;
      available_at: Date;
      status: string;
      attempt_count: number;
      lease_owner_id: string | null;
      fence_token: string | number | null;
      lease_expires_at: Date | null;
      delivered_at: Date | null;
    }>(
      `SELECT * FROM transactional_outbox WHERE aggregate_id = $1 ORDER BY created_at ASC`,
      [aggregateId],
    );
    return result.rows.map(mapOutbox);
  }
}

export interface OutboxConsumer {
  consume(message: OutboxMessage): Promise<void>;
}

/**
 * AT LEAST ONCE local dispatcher. Consumers must be idempotent.
 * Does not claim exactly-once delivery.
 */
export class LocalOutboxDispatcher {
  constructor(
    private readonly outbox: PostgresTransactionalOutbox,
    private readonly ownerId: string,
    private readonly consumer: OutboxConsumer,
  ) {}

  async dispatchOnce(limit = 10): Promise<{ delivered: number; failed: number }> {
    const claimed = await this.outbox.claimBatch({
      ownerId: this.ownerId,
      limit,
    });
    let delivered = 0;
    let failed = 0;
    for (const message of claimed) {
      try {
        await this.consumer.consume(message);
        await this.outbox.markDelivered(
          message.outboxId,
          this.ownerId,
          message.fenceToken ?? 0,
        );
        delivered += 1;
      } catch {
        await this.outbox.markFailed(
          message.outboxId,
          this.ownerId,
          message.fenceToken ?? 0,
        );
        failed += 1;
      }
    }
    return { delivered, failed };
  }
}
