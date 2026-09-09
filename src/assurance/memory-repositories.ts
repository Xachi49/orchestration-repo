import { AssuranceError } from "./errors.js";
import {
  AssuranceAssessmentSchema,
  type AssuranceAssessment,
} from "./assessment.js";
import {
  AssuranceAuditEventSchema,
  type AssuranceAuditEvent,
} from "./audit.js";
import {
  AssuranceChallengePlanSchema,
  type AssuranceChallengePlan,
} from "./challenge.js";
import {
  SystemCertificateSchema,
  type SystemCertificate,
} from "./certification.js";
import {
  ControlEvaluationSchema,
  type ControlEvaluation,
} from "./evaluation.js";
import {
  AssuranceEvidenceRecordSchema,
  type AssuranceEvidenceRecord,
} from "./evidence.js";
import { AssuranceFindingSchema, type AssuranceFinding } from "./finding.js";
import { AssuranceProfileSchema, type AssuranceProfile } from "./profile.js";
import {
  SystemCertificateRevocationSchema,
  type SystemCertificateRevocation,
} from "./revocation.js";
import { AssuranceRunSchema, type AssuranceRun } from "./run.js";
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
} from "./repositories.js";

export class InMemoryAssuranceProfileRepository
  implements AssuranceProfileRepository
{
  readonly byKey = new Map<string, AssuranceProfile>();

  private key(id: string, version: number): string {
    return `${id}@${version}`;
  }

  async save(profile: AssuranceProfile): Promise<AssuranceProfile> {
    const parsed = AssuranceProfileSchema.parse(profile);
    this.byKey.set(this.key(parsed.profileId, parsed.profileVersion), parsed);
    return parsed;
  }

  async getByIdVersion(
    profileId: string,
    profileVersion: number,
  ): Promise<AssuranceProfile | null> {
    return this.byKey.get(this.key(profileId, profileVersion)) ?? null;
  }

  async getActive(profileId: string): Promise<AssuranceProfile | null> {
    const matches = [...this.byKey.values()]
      .filter((p) => p.profileId === profileId && p.status === "ACTIVE")
      .sort((a, b) => b.profileVersion - a.profileVersion);
    return matches[0] ?? null;
  }
}

export class InMemoryAssuranceRunRepository implements AssuranceRunRepository {
  readonly byId = new Map<string, AssuranceRun>();

  async save(run: AssuranceRun): Promise<AssuranceRun> {
    const parsed = AssuranceRunSchema.parse(run);
    this.byId.set(parsed.assuranceRunId, parsed);
    return parsed;
  }

  async getById(assuranceRunId: string): Promise<AssuranceRun | null> {
    return this.byId.get(assuranceRunId) ?? null;
  }

  async transition(
    assuranceRunId: string,
    fromStatus: AssuranceRun["status"],
    expectedRevision: number,
    toStatus: AssuranceRun["status"],
    updatedAt: string,
    patch?: Partial<AssuranceRun>,
  ): Promise<AssuranceRun> {
    const existing = this.byId.get(assuranceRunId);
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
    this.byId.set(assuranceRunId, next);
    return next;
  }
}

export class InMemoryAssuranceChallengePlanRepository
  implements AssuranceChallengePlanRepository
{
  readonly byId = new Map<string, AssuranceChallengePlan>();

  async save(plan: AssuranceChallengePlan): Promise<AssuranceChallengePlan> {
    const parsed = AssuranceChallengePlanSchema.parse(plan);
    this.byId.set(parsed.planId, parsed);
    return parsed;
  }

  async getById(planId: string): Promise<AssuranceChallengePlan | null> {
    return this.byId.get(planId) ?? null;
  }
}

export class InMemoryAssuranceEvidenceRepository
  implements AssuranceEvidenceRepository
{
  readonly byId = new Map<string, AssuranceEvidenceRecord>();

  async save(
    evidence: AssuranceEvidenceRecord,
  ): Promise<AssuranceEvidenceRecord> {
    const parsed = AssuranceEvidenceRecordSchema.parse(evidence);
    if (this.byId.has(parsed.evidenceId)) {
      const existing = this.byId.get(parsed.evidenceId)!;
      if (existing.contentHash !== parsed.contentHash) {
        throw new AssuranceError(
          "ASSURANCE_EVIDENCE_TAMPERED",
          `Evidence ${parsed.evidenceId} content hash conflict`,
        );
      }
      return existing;
    }
    this.byId.set(parsed.evidenceId, parsed);
    return parsed;
  }

  async getById(evidenceId: string): Promise<AssuranceEvidenceRecord | null> {
    return this.byId.get(evidenceId) ?? null;
  }

  async listByRun(assuranceRunId: string): Promise<AssuranceEvidenceRecord[]> {
    return [...this.byId.values()]
      .filter((e) => e.assuranceRunId === assuranceRunId)
      .sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  }
}

export class InMemoryAssuranceControlEvaluationRepository
  implements AssuranceControlEvaluationRepository
{
  readonly byRun = new Map<string, ControlEvaluation[]>();

  async save(evaluation: ControlEvaluation): Promise<ControlEvaluation> {
    return ControlEvaluationSchema.parse(evaluation);
  }

  async saveForRun(
    assuranceRunId: string,
    evaluation: ControlEvaluation,
  ): Promise<ControlEvaluation> {
    const parsed = ControlEvaluationSchema.parse(evaluation);
    const list = this.byRun.get(assuranceRunId) ?? [];
    const next = [...list.filter((e) => e.controlId !== parsed.controlId), parsed];
    this.byRun.set(assuranceRunId, next);
    return parsed;
  }

  async listByRun(assuranceRunId: string): Promise<ControlEvaluation[]> {
    return [...(this.byRun.get(assuranceRunId) ?? [])].sort((a, b) =>
      a.controlId.localeCompare(b.controlId),
    );
  }
}

export class InMemoryAssuranceFindingRepository
  implements AssuranceFindingRepository
{
  readonly byId = new Map<string, AssuranceFinding>();

  async save(finding: AssuranceFinding): Promise<AssuranceFinding> {
    const parsed = AssuranceFindingSchema.parse(finding);
    this.byId.set(parsed.findingId, parsed);
    return parsed;
  }

  async listByRun(assuranceRunId: string): Promise<AssuranceFinding[]> {
    return [...this.byId.values()]
      .filter((f) => f.assuranceRunId === assuranceRunId)
      .sort((a, b) => a.findingId.localeCompare(b.findingId));
  }
}

export class InMemoryAssuranceAssessmentRepository
  implements AssuranceAssessmentRepository
{
  readonly byId = new Map<string, AssuranceAssessment>();
  readonly byRun = new Map<string, string>();

  async save(assessment: AssuranceAssessment): Promise<AssuranceAssessment> {
    const parsed = AssuranceAssessmentSchema.parse(assessment);
    this.byId.set(parsed.assessmentId, parsed);
    this.byRun.set(parsed.assuranceRunId, parsed.assessmentId);
    return parsed;
  }

  async getById(assessmentId: string): Promise<AssuranceAssessment | null> {
    return this.byId.get(assessmentId) ?? null;
  }

  async getByRun(assuranceRunId: string): Promise<AssuranceAssessment | null> {
    const id = this.byRun.get(assuranceRunId);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class InMemorySystemCertificateRepository
  implements SystemCertificateRepository
{
  readonly byId = new Map<string, SystemCertificate>();
  readonly byMaterial = new Map<string, string>();
  readonly byRun = new Map<string, string>();

  async save(certificate: SystemCertificate): Promise<SystemCertificate> {
    const parsed = SystemCertificateSchema.parse(certificate);
    const existingId = this.byMaterial.get(
      parsed.certificationMaterialFingerprint,
    );
    if (existingId && existingId !== parsed.certificateId) {
      throw new AssuranceError(
        "ASSURANCE_CERTIFICATION_CONFLICT",
        "Certificate material fingerprint already bound",
      );
    }
    if (existingId === parsed.certificateId) {
      return this.byId.get(parsed.certificateId)!;
    }
    const existingForRun = this.byRun.get(parsed.assuranceRunId);
    if (
      existingForRun &&
      existingForRun !== parsed.certificateId
    ) {
      const prior = this.byId.get(existingForRun)!;
      if (
        prior.certificationMaterialFingerprint !==
        parsed.certificationMaterialFingerprint
      ) {
        throw new AssuranceError(
          "ASSURANCE_CERTIFICATION_CONFLICT",
          "Incompatible certification material for assurance run",
          {
            assuranceRunId: parsed.assuranceRunId,
            existing: prior.certificationMaterialFingerprint,
            attempted: parsed.certificationMaterialFingerprint,
          },
        );
      }
    }
    this.byId.set(parsed.certificateId, parsed);
    this.byMaterial.set(
      parsed.certificationMaterialFingerprint,
      parsed.certificateId,
    );
    this.byRun.set(parsed.assuranceRunId, parsed.certificateId);
    return parsed;
  }

  async getById(certificateId: string): Promise<SystemCertificate | null> {
    return this.byId.get(certificateId) ?? null;
  }

  async getByMaterialFingerprint(
    fingerprint: string,
  ): Promise<SystemCertificate | null> {
    const id = this.byMaterial.get(fingerprint);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async getByRun(assuranceRunId: string): Promise<SystemCertificate | null> {
    const id = this.byRun.get(assuranceRunId);
    return id ? (this.byId.get(id) ?? null) : null;
  }
}

export class InMemorySystemCertificateRevocationRepository
  implements SystemCertificateRevocationRepository
{
  readonly byId = new Map<string, SystemCertificateRevocation>();

  async save(
    revocation: SystemCertificateRevocation,
  ): Promise<SystemCertificateRevocation> {
    const parsed = SystemCertificateRevocationSchema.parse(revocation);
    this.byId.set(parsed.revocationId, parsed);
    return parsed;
  }

  async listByCertificate(
    certificateId: string,
  ): Promise<SystemCertificateRevocation[]> {
    return [...this.byId.values()]
      .filter((r) => r.certificateId === certificateId)
      .sort((a, b) => a.revocationId.localeCompare(b.revocationId));
  }
}

export class InMemoryAssuranceAuditRepository
  implements AssuranceAuditRepository
{
  readonly events: AssuranceAuditEvent[] = [];

  async append(event: AssuranceAuditEvent): Promise<AssuranceAuditEvent> {
    const parsed = AssuranceAuditEventSchema.parse(event);
    this.events.push(parsed);
    return parsed;
  }

  async listByRun(assuranceRunId: string): Promise<AssuranceAuditEvent[]> {
    return this.events.filter((e) => e.assuranceRunId === assuranceRunId);
  }
}
