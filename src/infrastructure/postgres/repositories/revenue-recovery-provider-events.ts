import type { PostgresDatabase } from "../database.js";
import {
  parseRecoveryProviderEvent,
  type RecoveryProviderEvent,
  type RecoveryProviderEventRepository,
} from "../../../revenue-recovery/provider-events.js";

export class PostgresRecoveryProviderEventRepository
  implements RecoveryProviderEventRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getByProviderEventKey(input: {
    providerName: string;
    providerEventKey: string;
  }): Promise<RecoveryProviderEvent | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_provider_events
       WHERE provider_name = $1 AND provider_event_key = $2
       LIMIT 1`,
      [input.providerName, input.providerEventKey],
    );
    return res.rows[0]
      ? parseRecoveryProviderEvent(res.rows[0].payload)
      : null;
  }

  async save(event: RecoveryProviderEvent): Promise<void> {
    const parsed = parseRecoveryProviderEvent(event);
    await this.db.query(
      `INSERT INTO revenue_recovery_provider_events (
         provider_event_id, provider_name, provider_event_key,
         provider_message_id, event_kind, attempt_id, recovery_case_id,
         lead_id, customer_account_id, project_id, occurred_at, payload,
         record_revision
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13)
       ON CONFLICT (provider_event_id) DO NOTHING`,
      [
        parsed.providerEventId,
        parsed.providerName,
        parsed.providerEventKey,
        parsed.providerMessageId ?? null,
        parsed.eventKind,
        parsed.attemptId ?? null,
        parsed.recoveryCaseId ?? null,
        parsed.leadId ?? null,
        parsed.customerAccountId ?? null,
        parsed.projectId ?? null,
        parsed.occurredAt,
        JSON.stringify(parsed),
        parsed.recordRevision,
      ],
    );
  }
}
