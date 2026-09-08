import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import { FederationError } from "../../../federation/errors.js";
import {
  FederationAgreementSchema,
  type FederationAgreement,
} from "../../../federation/agreement.js";
import {
  FederationActivationRecordSchema,
  type FederationActivationRecord,
} from "../../../federation/agreement-activation.js";
import type { FederationAuditEvent } from "../../../federation/audit.js";
import {
  FederatedEvidenceEnvelopeSchema,
  type FederatedEvidenceEnvelope,
} from "../../../federation/evidence-envelope.js";
import {
  FederationParticipationChangeSchema,
  type FederationParticipationChange,
} from "../../../federation/participation.js";
import {
  FederationRatificationSchema,
  type FederationRatification,
} from "../../../federation/ratification.js";
import {
  FederatedWorkAcceptanceSchema,
  type FederatedWorkAcceptance,
} from "../../../federation/work-acceptance.js";
import {
  FederatedWorkIntentSchema,
  type FederatedWorkIntent,
} from "../../../federation/work-intent.js";
import {
  FederatedMaterializationRecordSchema,
  materializationIdempotencyKey,
  type FederatedMaterializationRecord,
} from "../../../federation/work-materialization.js";
import type {
  FederationActivationRecordRepository,
  FederationAgreementRepository,
  FederationAuditRepository,
  FederationParticipationChangeRepository,
  FederationRatificationRepository,
  FederatedEvidenceEnvelopeRepository,
  FederatedMaterializationRepository,
  FederatedWorkAcceptanceRepository,
  FederatedWorkIntentRepository,
} from "../../../federation/repositories.js";

export class PostgresFederationAgreementRepository
  implements FederationAgreementRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(agreement: FederationAgreement): Promise<FederationAgreement> {
    const parsed = FederationAgreementSchema.parse(agreement);
    const now = new Date().toISOString();
    try {
      await this.db.query(
        `INSERT INTO federation_agreements (
           agreement_id, federation_id, agreement_version, agreement_hash,
           status, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$9::timestamptz)
         ON CONFLICT (agreement_id) DO UPDATE
         SET federation_id = EXCLUDED.federation_id,
             agreement_version = EXCLUDED.agreement_version,
             agreement_hash = EXCLUDED.agreement_hash,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.agreementId,
          parsed.federationId,
          parsed.agreementVersion,
          parsed.agreementHash,
          parsed.status,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
          now,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(agreementId: string): Promise<FederationAgreement | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM federation_agreements
       WHERE agreement_id = $1`,
      [agreementId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return FederationAgreementSchema.parse({
      ...hydrateRecord(
        (i) => FederationAgreementSchema.parse(i),
        row.payload,
        "federation_agreements",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async getByFederationId(
    federationId: string,
  ): Promise<FederationAgreement | null> {
    const result = await this.db.query<{ payload: unknown; record_revision: string | number }>(
      `SELECT payload, record_revision FROM federation_agreements
       WHERE federation_id = $1
       ORDER BY agreement_version DESC LIMIT 1`,
      [federationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return FederationAgreementSchema.parse({
      ...hydrateRecord(
        (i) => FederationAgreementSchema.parse(i),
        row.payload,
        "federation_agreements",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async listByFederation(federationId: string): Promise<FederationAgreement[]> {
    const result = await this.db.query<{ payload: unknown; record_revision: string | number }>(
      `SELECT payload, record_revision FROM federation_agreements
       WHERE federation_id = $1 ORDER BY agreement_version ASC`,
      [federationId],
    );
    return result.rows.map((row) =>
      FederationAgreementSchema.parse({
        ...hydrateRecord(
          (i) => FederationAgreementSchema.parse(i),
          row.payload,
          "federation_agreements",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async getActiveByFederation(
    federationId: string,
  ): Promise<FederationAgreement | null> {
    const result = await this.db.query<{ payload: unknown; record_revision: string | number }>(
      `SELECT payload, record_revision FROM federation_agreements
       WHERE federation_id = $1 AND status = 'ACTIVE' LIMIT 1`,
      [federationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return FederationAgreementSchema.parse({
      ...hydrateRecord(
        (i) => FederationAgreementSchema.parse(i),
        row.payload,
        "federation_agreements",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async transition(
    agreementId: string,
    fromStatus: FederationAgreement["status"],
    expectedRevision: number,
    toStatus: FederationAgreement["status"],
    updatedAt: string,
    patch?: Partial<FederationAgreement>,
  ): Promise<FederationAgreement> {
    const existing = await this.getById(agreementId);
    if (!existing) {
      throw new FederationError(
        "FEDERATION_NOT_FOUND",
        `Agreement ${agreementId} not found`,
      );
    }
    if (existing.status !== fromStatus || existing.recordRevision !== expectedRevision) {
      throw new FederationError(
        "FEDERATION_CAS_CONFLICT",
        `Agreement ${agreementId} CAS conflict`,
      );
    }
    const next = FederationAgreementSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE federation_agreements
       SET status = $2, payload = $3::jsonb, record_revision = $4, updated_at = $5::timestamptz
       WHERE agreement_id = $1 AND status = $6 AND record_revision = $7`,
      [
        agreementId,
        next.status,
        JSON.stringify(next),
        next.recordRevision,
        updatedAt,
        fromStatus,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new FederationError(
        "FEDERATION_CAS_CONFLICT",
        `Agreement ${agreementId} concurrent update`,
      );
    }
    return next;
  }
}

export class PostgresFederationRatificationRepository
  implements FederationRatificationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(r: FederationRatification): Promise<FederationRatification> {
    const parsed = FederationRatificationSchema.parse(r);
    try {
      await this.db.query(
        `INSERT INTO federation_ratifications (
           ratification_id, federation_id, agreement_id, institution_id,
           ratification_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
         ON CONFLICT (agreement_id, institution_id) DO NOTHING`,
        [
          parsed.ratificationId,
          parsed.federationId,
          parsed.agreementId,
          parsed.institutionId,
          parsed.ratificationHash,
          JSON.stringify(parsed),
          parsed.ratifiedAt,
        ],
      );
      const existing = await this.getByAgreementAndInstitution(
        parsed.agreementId,
        parsed.institutionId,
      );
      return existing ?? parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(ratificationId: string): Promise<FederationRatification | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federation_ratifications WHERE ratification_id = $1`,
      [ratificationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederationRatificationSchema.parse(i),
      row.payload,
      "federation_ratifications",
    );
  }

  async listByAgreement(agreementId: string): Promise<FederationRatification[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federation_ratifications
       WHERE agreement_id = $1 ORDER BY institution_id ASC`,
      [agreementId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => FederationRatificationSchema.parse(i),
        row.payload,
        "federation_ratifications",
      ),
    );
  }

  async getByAgreementAndInstitution(
    agreementId: string,
    institutionId: string,
  ): Promise<FederationRatification | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federation_ratifications
       WHERE agreement_id = $1 AND institution_id = $2`,
      [agreementId, institutionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederationRatificationSchema.parse(i),
      row.payload,
      "federation_ratifications",
    );
  }
}

export class PostgresFederationActivationRecordRepository
  implements FederationActivationRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(r: FederationActivationRecord): Promise<FederationActivationRecord> {
    const parsed = FederationActivationRecordSchema.parse(r);
    try {
      await this.db.query(
        `INSERT INTO federation_activation_records (
           activation_record_id, federation_id, agreement_id, activation_hash,
           payload, created_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
         ON CONFLICT (agreement_id) DO NOTHING`,
        [
          parsed.activationRecordId,
          parsed.federationId,
          parsed.agreementId,
          parsed.activationHash,
          JSON.stringify(parsed),
          parsed.activatedAt,
        ],
      );
      const existing = await this.getByAgreement(parsed.agreementId);
      return existing ?? parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(id: string): Promise<FederationActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federation_activation_records WHERE activation_record_id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederationActivationRecordSchema.parse(i),
      row.payload,
      "federation_activation_records",
    );
  }

  async getByAgreement(
    agreementId: string,
  ): Promise<FederationActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federation_activation_records WHERE agreement_id = $1`,
      [agreementId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederationActivationRecordSchema.parse(i),
      row.payload,
      "federation_activation_records",
    );
  }
}

export class PostgresFederationParticipationChangeRepository
  implements FederationParticipationChangeRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    c: FederationParticipationChange,
  ): Promise<FederationParticipationChange> {
    const parsed = FederationParticipationChangeSchema.parse(c);
    await this.db.query(
      `INSERT INTO federation_participation_changes (
         change_id, federation_id, agreement_id, institution_id, change_hash,
         payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
      [
        parsed.changeId,
        parsed.federationId,
        parsed.agreementId,
        parsed.institutionId,
        parsed.changeHash,
        JSON.stringify(parsed),
        parsed.effectiveAt,
      ],
    );
    return parsed;
  }

  async listByAgreement(
    agreementId: string,
  ): Promise<FederationParticipationChange[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federation_participation_changes
       WHERE agreement_id = $1 ORDER BY created_at ASC`,
      [agreementId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => FederationParticipationChangeSchema.parse(i),
        row.payload,
        "federation_participation_changes",
      ),
    );
  }
}

export class PostgresFederatedWorkIntentRepository
  implements FederatedWorkIntentRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(intent: FederatedWorkIntent): Promise<FederatedWorkIntent> {
    const parsed = FederatedWorkIntentSchema.parse(intent);
    const now = new Date().toISOString();
    await this.db.query(
      `INSERT INTO federated_work_intents (
         intent_id, federation_id, agreement_id, intent_hash, status,
         payload, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz,$8::timestamptz)
       ON CONFLICT (intent_id) DO UPDATE
       SET status = EXCLUDED.status, payload = EXCLUDED.payload,
           intent_hash = EXCLUDED.intent_hash, updated_at = EXCLUDED.updated_at`,
      [
        parsed.intentId,
        parsed.federationId,
        parsed.agreementId,
        parsed.intentHash,
        parsed.status,
        JSON.stringify(parsed),
        parsed.createdAt,
        now,
      ],
    );
    return parsed;
  }

  async getById(intentId: string): Promise<FederatedWorkIntent | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federated_work_intents WHERE intent_id = $1`,
      [intentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederatedWorkIntentSchema.parse(i),
      row.payload,
      "federated_work_intents",
    );
  }

  async updateStatus(
    intentId: string,
    fromStatus: FederatedWorkIntent["status"],
    toStatus: FederatedWorkIntent["status"],
  ): Promise<FederatedWorkIntent> {
    const existing = await this.getById(intentId);
    if (!existing) {
      throw new FederationError(
        "FEDERATED_INTENT_INVALID",
        `Intent ${intentId} not found`,
      );
    }
    if (existing.status !== fromStatus) {
      throw new FederationError(
        "FEDERATION_CAS_CONFLICT",
        `Intent ${intentId} status mismatch`,
      );
    }
    const next = FederatedWorkIntentSchema.parse({
      ...existing,
      status: toStatus,
    });
    const result = await this.db.query(
      `UPDATE federated_work_intents
       SET status = $2, payload = $3::jsonb, updated_at = NOW()
       WHERE intent_id = $1 AND status = $4`,
      [intentId, toStatus, JSON.stringify(next), fromStatus],
    );
    if (result.rowCount !== 1) {
      throw new FederationError(
        "FEDERATION_CAS_CONFLICT",
        `Intent ${intentId} concurrent update`,
      );
    }
    return next;
  }
}

export class PostgresFederatedWorkAcceptanceRepository
  implements FederatedWorkAcceptanceRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(a: FederatedWorkAcceptance): Promise<FederatedWorkAcceptance> {
    const parsed = FederatedWorkAcceptanceSchema.parse(a);
    await this.db.query(
      `INSERT INTO federated_work_acceptances (
         acceptance_id, intent_id, acceptance_hash, payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (intent_id) DO NOTHING`,
      [
        parsed.acceptanceId,
        parsed.intentId,
        parsed.acceptanceHash,
        JSON.stringify(parsed),
        parsed.decidedAt,
      ],
    );
    const existing = await this.getByIntent(parsed.intentId);
    return existing ?? parsed;
  }

  async getByIntent(intentId: string): Promise<FederatedWorkAcceptance | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federated_work_acceptances WHERE intent_id = $1`,
      [intentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederatedWorkAcceptanceSchema.parse(i),
      row.payload,
      "federated_work_acceptances",
    );
  }
}

export class PostgresFederatedMaterializationRepository
  implements FederatedMaterializationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    r: FederatedMaterializationRecord,
  ): Promise<FederatedMaterializationRecord> {
    const parsed = FederatedMaterializationRecordSchema.parse(r);
    const key = materializationIdempotencyKey({
      intentId: parsed.intentId,
      intentHash: parsed.intentHash,
      targetProjectId: parsed.targetProjectId,
      environment: parsed.environment,
    });
    await this.db.query(
      `INSERT INTO federated_materializations (
         materialization_id, intent_id, materialization_hash, idempotency_key,
         payload, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        parsed.materializationId,
        parsed.intentId,
        parsed.materializationHash,
        key,
        JSON.stringify(parsed),
        parsed.materializedAt,
      ],
    );
    const existing = await this.getByIdempotencyKey(key);
    return existing ?? parsed;
  }

  async getByIntent(
    intentId: string,
  ): Promise<FederatedMaterializationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federated_materializations WHERE intent_id = $1`,
      [intentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederatedMaterializationRecordSchema.parse(i),
      row.payload,
      "federated_materializations",
    );
  }

  async getByIdempotencyKey(
    key: string,
  ): Promise<FederatedMaterializationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federated_materializations WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederatedMaterializationRecordSchema.parse(i),
      row.payload,
      "federated_materializations",
    );
  }
}

export class PostgresFederatedEvidenceEnvelopeRepository
  implements FederatedEvidenceEnvelopeRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(e: FederatedEvidenceEnvelope): Promise<FederatedEvidenceEnvelope> {
    const parsed = FederatedEvidenceEnvelopeSchema.parse(e);
    await this.db.query(
      `INSERT INTO federated_evidence_envelopes (
         envelope_id, federation_id, agreement_id, envelope_hash,
         destination_institution_id, destination_project_id, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)`,
      [
        parsed.envelopeId,
        parsed.federationId,
        parsed.agreementId,
        parsed.envelopeHash,
        parsed.destinationInstitutionId,
        parsed.destinationProjectId,
        JSON.stringify(parsed),
        parsed.sharedAt,
      ],
    );
    return parsed;
  }

  async getById(envelopeId: string): Promise<FederatedEvidenceEnvelope | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federated_evidence_envelopes WHERE envelope_id = $1`,
      [envelopeId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => FederatedEvidenceEnvelopeSchema.parse(i),
      row.payload,
      "federated_evidence_envelopes",
    );
  }

  async listByDestination(
    destinationInstitutionId: string,
    destinationProjectId: string,
  ): Promise<FederatedEvidenceEnvelope[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM federated_evidence_envelopes
       WHERE destination_institution_id = $1 AND destination_project_id = $2`,
      [destinationInstitutionId, destinationProjectId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => FederatedEvidenceEnvelopeSchema.parse(i),
        row.payload,
        "federated_evidence_envelopes",
      ),
    );
  }
}

export class PostgresFederationAuditRepository
  implements FederationAuditRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async append(event: FederationAuditEvent): Promise<FederationAuditEvent> {
    await this.db.query(
      `INSERT INTO federation_audit_events (
         audit_event_id, event_type, federation_id, agreement_id, intent_id,
         institution_id, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)`,
      [
        event.auditEventId,
        event.eventType,
        event.federationId,
        event.agreementId ?? null,
        event.intentId ?? null,
        event.institutionId ?? null,
        JSON.stringify(event.payload),
        event.createdAt,
      ],
    );
    return event;
  }

  async listByFederation(federationId: string): Promise<FederationAuditEvent[]> {
    const result = await this.db.query<{
      audit_event_id: string;
      event_type: string;
      federation_id: string;
      agreement_id: string | null;
      intent_id: string | null;
      institution_id: string | null;
      payload: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT audit_event_id, event_type, federation_id, agreement_id, intent_id,
              institution_id, payload, created_at::text
       FROM federation_audit_events
       WHERE federation_id = $1 ORDER BY created_at ASC`,
      [federationId],
    );
    return result.rows.map((row) => ({
      auditEventId: row.audit_event_id,
      eventType: row.event_type as FederationAuditEvent["eventType"],
      federationId: row.federation_id,
      ...(row.agreement_id ? { agreementId: row.agreement_id } : {}),
      ...(row.intent_id ? { intentId: row.intent_id } : {}),
      ...(row.institution_id ? { institutionId: row.institution_id } : {}),
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }

  async listByAgreement(agreementId: string): Promise<FederationAuditEvent[]> {
    const result = await this.db.query<{
      audit_event_id: string;
      event_type: string;
      federation_id: string;
      agreement_id: string | null;
      intent_id: string | null;
      institution_id: string | null;
      payload: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT audit_event_id, event_type, federation_id, agreement_id, intent_id,
              institution_id, payload, created_at::text
       FROM federation_audit_events
       WHERE agreement_id = $1 ORDER BY created_at ASC`,
      [agreementId],
    );
    return result.rows.map((row) => ({
      auditEventId: row.audit_event_id,
      eventType: row.event_type as FederationAuditEvent["eventType"],
      federationId: row.federation_id,
      ...(row.agreement_id ? { agreementId: row.agreement_id } : {}),
      ...(row.intent_id ? { intentId: row.intent_id } : {}),
      ...(row.institution_id ? { institutionId: row.institution_id } : {}),
      payload: row.payload,
      createdAt: row.created_at,
    }));
  }
}
