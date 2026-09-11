import { QualificationError } from "./errors.js";
import type { QualificationAuditEvent } from "./audit.js";
import type { QualificationEvidenceRecord } from "./qualification-evidence.js";
import type { ProductionQualificationRun } from "./qualification-run.js";
import {
  ProductionQualificationRunSchema,
} from "./qualification-run.js";
import type { ReleaseQualificationRecord } from "./qualification-record.js";
import {
  computeReleaseQualificationMaterialFingerprint,
  ReleaseQualificationRecordSchema,
} from "./qualification-record.js";
import type { ReleaseManifest } from "./release-manifest.js";
import { ReleaseManifestSchema } from "./release-manifest.js";
import type {
  ProductionQualificationRunRepository,
  QualificationAuditRepository,
  QualificationEvidenceRepository,
  ReleaseManifestRepository,
  ReleaseQualificationRecordRepository,
} from "./repositories.js";
import { QualificationAuditEventSchema } from "./audit.js";
import { QualificationEvidenceRecordSchema } from "./qualification-evidence.js";

export class InMemoryProductionQualificationRunRepository
  implements ProductionQualificationRunRepository
{
  readonly byId = new Map<string, ProductionQualificationRun>();

  async save(
    run: ProductionQualificationRun,
  ): Promise<ProductionQualificationRun> {
    const parsed = ProductionQualificationRunSchema.parse(run);
    const existing = this.byId.get(parsed.qualificationRunId);
    if (existing) return existing;
    this.byId.set(parsed.qualificationRunId, parsed);
    return parsed;
  }

  async getById(
    qualificationRunId: string,
  ): Promise<ProductionQualificationRun | null> {
    return this.byId.get(qualificationRunId) ?? null;
  }

  async transition(
    qualificationRunId: string,
    expectedRevision: number,
    next: ProductionQualificationRun,
  ): Promise<ProductionQualificationRun> {
    const existing = this.byId.get(qualificationRunId);
    if (!existing) {
      throw new QualificationError(
        "QUALIFICATION_NOT_FOUND",
        `Qualification run ${qualificationRunId} not found`,
      );
    }
    if (existing.recordRevision !== expectedRevision) {
      throw new QualificationError(
        "QUALIFICATION_CAS_CONFLICT",
        `Qualification run ${qualificationRunId} revision conflict`,
      );
    }
    const parsed = ProductionQualificationRunSchema.parse(next);
    this.byId.set(qualificationRunId, parsed);
    return parsed;
  }
}

export class InMemoryQualificationEvidenceRepository
  implements QualificationEvidenceRepository
{
  readonly byId = new Map<string, QualificationEvidenceRecord>();

  async save(
    evidence: QualificationEvidenceRecord,
  ): Promise<QualificationEvidenceRecord> {
    const parsed = QualificationEvidenceRecordSchema.parse(evidence);
    const existing = this.byId.get(parsed.evidenceId);
    if (existing) {
      if (existing.contentHash !== parsed.contentHash) {
        throw new QualificationError(
          "QUALIFICATION_EVIDENCE_MISSING",
          `Evidence ${parsed.evidenceId} content hash conflict`,
        );
      }
      return existing;
    }
    this.byId.set(parsed.evidenceId, parsed);
    return parsed;
  }

  async listByRun(
    qualificationRunId: string,
  ): Promise<QualificationEvidenceRecord[]> {
    return [...this.byId.values()]
      .filter((e) => e.qualificationRunId === qualificationRunId)
      .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  }
}

export class InMemoryReleaseQualificationRecordRepository
  implements ReleaseQualificationRecordRepository
{
  readonly byId = new Map<string, ReleaseQualificationRecord>();
  readonly byMaterial = new Map<string, string>();
  readonly byCandidate = new Map<string, string>();

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
    const existingId = this.byMaterial.get(material);
    if (existingId && existingId !== parsed.recordId) {
      const existing = this.byId.get(existingId)!;
      return existing;
    }
    if (existingId === parsed.recordId) {
      return this.byId.get(parsed.recordId)!;
    }
    this.byId.set(parsed.recordId, parsed);
    this.byMaterial.set(material, parsed.recordId);
    this.byCandidate.set(parsed.releaseCandidateFingerprint, parsed.recordId);
    return parsed;
  }

  async getById(
    recordId: string,
  ): Promise<ReleaseQualificationRecord | null> {
    return this.byId.get(recordId) ?? null;
  }

  async getByMaterialFingerprint(
    materialFingerprint: string,
  ): Promise<ReleaseQualificationRecord | null> {
    const id = this.byMaterial.get(materialFingerprint);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async getByCandidateFingerprint(
    releaseCandidateFingerprint: string,
  ): Promise<ReleaseQualificationRecord | null> {
    const id = this.byCandidate.get(releaseCandidateFingerprint);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class InMemoryReleaseManifestRepository
  implements ReleaseManifestRepository
{
  readonly byFp = new Map<string, ReleaseManifest>();

  async save(manifest: ReleaseManifest): Promise<ReleaseManifest> {
    const parsed = ReleaseManifestSchema.parse(manifest);
    const existing = this.byFp.get(parsed.manifestFingerprint);
    if (existing) return existing;
    this.byFp.set(parsed.manifestFingerprint, parsed);
    return parsed;
  }

  async getByFingerprint(
    manifestFingerprint: string,
  ): Promise<ReleaseManifest | null> {
    return this.byFp.get(manifestFingerprint) ?? null;
  }
}

export class InMemoryQualificationAuditRepository
  implements QualificationAuditRepository
{
  readonly events: QualificationAuditEvent[] = [];

  async append(
    event: QualificationAuditEvent,
  ): Promise<QualificationAuditEvent> {
    const parsed = QualificationAuditEventSchema.parse(event);
    this.events.push(parsed);
    return parsed;
  }

  async listByRun(
    qualificationRunId: string,
  ): Promise<QualificationAuditEvent[]> {
    return this.events.filter((e) => e.qualificationRunId === qualificationRunId);
  }
}
