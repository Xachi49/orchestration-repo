import { AssuranceError } from "../../../assurance/errors.js";
import { QualificationError } from "../../../qualification/errors.js";
import {
  ProductionQualificationRunSchema,
  type ProductionQualificationRun,
} from "../../../qualification/qualification-run.js";
import {
  QualificationEvidenceRecordSchema,
  type QualificationEvidenceRecord,
} from "../../../qualification/qualification-evidence.js";
import {
  computeReleaseQualificationMaterialFingerprint,
  ReleaseQualificationRecordSchema,
  type ReleaseQualificationRecord,
} from "../../../qualification/qualification-record.js";
import {
  ReleaseManifestSchema,
  type ReleaseManifest,
} from "../../../qualification/release-manifest.js";
import {
  QualificationAuditEventSchema,
  type QualificationAuditEvent,
} from "../../../qualification/audit.js";
import type {
  ProductionQualificationRunRepository,
  QualificationAuditRepository,
  QualificationEvidenceRepository,
  ReleaseManifestRepository,
  ReleaseQualificationRecordRepository,
} from "../../../qualification/repositories.js";
import type { PostgresDatabase } from "../database.js";
import { hydrateRecord } from "../hydrate.js";

export class PostgresProductionQualificationRunRepository
  implements ProductionQualificationRunRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    run: ProductionQualificationRun,
  ): Promise<ProductionQualificationRun> {
    const parsed = ProductionQualificationRunSchema.parse(run);
    // ON CONFLICT DO NOTHING does not abort the surrounding transaction.
    const inserted = await this.db.query<{ payload: unknown }>(
      `INSERT INTO production_qualification_runs (
         qualification_run_id, release_candidate_fingerprint, runtime_manifest_hash,
         phase23_certificate_id, phase23_certificate_hash, status, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$9::timestamptz)
       ON CONFLICT (qualification_run_id) DO NOTHING
       RETURNING payload`,
      [
        parsed.qualificationRunId,
        parsed.releaseCandidateFingerprint,
        parsed.runtimeManifestHash,
        parsed.phase23CertificateId,
        parsed.phase23CertificateHash,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.startedAt,
      ],
    );
    if (inserted.rows[0]) {
      return hydrateRecord(
        (i) => ProductionQualificationRunSchema.parse(i),
        inserted.rows[0].payload,
        "production_qualification_runs",
      );
    }
    const existing = await this.getById(parsed.qualificationRunId);
    if (!existing) {
      throw new QualificationError(
        "QUALIFICATION_STATE_CONFLICT",
        `Qualification run ${parsed.qualificationRunId} conflict without existing row`,
      );
    }
    return existing;
  }

  async getById(
    qualificationRunId: string,
  ): Promise<ProductionQualificationRun | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM production_qualification_runs
       WHERE qualification_run_id = $1`,
      [qualificationRunId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => ProductionQualificationRunSchema.parse(i),
      row.payload,
      "production_qualification_runs",
    );
  }

  async transition(
    qualificationRunId: string,
    expectedRevision: number,
    next: ProductionQualificationRun,
  ): Promise<ProductionQualificationRun> {
    const parsed = ProductionQualificationRunSchema.parse(next);
    const result = await this.db.query<{ payload: unknown }>(
      `UPDATE production_qualification_runs
       SET status = $1, payload = $2::jsonb, record_revision = $3,
           updated_at = $4::timestamptz
       WHERE qualification_run_id = $5 AND record_revision = $6
       RETURNING payload`,
      [
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.completedAt ?? parsed.startedAt,
        qualificationRunId,
        expectedRevision,
      ],
    );
    if (result.rows.length === 0) {
      throw new QualificationError(
        "QUALIFICATION_CAS_CONFLICT",
        `Qualification run ${qualificationRunId} revision conflict`,
      );
    }
    return hydrateRecord(
      (i) => ProductionQualificationRunSchema.parse(i),
      result.rows[0]!.payload,
      "production_qualification_runs",
    );
  }
}

export class PostgresQualificationEvidenceRepository
  implements QualificationEvidenceRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    evidence: QualificationEvidenceRecord,
  ): Promise<QualificationEvidenceRecord> {
    const parsed = QualificationEvidenceRecordSchema.parse(evidence);
    // ON CONFLICT DO NOTHING does not abort the surrounding transaction.
    const inserted = await this.db.query<{ payload: unknown }>(
      `INSERT INTO qualification_evidence (
         evidence_id, qualification_run_id, content_hash, payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (evidence_id) DO NOTHING
       RETURNING payload`,
      [
        parsed.evidenceId,
        parsed.qualificationRunId,
        parsed.contentHash,
        JSON.stringify(parsed),
        parsed.generatedAt,
      ],
    );
    if (inserted.rows[0]) {
      return hydrateRecord(
        (i) => QualificationEvidenceRecordSchema.parse(i),
        inserted.rows[0].payload,
        "qualification_evidence",
      );
    }
    const existing = await this.getById(parsed.evidenceId);
    if (!existing) {
      throw new QualificationError(
        "QUALIFICATION_EVIDENCE_MISSING",
        `Evidence ${parsed.evidenceId} conflict without existing row`,
      );
    }
    if (existing.contentHash !== parsed.contentHash) {
      throw new QualificationError(
        "QUALIFICATION_EVIDENCE_MISSING",
        `Evidence ${parsed.evidenceId} content hash conflict`,
      );
    }
    return existing;
  }

  private async getById(
    evidenceId: string,
  ): Promise<QualificationEvidenceRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM qualification_evidence WHERE evidence_id = $1`,
      [evidenceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => QualificationEvidenceRecordSchema.parse(i),
      row.payload,
      "qualification_evidence",
    );
  }

  async listByRun(
    qualificationRunId: string,
  ): Promise<QualificationEvidenceRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM qualification_evidence
       WHERE qualification_run_id = $1 ORDER BY evidence_id ASC`,
      [qualificationRunId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => QualificationEvidenceRecordSchema.parse(i),
        row.payload,
        "qualification_evidence",
      ),
    );
  }
}

export class PostgresReleaseQualificationRecordRepository
  implements ReleaseQualificationRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ReleaseQualificationRecord,
  ): Promise<ReleaseQualificationRecord> {
    const parsed = ReleaseQualificationRecordSchema.parse(record);
    const material = computeReleaseQualificationMaterialFingerprint({
      qualificationRunId: parsed.qualificationRunId,
      releaseCandidateFingerprint: parsed.releaseCandidateFingerprint,
      buildArtifactFingerprint: parsed.buildArtifactFingerprint,
      referenceRuntimeManifestHash: parsed.referenceRuntimeManifestHash,
      phase23CertificateId: parsed.phase23CertificateId,
      phase23CertificateHash: parsed.phase23CertificateHash,
      readinessEvidenceSetFingerprint: parsed.readinessEvidenceSetFingerprint,
      systemQualificationEvidenceSetFingerprint:
        parsed.systemQualificationEvidenceSetFingerprint,
      outcome: parsed.outcome,
    });
    // ON CONFLICT DO NOTHING does not abort the surrounding transaction.
    const inserted = await this.db.query<{ payload: unknown }>(
      `INSERT INTO release_qualification_records (
         record_id, record_hash, material_fingerprint,
         release_candidate_fingerprint, outcome, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
       ON CONFLICT (material_fingerprint) DO NOTHING
       RETURNING payload`,
      [
        parsed.recordId,
        parsed.recordHash,
        material,
        parsed.releaseCandidateFingerprint,
        parsed.outcome,
        JSON.stringify(parsed),
        parsed.evaluatedAt,
      ],
    );
    if (inserted.rows[0]) {
      return hydrateRecord(
        (i) => ReleaseQualificationRecordSchema.parse(i),
        inserted.rows[0].payload,
        "release_qualification_records",
      );
    }
    const existing = await this.getByMaterialFingerprint(material);
    if (!existing) {
      // Primary key conflict on record_id with different material — rare.
      const byId = await this.getById(parsed.recordId);
      if (byId) return byId;
      throw new QualificationError(
        "RELEASE_QUALIFICATION_CONFLICT",
        `Qualification record material ${material} conflict without existing row`,
      );
    }
    if (existing.qualificationRunId !== parsed.qualificationRunId) {
      throw new QualificationError(
        "RELEASE_QUALIFICATION_CONFLICT",
        "Material fingerprint bound to a different qualification run",
      );
    }
    return existing;
  }

  async getById(
    recordId: string,
  ): Promise<ReleaseQualificationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM release_qualification_records WHERE record_id = $1`,
      [recordId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => ReleaseQualificationRecordSchema.parse(i),
      row.payload,
      "release_qualification_records",
    );
  }

  async getByMaterialFingerprint(
    fingerprint: string,
  ): Promise<ReleaseQualificationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM release_qualification_records
       WHERE material_fingerprint = $1`,
      [fingerprint],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => ReleaseQualificationRecordSchema.parse(i),
      row.payload,
      "release_qualification_records",
    );
  }

  async getByCandidateFingerprint(
    releaseCandidateFingerprint: string,
  ): Promise<ReleaseQualificationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM release_qualification_records
       WHERE release_candidate_fingerprint = $1
       ORDER BY created_at ASC LIMIT 1`,
      [releaseCandidateFingerprint],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => ReleaseQualificationRecordSchema.parse(i),
      row.payload,
      "release_qualification_records",
    );
  }
}

export class PostgresReleaseManifestRepository
  implements ReleaseManifestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(manifest: ReleaseManifest): Promise<ReleaseManifest> {
    const parsed = ReleaseManifestSchema.parse(manifest);
    // ON CONFLICT DO NOTHING does not abort the surrounding transaction.
    const inserted = await this.db.query<{ payload: unknown }>(
      `INSERT INTO release_manifests (
         manifest_fingerprint, release_candidate_fingerprint, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,NOW())
       ON CONFLICT (manifest_fingerprint) DO NOTHING
       RETURNING payload`,
      [
        parsed.manifestFingerprint,
        parsed.releaseCandidateFingerprint,
        JSON.stringify(parsed),
      ],
    );
    if (inserted.rows[0]) {
      return hydrateRecord(
        (i) => ReleaseManifestSchema.parse(i),
        inserted.rows[0].payload,
        "release_manifests",
      );
    }
    const existing = await this.getByFingerprint(parsed.manifestFingerprint);
    if (!existing) {
      throw new QualificationError(
        "RELEASE_MANIFEST_INVALID",
        `Release manifest ${parsed.manifestFingerprint} conflict without existing row`,
      );
    }
    if (existing.manifestFingerprint !== parsed.manifestFingerprint) {
      throw new QualificationError(
        "RELEASE_MANIFEST_INVALID",
        "Release manifest fingerprint mismatch after conflict",
      );
    }
    // Immutable: fingerprint is the canonical identity of the material.
    return existing;
  }

  async getByFingerprint(
    manifestFingerprint: string,
  ): Promise<ReleaseManifest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM release_manifests WHERE manifest_fingerprint = $1`,
      [manifestFingerprint],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => ReleaseManifestSchema.parse(i),
      row.payload,
      "release_manifests",
    );
  }
}

export class PostgresQualificationAuditRepository
  implements QualificationAuditRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async append(
    event: QualificationAuditEvent,
  ): Promise<QualificationAuditEvent> {
    const parsed = QualificationAuditEventSchema.parse(event);
    await this.db.query(
      `INSERT INTO qualification_audit_events (
         audit_event_id, event_type, qualification_run_id, record_id, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
      [
        parsed.auditEventId,
        parsed.eventType,
        parsed.qualificationRunId ?? null,
        parsed.recordId ?? null,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByRun(
    qualificationRunId: string,
  ): Promise<QualificationAuditEvent[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM qualification_audit_events
       WHERE qualification_run_id = $1 ORDER BY created_at ASC`,
      [qualificationRunId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => QualificationAuditEventSchema.parse(i),
        row.payload,
        "qualification_audit_events",
      ),
    );
  }
}

// Keep AssuranceError import referenced for TX preservation adjacency proofs.
void AssuranceError;
