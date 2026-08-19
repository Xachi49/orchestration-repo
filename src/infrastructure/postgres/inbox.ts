import type { InboxRecord } from "../../domain/durability/index.js";
import type { PostgresDatabase } from "./database.js";

/**
 * Durable request/message dedup. Duplicate delivery reuses the previous
 * processing identity. Inbox is not authorization.
 */
export class PostgresInbox {
  constructor(private readonly db: PostgresDatabase) {}

  async receive(input: {
    messageId: string;
    consumerName: string;
    payload?: unknown;
  }): Promise<{ duplicate: boolean; record: InboxRecord }> {
    const existing = await this.get(input.messageId, input.consumerName);
    if (existing) {
      return { duplicate: true, record: existing };
    }
    await this.db.query(
      `INSERT INTO durable_inbox (message_id, consumer_name, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (message_id, consumer_name) DO NOTHING`,
      [
        input.messageId,
        input.consumerName,
        input.payload !== undefined ? JSON.stringify(input.payload) : null,
      ],
    );
    const record = await this.get(input.messageId, input.consumerName);
    return { duplicate: false, record: record! };
  }

  async complete(input: {
    messageId: string;
    consumerName: string;
    resultFingerprint: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE durable_inbox
       SET processed_at = NOW(), result_fingerprint = $3
       WHERE message_id = $1 AND consumer_name = $2`,
      [input.messageId, input.consumerName, input.resultFingerprint],
    );
  }

  async get(
    messageId: string,
    consumerName: string,
  ): Promise<InboxRecord | null> {
    const result = await this.db.query<{
      message_id: string;
      consumer_name: string;
      received_at: Date;
      processed_at: Date | null;
      result_fingerprint: string | null;
    }>(
      `SELECT message_id, consumer_name, received_at, processed_at, result_fingerprint
       FROM durable_inbox WHERE message_id = $1 AND consumer_name = $2`,
      [messageId, consumerName],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const record: InboxRecord = {
      messageId: row.message_id,
      consumerName: row.consumer_name,
      receivedAt: row.received_at.toISOString(),
    };
    if (row.processed_at) {
      record.processedAt = row.processed_at.toISOString();
    }
    if (row.result_fingerprint) {
      record.resultFingerprint = row.result_fingerprint;
    }
    return record;
  }
}
