import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import { DurabilityError } from "../../../durability/errors.js";
import { ConstitutionalError } from "../../../constitutional/errors.js";
import {
  ConstitutionalChangeProposalSchema,
  type ConstitutionalChangeProposal,
} from "../../../constitutional/proposal.js";
import {
  ConstitutionalImpactAnalysisSchema,
  type ConstitutionalImpactAnalysis,
} from "../../../constitutional/impact-analysis.js";
import {
  ConstitutionalReviewDecisionSchema,
  type ConstitutionalReviewDecision,
} from "../../../constitutional/review.js";
import {
  ConstitutionalActivationRecordSchema,
  mintActivationIdempotencyKey,
  type ConstitutionalActivationRecord,
} from "../../../constitutional/activation.js";
import type {
  ConstitutionalProposalRepository,
  ConstitutionalImpactAnalysisRepository,
  ConstitutionalReviewDecisionRepository,
  ConstitutionalActivationRecordRepository,
  ConstitutionalAuditRepository,
  ConstitutionalAuditEvent,
} from "../../../constitutional/repositories.js";

function isDurableConflict(error: unknown): boolean {
  return error instanceof DurabilityError && error.code === "DURABLE_CONFLICT";
}

export class PostgresConstitutionalProposalRepository
  implements ConstitutionalProposalRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    proposal: ConstitutionalChangeProposal,
  ): Promise<ConstitutionalChangeProposal> {
    const parsed = ConstitutionalChangeProposalSchema.parse(proposal);
    const now = new Date().toISOString();
    try {
      await this.db.query(
        `INSERT INTO constitutional_change_proposals (
           constitutional_change_proposal_id, institution_id, proposal_version,
           proposal_hash, status, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$9::timestamptz)
         ON CONFLICT (constitutional_change_proposal_id) DO UPDATE
         SET institution_id = EXCLUDED.institution_id,
             proposal_version = EXCLUDED.proposal_version,
             proposal_hash = EXCLUDED.proposal_hash,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.constitutionalChangeProposalId,
          parsed.institutionId,
          parsed.proposalVersion,
          parsed.proposalHash,
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

  async getById(
    proposalId: string,
  ): Promise<ConstitutionalChangeProposal | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM constitutional_change_proposals
       WHERE constitutional_change_proposal_id = $1`,
      [proposalId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return ConstitutionalChangeProposalSchema.parse({
      ...hydrateRecord(
        (i) => ConstitutionalChangeProposalSchema.parse(i),
        row.payload,
        "constitutional_change_proposals",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async transition(
    proposalId: string,
    fromStatus: ConstitutionalChangeProposal["status"],
    expectedRevision: number,
    toStatus: ConstitutionalChangeProposal["status"],
    updatedAt: string,
    patch?: Partial<ConstitutionalChangeProposal>,
  ): Promise<ConstitutionalChangeProposal> {
    const existing = await this.getById(proposalId);
    if (!existing) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROPOSAL_NOT_FOUND",
        `Proposal ${proposalId} not found`,
      );
    }
    if (existing.status !== fromStatus) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_CAS_CONFLICT",
        `Proposal ${proposalId} status mismatch`,
      );
    }
    if (existing.recordRevision !== expectedRevision) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_CAS_CONFLICT",
        `Proposal ${proposalId} revision mismatch`,
      );
    }
    const next = ConstitutionalChangeProposalSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    try {
      const result = await this.db.query<{ record_revision: string | number }>(
        `UPDATE constitutional_change_proposals
         SET status = $2,
             payload = $3::jsonb,
             record_revision = $4,
             updated_at = $5::timestamptz,
             proposal_hash = $6
         WHERE constitutional_change_proposal_id = $1
           AND status = $7
           AND record_revision = $8
         RETURNING record_revision`,
        [
          proposalId,
          toStatus,
          JSON.stringify(next),
          next.recordRevision,
          updatedAt,
          next.proposalHash,
          fromStatus,
          expectedRevision,
        ],
      );
      if (result.rowCount !== 1) {
        throw new ConstitutionalError(
          "CONSTITUTIONAL_CAS_CONFLICT",
          `Proposal ${proposalId} CAS transition failed`,
        );
      }
      return next;
    } catch (error) {
      if (isDurableConflict(error)) {
        throw new ConstitutionalError(
          "CONSTITUTIONAL_CAS_CONFLICT",
          `Proposal ${proposalId} durable conflict`,
        );
      }
      throw wrapDatabaseError(error);
    }
  }
}

export class PostgresConstitutionalImpactAnalysisRepository
  implements ConstitutionalImpactAnalysisRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    analysis: ConstitutionalImpactAnalysis,
  ): Promise<ConstitutionalImpactAnalysis> {
    const parsed = ConstitutionalImpactAnalysisSchema.parse(analysis);
    try {
      await this.db.query(
        `INSERT INTO constitutional_impact_analyses (
           impact_analysis_id, proposal_id, analysis_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
         ON CONFLICT (impact_analysis_id) DO UPDATE
         SET proposal_id = EXCLUDED.proposal_id,
             analysis_hash = EXCLUDED.analysis_hash,
             payload = EXCLUDED.payload`,
        [
          parsed.impactAnalysisId,
          parsed.proposalId,
          parsed.analysisHash,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getLatestByProposal(
    proposalId: string,
  ): Promise<ConstitutionalImpactAnalysis | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_impact_analyses
       WHERE proposal_id = $1
       ORDER BY created_at DESC, impact_analysis_id DESC
       LIMIT 1`,
      [proposalId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ConstitutionalImpactAnalysisSchema.parse(i),
          row.payload,
          "constitutional_impact_analyses",
        )
      : null;
  }
}

export class PostgresConstitutionalReviewDecisionRepository
  implements ConstitutionalReviewDecisionRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    decision: ConstitutionalReviewDecision,
  ): Promise<ConstitutionalReviewDecision> {
    const parsed = ConstitutionalReviewDecisionSchema.parse(decision);
    try {
      await this.db.query(
        `INSERT INTO constitutional_review_decisions (
           decision_id, proposal_id, decision_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
         ON CONFLICT (decision_id) DO NOTHING`,
        [
          parsed.decisionId,
          parsed.proposalId,
          parsed.decisionHash,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(
    decisionId: string,
  ): Promise<ConstitutionalReviewDecision | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_review_decisions
       WHERE decision_id = $1`,
      [decisionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ConstitutionalReviewDecisionSchema.parse(i),
          row.payload,
          "constitutional_review_decisions",
        )
      : null;
  }

  async listByProposal(
    proposalId: string,
  ): Promise<ConstitutionalReviewDecision[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_review_decisions
       WHERE proposal_id = $1
       ORDER BY created_at ASC, decision_id ASC`,
      [proposalId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ConstitutionalReviewDecisionSchema.parse(i),
        row.payload,
        "constitutional_review_decisions",
      ),
    );
  }
}

export class PostgresConstitutionalActivationRecordRepository
  implements ConstitutionalActivationRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ConstitutionalActivationRecord,
  ): Promise<ConstitutionalActivationRecord> {
    const parsed = ConstitutionalActivationRecordSchema.parse(record);
    const idempotencyKey = mintActivationIdempotencyKey({
      proposalId: parsed.proposalId,
      proposalVersion: parsed.proposalVersion,
      proposalHash: parsed.proposalHash,
    });
    const now = new Date().toISOString();
    try {
      await this.db.query(
        `INSERT INTO constitutional_activation_records (
           activation_record_id, proposal_id, activation_hash, idempotency_key,
           status, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$9::timestamptz)
         ON CONFLICT (proposal_id) DO UPDATE
         SET activation_hash = EXCLUDED.activation_hash,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at
         WHERE constitutional_activation_records.proposal_id = EXCLUDED.proposal_id`,
        [
          parsed.activationRecordId,
          parsed.proposalId,
          parsed.activationHash,
          idempotencyKey,
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

  async getById(
    recordId: string,
  ): Promise<ConstitutionalActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_activation_records
       WHERE activation_record_id = $1`,
      [recordId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ConstitutionalActivationRecordSchema.parse(i),
          row.payload,
          "constitutional_activation_records",
        )
      : null;
  }

  async getByProposal(
    proposalId: string,
  ): Promise<ConstitutionalActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_activation_records
       WHERE proposal_id = $1`,
      [proposalId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ConstitutionalActivationRecordSchema.parse(i),
          row.payload,
          "constitutional_activation_records",
        )
      : null;
  }

  async getByIdempotencyKey(
    key: string,
  ): Promise<ConstitutionalActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_activation_records
       WHERE idempotency_key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ConstitutionalActivationRecordSchema.parse(i),
          row.payload,
          "constitutional_activation_records",
        )
      : null;
  }
}

export class PostgresConstitutionalAuditRepository
  implements ConstitutionalAuditRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async append(
    event: ConstitutionalAuditEvent,
  ): Promise<ConstitutionalAuditEvent> {
    try {
      await this.db.query(
        `INSERT INTO constitutional_audit_events (
           audit_event_id, event_type, institution_id, proposal_id, payload, created_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
         ON CONFLICT (audit_event_id) DO NOTHING`,
        [
          event.auditEventId,
          event.eventType,
          event.institutionId,
          event.proposalId ?? null,
          JSON.stringify(event),
          event.createdAt,
        ],
      );
      return event;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async listByProposal(proposalId: string): Promise<ConstitutionalAuditEvent[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM constitutional_audit_events
       WHERE proposal_id = $1
       ORDER BY created_at ASC, audit_event_id ASC`,
      [proposalId],
    );
    return result.rows.map((row) => row.payload as ConstitutionalAuditEvent);
  }
}
