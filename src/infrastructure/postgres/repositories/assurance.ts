import { AssuranceError } from "../../../assurance/errors.js";
import {
  AssuranceAssessmentSchema,
  type AssuranceAssessment,
} from "../../../assurance/assessment.js";
import {
  AssuranceAuditEventSchema,
  type AssuranceAuditEvent,
} from "../../../assurance/audit.js";
import {
  AssuranceChallengePlanSchema,
  type AssuranceChallengePlan,
} from "../../../assurance/challenge.js";
import {
  SystemCertificateSchema,
  type SystemCertificate,
} from "../../../assurance/certification.js";
import {
  ControlEvaluationSchema,
  type ControlEvaluation,
} from "../../../assurance/evaluation.js";
import {
  AssuranceEvidenceRecordSchema,
  type AssuranceEvidenceRecord,
} from "../../../assurance/evidence.js";
import {
  AssuranceFindingSchema,
  type AssuranceFinding,
} from "../../../assurance/finding.js";
import {
  AssuranceProfileSchema,
  type AssuranceProfile,
} from "../../../assurance/profile.js";
import {
  SystemCertificateRevocationSchema,
  type SystemCertificateRevocation,
} from "../../../assurance/revocation.js";
import {
  AssuranceRunSchema,
  type AssuranceRun,
} from "../../../assurance/run.js";
import type {
  AssuranceAssessmentRepository,
  AssuranceAuditRepository,
  AssuranceChallengePlanRepository,
  AssuranceControlEvaluationRepository,
  AssuranceEvidenceRepository,
  AssuranceFindingRepository,
  AssuranceProfileRepository,
  AssuranceRunRepository,
  SystemCertificateRepository,
  SystemCertificateRevocationRepository,
} from "../../../assurance/repositories.js";
import { hydrateRecord } from "../hydrate.js";
import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";

export class PostgresAssuranceProfileRepository
  implements AssuranceProfileRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(profile: AssuranceProfile): Promise<AssuranceProfile> {
    const parsed = AssuranceProfileSchema.parse(profile);
    await this.db.query(
      `INSERT INTO assurance_profiles (
         profile_id, profile_version, profile_hash, status, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
       ON CONFLICT (profile_id, profile_version) DO NOTHING`,
      [
        parsed.profileId,
        parsed.profileVersion,
        parsed.profileHash,
        parsed.status,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return (await this.getByIdVersion(parsed.profileId, parsed.profileVersion))!;
  }

  async getByIdVersion(
    profileId: string,
    profileVersion: number,
  ): Promise<AssuranceProfile | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_profiles
       WHERE profile_id = $1 AND profile_version = $2`,
      [profileId, profileVersion],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceProfileSchema.parse(i),
      row.payload,
      "assurance_profiles",
    );
  }

  async getActive(profileId: string): Promise<AssuranceProfile | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_profiles
       WHERE profile_id = $1 AND status = 'ACTIVE'
       ORDER BY profile_version DESC LIMIT 1`,
      [profileId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceProfileSchema.parse(i),
      row.payload,
      "assurance_profiles",
    );
  }
}

export class PostgresAssuranceRunRepository implements AssuranceRunRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(run: AssuranceRun): Promise<AssuranceRun> {
    const parsed = AssuranceRunSchema.parse(run);
    await this.db.query(
      `INSERT INTO assurance_runs (
         assurance_run_id, target_fingerprint, profile_id, profile_version,
         profile_hash, status, payload, record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz)`,
      [
        parsed.assuranceRunId,
        parsed.targetFingerprint,
        parsed.profileId,
        parsed.profileVersion,
        parsed.profileHash,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.createdAt,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(assuranceRunId: string): Promise<AssuranceRun | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_runs WHERE assurance_run_id = $1`,
      [assuranceRunId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceRunSchema.parse(i),
      row.payload,
      "assurance_runs",
    );
  }

  async transition(
    assuranceRunId: string,
    fromStatus: AssuranceRun["status"],
    expectedRevision: number,
    toStatus: AssuranceRun["status"],
    updatedAt: string,
    patch?: Partial<AssuranceRun>,
  ): Promise<AssuranceRun> {
    const existing = await this.getById(assuranceRunId);
    if (!existing) {
      throw new AssuranceError(
        "ASSURANCE_NOT_FOUND",
        `Run ${assuranceRunId} not found`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new AssuranceError(
        "ASSURANCE_CAS_CONFLICT",
        `Run ${assuranceRunId} CAS conflict`,
      );
    }
    const next = AssuranceRunSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      updatedAt,
      recordRevision: existing.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE assurance_runs
       SET status = $2, payload = $3::jsonb, record_revision = $4, updated_at = $5::timestamptz
       WHERE assurance_run_id = $1 AND status = $6 AND record_revision = $7`,
      [
        assuranceRunId,
        next.status,
        JSON.stringify(next),
        next.recordRevision,
        updatedAt,
        fromStatus,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new AssuranceError(
        "ASSURANCE_CAS_CONFLICT",
        `Run ${assuranceRunId} concurrent update`,
      );
    }
    return next;
  }
}

export class PostgresAssuranceChallengePlanRepository
  implements AssuranceChallengePlanRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(plan: AssuranceChallengePlan): Promise<AssuranceChallengePlan> {
    const parsed = AssuranceChallengePlanSchema.parse(plan);
    await this.db.query(
      `INSERT INTO assurance_challenge_plans (
         plan_id, plan_hash, target_fingerprint, payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (plan_id) DO NOTHING`,
      [
        parsed.planId,
        parsed.planHash,
        parsed.targetFingerprint,
        JSON.stringify(parsed),
        parsed.compiledAt,
      ],
    );
    return parsed;
  }

  async getById(planId: string): Promise<AssuranceChallengePlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_challenge_plans WHERE plan_id = $1`,
      [planId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceChallengePlanSchema.parse(i),
      row.payload,
      "assurance_challenge_plans",
    );
  }
}

export class PostgresAssuranceEvidenceRepository
  implements AssuranceEvidenceRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    evidence: AssuranceEvidenceRecord,
  ): Promise<AssuranceEvidenceRecord> {
    const parsed = AssuranceEvidenceRecordSchema.parse(evidence);
    try {
      await this.db.query(
        `INSERT INTO assurance_evidence (
           evidence_id, assurance_run_id, content_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
        [
          parsed.evidenceId,
          parsed.assuranceRunId,
          parsed.contentHash,
          JSON.stringify(parsed),
          parsed.generatedAt,
        ],
      );
      return parsed;
    } catch (error) {
      const existing = await this.getById(parsed.evidenceId);
      if (existing) {
        if (existing.contentHash !== parsed.contentHash) {
          throw new AssuranceError(
            "ASSURANCE_EVIDENCE_TAMPERED",
            `Evidence ${parsed.evidenceId} content hash conflict`,
          );
        }
        return existing;
      }
      throw wrapDatabaseError(error);
    }
  }

  async getById(evidenceId: string): Promise<AssuranceEvidenceRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_evidence WHERE evidence_id = $1`,
      [evidenceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceEvidenceRecordSchema.parse(i),
      row.payload,
      "assurance_evidence",
    );
  }

  async listByRun(assuranceRunId: string): Promise<AssuranceEvidenceRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_evidence
       WHERE assurance_run_id = $1 ORDER BY evidence_id ASC`,
      [assuranceRunId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => AssuranceEvidenceRecordSchema.parse(i),
        row.payload,
        "assurance_evidence",
      ),
    );
  }
}

export class PostgresAssuranceControlEvaluationRepository
  implements AssuranceControlEvaluationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(evaluation: ControlEvaluation): Promise<ControlEvaluation> {
    return ControlEvaluationSchema.parse(evaluation);
  }

  async saveForRun(
    assuranceRunId: string,
    evaluation: ControlEvaluation,
  ): Promise<ControlEvaluation> {
    const parsed = ControlEvaluationSchema.parse(evaluation);
    await this.db.query(
      `INSERT INTO assurance_control_evaluations (
         evaluation_id, assurance_run_id, control_id, payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (assurance_run_id, control_id) DO UPDATE
       SET evaluation_id = EXCLUDED.evaluation_id,
           payload = EXCLUDED.payload`,
      [
        parsed.evaluationId,
        assuranceRunId,
        parsed.controlId,
        JSON.stringify(parsed),
        parsed.evaluatedAt,
      ],
    );
    return parsed;
  }

  async listByRun(assuranceRunId: string): Promise<ControlEvaluation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_control_evaluations
       WHERE assurance_run_id = $1 ORDER BY control_id ASC`,
      [assuranceRunId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ControlEvaluationSchema.parse(i),
        row.payload,
        "assurance_control_evaluations",
      ),
    );
  }
}

export class PostgresAssuranceFindingRepository
  implements AssuranceFindingRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(finding: AssuranceFinding): Promise<AssuranceFinding> {
    const parsed = AssuranceFindingSchema.parse(finding);
    await this.db.query(
      `INSERT INTO assurance_findings (
         finding_id, assurance_run_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)`,
      [
        parsed.findingId,
        parsed.assuranceRunId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByRun(assuranceRunId: string): Promise<AssuranceFinding[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_findings
       WHERE assurance_run_id = $1 ORDER BY finding_id ASC`,
      [assuranceRunId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => AssuranceFindingSchema.parse(i),
        row.payload,
        "assurance_findings",
      ),
    );
  }
}

export class PostgresAssuranceAssessmentRepository
  implements AssuranceAssessmentRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(assessment: AssuranceAssessment): Promise<AssuranceAssessment> {
    const parsed = AssuranceAssessmentSchema.parse(assessment);
    await this.db.query(
      `INSERT INTO assurance_assessments (
         assessment_id, assurance_run_id, assessment_hash, outcome, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)
       ON CONFLICT (assurance_run_id) DO NOTHING`,
      [
        parsed.assessmentId,
        parsed.assuranceRunId,
        parsed.assessmentHash,
        parsed.outcome,
        JSON.stringify(parsed),
        parsed.assessedAt,
      ],
    );
    return (await this.getByRun(parsed.assuranceRunId)) ?? parsed;
  }

  async getById(assessmentId: string): Promise<AssuranceAssessment | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_assessments WHERE assessment_id = $1`,
      [assessmentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceAssessmentSchema.parse(i),
      row.payload,
      "assurance_assessments",
    );
  }

  async getByRun(assuranceRunId: string): Promise<AssuranceAssessment | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_assessments WHERE assurance_run_id = $1`,
      [assuranceRunId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => AssuranceAssessmentSchema.parse(i),
      row.payload,
      "assurance_assessments",
    );
  }
}

export class PostgresSystemCertificateRepository
  implements SystemCertificateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(certificate: SystemCertificate): Promise<SystemCertificate> {
    const parsed = SystemCertificateSchema.parse(certificate);
    try {
      await this.db.query(
        `INSERT INTO system_certificates (
           certificate_id, certificate_hash, certification_material_fingerprint,
           target_fingerprint, status, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$8::timestamptz)`,
        [
          parsed.certificateId,
          parsed.certificateHash,
          parsed.certificationMaterialFingerprint,
          parsed.targetFingerprint,
          parsed.status,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.issuedAt,
        ],
      );
      return parsed;
    } catch (error) {
      const existing = await this.getByMaterialFingerprint(
        parsed.certificationMaterialFingerprint,
      );
      if (existing) return existing;
      throw wrapDatabaseError(error);
    }
  }

  async getById(certificateId: string): Promise<SystemCertificate | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM system_certificates WHERE certificate_id = $1`,
      [certificateId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => SystemCertificateSchema.parse(i),
      row.payload,
      "system_certificates",
    );
  }

  async getByMaterialFingerprint(
    fingerprint: string,
  ): Promise<SystemCertificate | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM system_certificates
       WHERE certification_material_fingerprint = $1`,
      [fingerprint],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => SystemCertificateSchema.parse(i),
      row.payload,
      "system_certificates",
    );
  }

  async getByRun(assuranceRunId: string): Promise<SystemCertificate | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM system_certificates
       WHERE payload->>'assuranceRunId' = $1
       ORDER BY created_at ASC LIMIT 1`,
      [assuranceRunId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return hydrateRecord(
      (i) => SystemCertificateSchema.parse(i),
      row.payload,
      "system_certificates",
    );
  }
}

export class PostgresSystemCertificateRevocationRepository
  implements SystemCertificateRevocationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    revocation: SystemCertificateRevocation,
  ): Promise<SystemCertificateRevocation> {
    const parsed = SystemCertificateRevocationSchema.parse(revocation);
    await this.db.query(
      `INSERT INTO system_certificate_revocations (
         revocation_id, certificate_id, revocation_hash, payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
      [
        parsed.revocationId,
        parsed.certificateId,
        parsed.revocationHash,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByCertificate(
    certificateId: string,
  ): Promise<SystemCertificateRevocation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM system_certificate_revocations
       WHERE certificate_id = $1 ORDER BY revocation_id ASC`,
      [certificateId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => SystemCertificateRevocationSchema.parse(i),
        row.payload,
        "system_certificate_revocations",
      ),
    );
  }
}

export class PostgresAssuranceAuditRepository
  implements AssuranceAuditRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async append(event: AssuranceAuditEvent): Promise<AssuranceAuditEvent> {
    const parsed = AssuranceAuditEventSchema.parse(event);
    await this.db.query(
      `INSERT INTO assurance_audit_events (
         audit_event_id, event_type, assurance_run_id, certificate_id, payload, created_at
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
      [
        parsed.auditEventId,
        parsed.eventType,
        parsed.assuranceRunId ?? null,
        parsed.certificateId ?? null,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByRun(assuranceRunId: string): Promise<AssuranceAuditEvent[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assurance_audit_events
       WHERE assurance_run_id = $1 ORDER BY created_at ASC`,
      [assuranceRunId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => AssuranceAuditEventSchema.parse(i),
        row.payload,
        "assurance_audit_events",
      ),
    );
  }
}
