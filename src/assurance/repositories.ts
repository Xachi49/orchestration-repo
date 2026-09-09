import type { AssuranceAssessment } from "./assessment.js";
import type { AssuranceAuditEvent } from "./audit.js";
import type { AssuranceChallengePlan } from "./challenge.js";
import type { SystemCertificate } from "./certification.js";
import type { ControlEvaluation } from "./evaluation.js";
import type { AssuranceEvidenceRecord } from "./evidence.js";
import type { AssuranceFinding } from "./finding.js";
import type { AssuranceProfile } from "./profile.js";
import type { SystemCertificateRevocation } from "./revocation.js";
import type { AssuranceRun } from "./run.js";

export interface AssuranceProfileRepository {
  save(profile: AssuranceProfile): Promise<AssuranceProfile>;
  getByIdVersion(
    profileId: string,
    profileVersion: number,
  ): Promise<AssuranceProfile | null>;
  getActive(profileId: string): Promise<AssuranceProfile | null>;
}

export interface AssuranceRunRepository {
  save(run: AssuranceRun): Promise<AssuranceRun>;
  getById(assuranceRunId: string): Promise<AssuranceRun | null>;
  transition(
    assuranceRunId: string,
    fromStatus: AssuranceRun["status"],
    expectedRevision: number,
    toStatus: AssuranceRun["status"],
    updatedAt: string,
    patch?: Partial<AssuranceRun>,
  ): Promise<AssuranceRun>;
}

export interface AssuranceChallengePlanRepository {
  save(plan: AssuranceChallengePlan): Promise<AssuranceChallengePlan>;
  getById(planId: string): Promise<AssuranceChallengePlan | null>;
}

export interface AssuranceEvidenceRepository {
  save(evidence: AssuranceEvidenceRecord): Promise<AssuranceEvidenceRecord>;
  getById(evidenceId: string): Promise<AssuranceEvidenceRecord | null>;
  listByRun(assuranceRunId: string): Promise<AssuranceEvidenceRecord[]>;
}

export interface AssuranceControlEvaluationRepository {
  save(evaluation: ControlEvaluation): Promise<ControlEvaluation>;
  listByRunControl?(
    assuranceRunId: string,
  ): Promise<ControlEvaluation[]>;
  listByIds?(evaluationIds: readonly string[]): Promise<ControlEvaluation[]>;
  /** Store evaluations keyed by run for listing. */
  saveForRun(
    assuranceRunId: string,
    evaluation: ControlEvaluation,
  ): Promise<ControlEvaluation>;
  listByRun(assuranceRunId: string): Promise<ControlEvaluation[]>;
}

export interface AssuranceFindingRepository {
  save(finding: AssuranceFinding): Promise<AssuranceFinding>;
  listByRun(assuranceRunId: string): Promise<AssuranceFinding[]>;
}

export interface AssuranceAssessmentRepository {
  save(assessment: AssuranceAssessment): Promise<AssuranceAssessment>;
  getById(assessmentId: string): Promise<AssuranceAssessment | null>;
  getByRun(assuranceRunId: string): Promise<AssuranceAssessment | null>;
}

export interface SystemCertificateRepository {
  save(certificate: SystemCertificate): Promise<SystemCertificate>;
  getById(certificateId: string): Promise<SystemCertificate | null>;
  getByMaterialFingerprint(
    fingerprint: string,
  ): Promise<SystemCertificate | null>;
  getByRun(assuranceRunId: string): Promise<SystemCertificate | null>;
}

export interface SystemCertificateRevocationRepository {
  save(
    revocation: SystemCertificateRevocation,
  ): Promise<SystemCertificateRevocation>;
  listByCertificate(
    certificateId: string,
  ): Promise<SystemCertificateRevocation[]>;
}

export interface AssuranceAuditRepository {
  append(event: AssuranceAuditEvent): Promise<AssuranceAuditEvent>;
  listByRun(assuranceRunId: string): Promise<AssuranceAuditEvent[]>;
}
