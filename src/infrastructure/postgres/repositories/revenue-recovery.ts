import type { PostgresDatabase } from "../database.js";
import {
  parseLead,
  type Lead,
} from "../../../revenue-recovery/lead.js";
import {
  parseLeadEvent,
  type LeadEvent,
} from "../../../revenue-recovery/recovery-event.js";
import {
  parseRecoveryCase,
  type RecoveryCase,
} from "../../../revenue-recovery/recovery-case.js";
import {
  parseRecoveryConfiguration,
  type RecoveryConfiguration,
} from "../../../revenue-recovery/recovery-config.js";
import {
  parseRecoveryAttempt,
  type RecoveryAttempt,
} from "../../../revenue-recovery/recovery-attempt.js";
import {
  parseRevenueAttribution,
  type RevenueAttribution,
} from "../../../revenue-recovery/revenue-attribution.js";
import {
  parseRevenueRecoveryRecord,
  type RevenueRecoveryRecord,
} from "../../../revenue-recovery/recovery-record.js";
import {
  parseRecoveryMessageTemplate,
  type RecoveryMessageTemplate,
} from "../../../revenue-recovery/recovery-template.js";
import type { ProductAuditEvent } from "../../../revenue-recovery/audit.js";
import type {
  LeadEventRepository,
  LeadRepository,
  ProductAuditRepository,
  RecoveryAttemptRepository,
  RecoveryCaseRepository,
  RecoveryConfigRepository,
  RecoveryTemplateRepository,
  RevenueAttributionRepository,
  RevenueRecoveryRecordRepository,
} from "../../../revenue-recovery/repositories.js";

export class PostgresLeadRepository implements LeadRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getById(leadId: string): Promise<Lead | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_leads WHERE lead_id = $1`,
      [leadId],
    );
    return res.rows[0] ? parseLead(res.rows[0].payload) : null;
  }

  async getBySourceIdentity(input: {
    customerAccountId: string;
    source: string;
    externalLeadId: string;
  }): Promise<Lead | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_leads
       WHERE customer_account_id = $1 AND source = $2 AND external_lead_id = $3`,
      [input.customerAccountId, input.source, input.externalLeadId],
    );
    return res.rows[0] ? parseLead(res.rows[0].payload) : null;
  }

  async save(lead: Lead): Promise<void> {
    const parsed = parseLead(lead);
    await this.db.query(
      `INSERT INTO revenue_recovery_leads (
         lead_id, customer_account_id, project_id, source, external_lead_id,
         material_fingerprint, payload, record_revision, created_at, ingested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       ON CONFLICT (lead_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         record_revision = EXCLUDED.record_revision,
         material_fingerprint = EXCLUDED.material_fingerprint`,
      [
        parsed.leadId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.source,
        parsed.externalLeadId,
        parsed.materialFingerprint,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.createdAt,
        parsed.ingestedAt,
      ],
    );
  }

  async listByProject(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<readonly Lead[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_leads
       WHERE customer_account_id = $1 AND project_id = $2`,
      [input.customerAccountId, input.projectId],
    );
    return res.rows.map((r) => parseLead(r.payload));
  }
}

export class PostgresLeadEventRepository implements LeadEventRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getById(eventId: string): Promise<LeadEvent | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_lead_events WHERE event_id = $1`,
      [eventId],
    );
    return res.rows[0] ? parseLeadEvent(res.rows[0].payload) : null;
  }

  async getBySourceIdentity(input: {
    customerAccountId: string;
    leadId: string;
    source: string;
    externalEventId: string;
  }): Promise<LeadEvent | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_lead_events
       WHERE customer_account_id = $1 AND lead_id = $2 AND source = $3 AND external_event_id = $4`,
      [
        input.customerAccountId,
        input.leadId,
        input.source,
        input.externalEventId,
      ],
    );
    return res.rows[0] ? parseLeadEvent(res.rows[0].payload) : null;
  }

  async append(event: LeadEvent): Promise<void> {
    const parsed = parseLeadEvent(event);
    await this.db.query(
      `INSERT INTO revenue_recovery_lead_events (
         event_id, lead_id, customer_account_id, project_id, kind, source,
         external_event_id, occurred_at, payload, record_revision, recorded_at,
         trust_provenance
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        parsed.eventId,
        parsed.leadId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.kind,
        parsed.source,
        parsed.externalEventId,
        parsed.occurredAt,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.recordedAt,
        parsed.trustProvenance,
      ],
    );
  }

  async listByLead(leadId: string): Promise<readonly LeadEvent[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_lead_events
       WHERE lead_id = $1 ORDER BY occurred_at ASC`,
      [leadId],
    );
    return res.rows.map((r) => parseLeadEvent(r.payload));
  }
}

export class PostgresRecoveryCaseRepository implements RecoveryCaseRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async getById(recoveryCaseId: string): Promise<RecoveryCase | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_cases WHERE recovery_case_id = $1`,
      [recoveryCaseId],
    );
    return res.rows[0] ? parseRecoveryCase(res.rows[0].payload) : null;
  }

  async getByGapIdentity(gapIdentityKey: string): Promise<RecoveryCase | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_cases WHERE gap_identity_key = $1`,
      [gapIdentityKey],
    );
    return res.rows[0] ? parseRecoveryCase(res.rows[0].payload) : null;
  }

  async getByOrchestratorRunId(runId: string): Promise<RecoveryCase | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_cases
       WHERE payload->>'orchestratorRunId' = $1`,
      [runId],
    );
    if (res.rows.length > 1) {
      return null;
    }
    return res.rows[0] ? parseRecoveryCase(res.rows[0].payload) : null;
  }

  async listOpenByLead(leadId: string): Promise<readonly RecoveryCase[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_cases
       WHERE lead_id = $1 AND status NOT IN ('CLOSED_UNRECOVERED','SUPPRESSED','CONVERTED')`,
      [leadId],
    );
    return res.rows.map((r) => parseRecoveryCase(r.payload));
  }

  async listByProject(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<readonly RecoveryCase[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_cases
       WHERE customer_account_id = $1 AND project_id = $2`,
      [input.customerAccountId, input.projectId],
    );
    return res.rows.map((r) => parseRecoveryCase(r.payload));
  }

  async save(recoveryCase: RecoveryCase): Promise<void> {
    const parsed = parseRecoveryCase(recoveryCase);
    await this.db.query(
      `INSERT INTO revenue_recovery_cases (
         recovery_case_id, gap_identity_key, lead_id, customer_account_id, project_id,
         status, payload, record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       ON CONFLICT (recovery_case_id) DO UPDATE SET
         status = EXCLUDED.status,
         payload = EXCLUDED.payload,
         record_revision = EXCLUDED.record_revision,
         updated_at = EXCLUDED.updated_at`,
      [
        parsed.recoveryCaseId,
        parsed.gapIdentityKey,
        parsed.leadId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.createdAt,
        parsed.updatedAt,
      ],
    );
  }
}

export class PostgresRecoveryConfigRepository
  implements RecoveryConfigRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getLatest(input: {
    customerAccountId: string;
    projectId: string;
  }): Promise<RecoveryConfiguration | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_config
       WHERE customer_account_id = $1 AND project_id = $2
       ORDER BY config_version DESC LIMIT 1`,
      [input.customerAccountId, input.projectId],
    );
    return res.rows[0]
      ? parseRecoveryConfiguration(res.rows[0].payload)
      : null;
  }

  async getByVersion(input: {
    customerAccountId: string;
    projectId: string;
    configVersion: number;
  }): Promise<RecoveryConfiguration | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_config
       WHERE customer_account_id = $1 AND project_id = $2 AND config_version = $3`,
      [input.customerAccountId, input.projectId, input.configVersion],
    );
    return res.rows[0]
      ? parseRecoveryConfiguration(res.rows[0].payload)
      : null;
  }

  async save(config: RecoveryConfiguration): Promise<void> {
    const parsed = parseRecoveryConfiguration(config);
    await this.db.query(
      `INSERT INTO revenue_recovery_config (
         config_id, customer_account_id, project_id, config_version,
         config_fingerprint, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
       ON CONFLICT (config_id) DO NOTHING`,
      [
        parsed.configId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.configVersion,
        parsed.configFingerprint,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
  }
}

export class PostgresRecoveryAttemptRepository
  implements RecoveryAttemptRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(attemptId: string): Promise<RecoveryAttempt | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_attempts WHERE attempt_id = $1`,
      [attemptId],
    );
    return res.rows[0] ? parseRecoveryAttempt(res.rows[0].payload) : null;
  }

  async getByExecutionActionIdentity(
    identity: string,
  ): Promise<RecoveryAttempt | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_attempts
       WHERE execution_action_identity = $1
          OR payload->>'executionActionIdentity' = $1
       LIMIT 1`,
      [identity],
    );
    return res.rows[0] ? parseRecoveryAttempt(res.rows[0].payload) : null;
  }

  async getByProviderMessageId(
    providerMessageId: string,
  ): Promise<RecoveryAttempt | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_attempts
       WHERE provider_message_id = $1
          OR payload->>'providerMessageId' = $1
       LIMIT 1`,
      [providerMessageId],
    );
    return res.rows[0] ? parseRecoveryAttempt(res.rows[0].payload) : null;
  }

  async listByCase(recoveryCaseId: string): Promise<readonly RecoveryAttempt[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_attempts
       WHERE recovery_case_id = $1 ORDER BY sent_at ASC`,
      [recoveryCaseId],
    );
    return res.rows.map((r) => parseRecoveryAttempt(r.payload));
  }

  async save(attempt: RecoveryAttempt): Promise<void> {
    const parsed = parseRecoveryAttempt(attempt);
    await this.db.query(
      `INSERT INTO revenue_recovery_attempts (
         attempt_id, recovery_case_id, lead_id, customer_account_id, project_id,
         channel, sent_at, payload, record_revision, execution_action_identity,
         provider_message_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       ON CONFLICT (attempt_id) DO UPDATE SET
         payload = EXCLUDED.payload,
         record_revision = EXCLUDED.record_revision,
         provider_message_id = EXCLUDED.provider_message_id`,
      [
        parsed.attemptId,
        parsed.recoveryCaseId,
        parsed.leadId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.channel,
        parsed.sentAt,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.executionActionIdentity,
        parsed.providerMessageId ?? null,
      ],
    );
  }
}

export class PostgresRevenueAttributionRepository
  implements RevenueAttributionRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(attributionId: string): Promise<RevenueAttribution | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_attributions WHERE attribution_id = $1`,
      [attributionId],
    );
    return res.rows[0] ? parseRevenueAttribution(res.rows[0].payload) : null;
  }

  async listByCase(
    recoveryCaseId: string,
  ): Promise<readonly RevenueAttribution[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_attributions WHERE recovery_case_id = $1`,
      [recoveryCaseId],
    );
    return res.rows.map((r) => parseRevenueAttribution(r.payload));
  }

  async save(attribution: RevenueAttribution): Promise<void> {
    const parsed = parseRevenueAttribution(attribution);
    await this.db.query(
      `INSERT INTO revenue_recovery_attributions (
         attribution_id, recovery_case_id, lead_id, customer_account_id, project_id,
         attribution_type, confidence_class, amount, currency, payload,
         attributed_at, record_revision, trust_provenance
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
       ON CONFLICT (attribution_id) DO NOTHING`,
      [
        parsed.attributionId,
        parsed.recoveryCaseId,
        parsed.leadId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.attributionType,
        parsed.confidenceClass,
        parsed.amount,
        parsed.currency,
        JSON.stringify(parsed),
        parsed.attributedAt,
        parsed.recordRevision,
        parsed.trustProvenance,
      ],
    );
  }
}

export class PostgresRevenueRecoveryRecordRepository
  implements RevenueRecoveryRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getByCase(
    recoveryCaseId: string,
  ): Promise<RevenueRecoveryRecord | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_records WHERE recovery_case_id = $1`,
      [recoveryCaseId],
    );
    return res.rows[0]
      ? parseRevenueRecoveryRecord(res.rows[0].payload)
      : null;
  }

  async save(record: RevenueRecoveryRecord): Promise<void> {
    const parsed = parseRevenueRecoveryRecord(record);
    await this.db.query(
      `INSERT INTO revenue_recovery_records (
         recovery_record_id, recovery_case_id, lead_id, customer_account_id,
         project_id, record_hash, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (recovery_case_id) DO NOTHING`,
      [
        parsed.recoveryRecordId,
        parsed.recoveryCaseId,
        parsed.leadId,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.recordHash,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
  }
}

export class PostgresRecoveryTemplateRepository
  implements RecoveryTemplateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async get(input: {
    templateId: string;
    version: number;
  }): Promise<RecoveryMessageTemplate | null> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_templates
       WHERE template_id = $1 AND version = $2`,
      [input.templateId, input.version],
    );
    return res.rows[0]
      ? parseRecoveryMessageTemplate(res.rows[0].payload)
      : null;
  }

  async listEnabled(input: {
    customerAccountId: string;
    projectId: string;
    channel: "SMS" | "EMAIL";
  }): Promise<readonly RecoveryMessageTemplate[]> {
    const res = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM revenue_recovery_templates
       WHERE customer_account_id = $1 AND project_id = $2
         AND channel = $3 AND enabled = TRUE`,
      [input.customerAccountId, input.projectId, input.channel],
    );
    return res.rows.map((r) => parseRecoveryMessageTemplate(r.payload));
  }

  async save(template: RecoveryMessageTemplate): Promise<void> {
    const parsed = parseRecoveryMessageTemplate(template);
    await this.db.query(
      `INSERT INTO revenue_recovery_templates (
         template_id, version, customer_account_id, project_id, channel,
         enabled, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (template_id, version) DO NOTHING`,
      [
        parsed.templateId,
        parsed.version,
        parsed.customerAccountId,
        parsed.projectId,
        parsed.channel,
        parsed.enabled,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
  }
}

export class PostgresProductAuditRepository implements ProductAuditRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async append(event: ProductAuditEvent): Promise<void> {
    await this.db.query(
      `INSERT INTO revenue_recovery_audit_events (
         event_id, kind, customer_account_id, project_id, lead_id,
         recovery_case_id, occurred_at, payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (event_id) DO NOTHING`,
      [
        event.eventId,
        event.kind,
        event.customerAccountId,
        event.projectId,
        event.leadId ?? null,
        event.recoveryCaseId ?? null,
        event.occurredAt,
        JSON.stringify(event),
      ],
    );
  }

  async listByCase(
    recoveryCaseId: string,
  ): Promise<readonly ProductAuditEvent[]> {
    const res = await this.db.query<{ payload: ProductAuditEvent }>(
      `SELECT payload FROM revenue_recovery_audit_events
       WHERE recovery_case_id = $1 ORDER BY occurred_at ASC`,
      [recoveryCaseId],
    );
    return res.rows.map((r) => r.payload);
  }
}
