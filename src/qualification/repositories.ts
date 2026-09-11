import type { QualificationAuditEvent } from "./audit.js";
import type { QualificationEvidenceRecord } from "./qualification-evidence.js";
import type { ProductionQualificationRun } from "./qualification-run.js";
import type { ReleaseQualificationRecord } from "./qualification-record.js";
import type { ReleaseManifest } from "./release-manifest.js";

export interface ProductionQualificationRunRepository {
  save(run: ProductionQualificationRun): Promise<ProductionQualificationRun>;
  getById(qualificationRunId: string): Promise<ProductionQualificationRun | null>;
  transition(
    qualificationRunId: string,
    expectedRevision: number,
    next: ProductionQualificationRun,
  ): Promise<ProductionQualificationRun>;
}

export interface QualificationEvidenceRepository {
  save(
    evidence: QualificationEvidenceRecord,
  ): Promise<QualificationEvidenceRecord>;
  listByRun(
    qualificationRunId: string,
  ): Promise<QualificationEvidenceRecord[]>;
}

export interface ReleaseQualificationRecordRepository {
  save(
    record: ReleaseQualificationRecord,
  ): Promise<ReleaseQualificationRecord>;
  getById(recordId: string): Promise<ReleaseQualificationRecord | null>;
  getByMaterialFingerprint(
    materialFingerprint: string,
  ): Promise<ReleaseQualificationRecord | null>;
  getByCandidateFingerprint(
    releaseCandidateFingerprint: string,
  ): Promise<ReleaseQualificationRecord | null>;
}

export interface ReleaseManifestRepository {
  save(manifest: ReleaseManifest): Promise<ReleaseManifest>;
  getByFingerprint(
    manifestFingerprint: string,
  ): Promise<ReleaseManifest | null>;
}

export interface QualificationAuditRepository {
  append(event: QualificationAuditEvent): Promise<QualificationAuditEvent>;
  listByRun(qualificationRunId: string): Promise<QualificationAuditEvent[]>;
}
