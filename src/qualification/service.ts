import { randomUUID } from "node:crypto";
import type { SystemCertificate } from "../assurance/certification.js";
import {
  evaluateCertificateCurrentValidity,
  type CurrentCertificateValidationResult,
} from "../assurance/certification.js";
import type { QualificationAuditEvent, QualificationAuditEventType } from "./audit.js";
import { QualificationError } from "./errors.js";
import { evaluateReleaseQualificationOutcome } from "./qualification-evaluator.js";
import {
  computeQualificationEvidenceSetFingerprint,
  mintQualificationEvidenceId,
  withQualificationEvidenceHash,
  type QualificationEvidenceKind,
  type QualificationEvidenceRecord,
} from "./qualification-evidence.js";
import {
  assertNoDeploymentFields,
  computeReleaseQualificationMaterialFingerprint,
  evaluateCurrentReleaseApplicability,
  mintReleaseQualificationRecordId,
  withReleaseQualificationRecordHash,
  type CurrentReleaseApplicability,
  type ReleaseQualificationRecord,
} from "./qualification-record.js";
import {
  mintQualificationRunId,
  ProductionQualificationRunSchema,
  type ProductionQualificationRun,
} from "./qualification-run.js";
import type { ReadinessReport } from "./readiness.js";
import {
  assertReleaseCandidateMatchesAssuranceTarget,
  computeReleaseCandidateFingerprint,
  type ReleaseCandidateIdentity,
} from "./release-candidate.js";
import {
  buildReleaseBundle,
  buildReleaseManifest,
  type ReleaseBundle,
  type ReleaseManifest,
} from "./release-manifest.js";
import type {
  ProductionQualificationRunRepository,
  QualificationAuditRepository,
  QualificationEvidenceRepository,
  ReleaseManifestRepository,
  ReleaseQualificationRecordRepository,
} from "./repositories.js";
import {
  assertReferenceRuntimeProductionEligible,
  type ReferenceRuntimeManifest,
} from "./runtime-manifest.js";
import { assertBuildArtifactIntegrity } from "./build-manifest.js";
import type { BuildArtifactManifest } from "./build-manifest.js";

export interface QualificationOrchestrationDeps {
  nowIso: () => string;
  runs: ProductionQualificationRunRepository;
  evidence: QualificationEvidenceRepository;
  records: ReleaseQualificationRecordRepository;
  manifests: ReleaseManifestRepository;
  audits: QualificationAuditRepository;
  /**
   * Load Phase23 certificate by id — caller supplies port; never fabricate.
   */
  getSystemCertificate: (
    certificateId: string,
  ) => Promise<SystemCertificate | null>;
  /**
   * Evaluate current Phase23 certificate validity (VALID/EXPIRED/REVOKED/STALE).
   */
  evaluateCertificateValidity: (input: {
    certificate: SystemCertificate;
    currentTargetFingerprint: string;
    atIso: string;
    revoked: boolean;
  }) => CurrentCertificateValidationResult;
  listCertificateRevoked: (certificateId: string) => Promise<boolean>;
  /**
   * Assert evidence integrity for the bound Phase23 certificate's run.
   */
  assertPhase23EvidenceIntegrity: (assuranceRunId: string) => Promise<void>;
  runFinalization?: <T>(
    fn: () => Promise<T>,
    lockKey: string,
  ) => Promise<T>;
  /** @internal TEST ONLY */
  qualificationFailpoint?: { name: string; trigger: () => void };
}

/**
 * Phase24 qualification orchestration.
 * Creates ZERO operational authority and performs ZERO deployments.
 */
export class QualificationOrchestrationService {
  constructor(private readonly deps: QualificationOrchestrationDeps) {}

  async createQualificationRun(input: {
    candidate: ReleaseCandidateIdentity;
    runtimeManifest: ReferenceRuntimeManifest;
    certificateId: string;
  }): Promise<ProductionQualificationRun> {
    assertReferenceRuntimeProductionEligible(input.runtimeManifest);
    const certificate = await this.requireCertificate(input.certificateId);
    assertReleaseCandidateMatchesAssuranceTarget(
      input.candidate,
      certificate.targetFingerprint,
    );
    if (input.runtimeManifest.manifestHash !== input.candidate.referenceRuntimeManifestHash) {
      throw new QualificationError(
        "REFERENCE_RUNTIME_DRIFT",
        "Candidate runtime manifest hash does not match provided manifest",
      );
    }
    const releaseCandidateFingerprint = computeReleaseCandidateFingerprint(
      input.candidate,
    );
    const run = ProductionQualificationRunSchema.parse({
      qualificationRunId: mintQualificationRunId(),
      releaseCandidateFingerprint,
      runtimeManifestHash: input.runtimeManifest.manifestHash,
      phase23CertificateId: certificate.certificateId,
      phase23CertificateHash: certificate.certificateHash,
      status: "CREATED",
      startedAt: this.deps.nowIso(),
      recordRevision: 1,
    });
    const saved = await this.deps.runs.save(run);
    await this.audit("QUALIFICATION_RUN_CREATED", {
      qualificationRunId: saved.qualificationRunId,
      payload: {
        releaseCandidateFingerprint,
        certificateId: certificate.certificateId,
      },
    });
    return saved;
  }

  /**
   * Trusted internal adapter only — never accept PASS from public HTTP/script body.
   * Same doctrine as Phase23 recordTrustedEvidence.
   */
  async recordTrustedEvidence(
    evidence: Omit<QualificationEvidenceRecord, "contentHash" | "evidenceId"> & {
      evidenceId?: string;
      contentHash?: string;
    },
  ): Promise<QualificationEvidenceRecord> {
    const saved = await this.deps.evidence.save(
      withQualificationEvidenceHash({
        ...evidence,
        evidenceId: evidence.evidenceId ?? mintQualificationEvidenceId(),
      }),
    );
    await this.audit("EVIDENCE_RECORDED", {
      qualificationRunId: saved.qualificationRunId,
      payload: {
        evidenceId: saved.evidenceId,
        evidenceKind: saved.evidenceKind,
        resultCode: saved.resultCode,
        trustedAdapter: true,
      },
    });
    return saved;
  }

  /**
   * Finalize an immutable ReleaseQualificationRecord.
   * Does not deploy, approve, execute, or grant authority.
   *
   * QUALIFIED_FOR_RELEASE requires trusted stored evidence identities — not
   * caller-supplied boolean "PASS" claims.
   */
  async finalizeQualification(input: {
    qualificationRunId: string;
    candidate: ReleaseCandidateIdentity;
    buildManifest: BuildArtifactManifest;
    runtimeManifest: ReferenceRuntimeManifest;
    readiness: ReadinessReport;
    /** Optional hint only — outcome is derived from trusted evidence. */
    systemEvidenceOverall?: "PASS" | "FAIL" | "INCONCLUSIVE";
    validUntil?: string;
  }): Promise<{
    run: ProductionQualificationRun;
    record: ReleaseQualificationRecord;
    manifest: ReleaseManifest | null;
    bundle: ReleaseBundle | null;
  }> {
    const finalize = async () => {
      const run = await this.requireRun(input.qualificationRunId);

      assertBuildArtifactIntegrity(input.buildManifest);
      assertReferenceRuntimeProductionEligible(input.runtimeManifest);

      const candidateFp = computeReleaseCandidateFingerprint(input.candidate);
      if (candidateFp !== run.releaseCandidateFingerprint) {
        throw new QualificationError(
          "RELEASE_CANDIDATE_DRIFT",
          "Qualification run candidate fingerprint mismatch",
        );
      }
      if (
        input.candidate.buildArtifactFingerprint !==
        input.buildManifest.buildArtifactFingerprint
      ) {
        throw new QualificationError(
          "BUILD_ARTIFACT_INTEGRITY_FAILED",
          "Candidate build fingerprint does not match build manifest",
        );
      }
      if (
        input.runtimeManifest.manifestHash !== run.runtimeManifestHash ||
        input.runtimeManifest.manifestHash !==
          input.candidate.referenceRuntimeManifestHash
      ) {
        throw new QualificationError(
          "REFERENCE_RUNTIME_DRIFT",
          "Runtime manifest drift during qualification",
        );
      }

      const certificate = await this.requireCertificate(run.phase23CertificateId);
      if (certificate.certificateHash !== run.phase23CertificateHash) {
        throw new QualificationError(
          "PHASE23_CERTIFICATE_INVALID",
          "Bound Phase23 certificate hash changed",
        );
      }
      assertReleaseCandidateMatchesAssuranceTarget(
        input.candidate,
        certificate.targetFingerprint,
      );

      await this.deps.assertPhase23EvidenceIntegrity(certificate.assuranceRunId);

      const revoked = await this.deps.listCertificateRevoked(
        certificate.certificateId,
      );
      const atIso = this.deps.nowIso();
      const currentValidity = this.deps.evaluateCertificateValidity({
        certificate,
        currentTargetFingerprint: input.candidate.assuranceTargetFingerprint,
        atIso,
        revoked,
      });
      const certificateCurrentlyValid = currentValidity === "VALID";

      await this.audit("READINESS_EVALUATED", {
        qualificationRunId: run.qualificationRunId,
        payload: {
          overall: input.readiness.overall,
          evidenceSetFingerprint: input.readiness.evidenceSetFingerprint,
        },
      });

      const evidence = await this.deps.evidence.listByRun(run.qualificationRunId);
      const systemEvidenceOverall = deriveSystemEvidenceOverall(evidence);
      if (
        input.systemEvidenceOverall !== undefined &&
        input.systemEvidenceOverall !== systemEvidenceOverall &&
        systemEvidenceOverall === "PASS"
      ) {
        // Caller cannot upgrade FAIL/INCONCLUSIVE; ignoring optimistic PASS hints is OK.
      }

      const outcome = evaluateReleaseQualificationOutcome({
        candidate: input.candidate,
        expectedCandidateFingerprint: candidateFp,
        certificate,
        certificateCurrentlyValid,
        readiness: input.readiness,
        systemEvidenceOverall,
      });

      // QUALIFIED_FOR_RELEASE requires critical trusted evidence kinds present.
      if (outcome === "QUALIFIED_FOR_RELEASE") {
        assertCriticalQualificationEvidence(evidence);
      }

      const systemFp =
        evidence.length > 0
          ? computeQualificationEvidenceSetFingerprint(evidence)
          : input.readiness.evidenceSetFingerprint;

      const materialFp = computeReleaseQualificationMaterialFingerprint({
        qualificationRunId: run.qualificationRunId,
        releaseCandidateFingerprint: candidateFp,
        buildArtifactFingerprint: input.buildManifest.buildArtifactFingerprint,
        referenceRuntimeManifestHash: input.runtimeManifest.manifestHash,
        phase23CertificateId: certificate.certificateId,
        phase23CertificateHash: certificate.certificateHash,
        readinessEvidenceSetFingerprint: input.readiness.evidenceSetFingerprint,
        systemQualificationEvidenceSetFingerprint: systemFp,
        outcome,
      });

      // Terminal run: idempotent retry vs conflicting material for SAME run.
      if (run.status !== "CREATED" && run.status !== "EVALUATING") {
        if (run.finalRecordId) {
          const existing = await this.deps.records.getById(run.finalRecordId);
          if (existing) {
            const existingMaterial =
              computeReleaseQualificationMaterialFingerprint({
                qualificationRunId: existing.qualificationRunId,
                releaseCandidateFingerprint:
                  existing.releaseCandidateFingerprint,
                buildArtifactFingerprint: existing.buildArtifactFingerprint,
                referenceRuntimeManifestHash:
                  existing.referenceRuntimeManifestHash,
                phase23CertificateId: existing.phase23CertificateId,
                phase23CertificateHash: existing.phase23CertificateHash,
                readinessEvidenceSetFingerprint:
                  existing.readinessEvidenceSetFingerprint,
                systemQualificationEvidenceSetFingerprint:
                  existing.systemQualificationEvidenceSetFingerprint,
                outcome: existing.outcome,
              });
            if (existingMaterial !== materialFp) {
              throw new QualificationError(
                "RELEASE_QUALIFICATION_CONFLICT",
                "Qualification run already finalized with different material",
                {
                  qualificationRunId: run.qualificationRunId,
                  existingRecordId: existing.recordId,
                },
              );
            }
            return this.completeWithExisting(run, existing, input.candidate);
          }
        }
        throw new QualificationError(
          "QUALIFICATION_STATE_CONFLICT",
          `Cannot finalize from ${run.status}`,
        );
      }

      const existingMaterial =
        await this.deps.records.getByMaterialFingerprint(materialFp);
      if (existingMaterial) {
        if (existingMaterial.qualificationRunId !== run.qualificationRunId) {
          throw new QualificationError(
            "RELEASE_QUALIFICATION_CONFLICT",
            "Material fingerprint bound to a different qualification run",
            {
              qualificationRunId: run.qualificationRunId,
              existingQualificationRunId: existingMaterial.qualificationRunId,
            },
          );
        }
        return this.completeWithExisting(run, existingMaterial, input.candidate);
      }

      const record = withReleaseQualificationRecordHash({
        recordId: mintReleaseQualificationRecordId(materialFp),
        recordVersion: 1,
        qualificationRunId: run.qualificationRunId,
        releaseCandidateFingerprint: candidateFp,
        buildArtifactFingerprint: input.buildManifest.buildArtifactFingerprint,
        referenceRuntimeManifestHash: input.runtimeManifest.manifestHash,
        phase23CertificateId: certificate.certificateId,
        phase23CertificateHash: certificate.certificateHash,
        phase23TargetFingerprint: certificate.targetFingerprint,
        readinessEvidenceSetFingerprint: input.readiness.evidenceSetFingerprint,
        systemQualificationEvidenceSetFingerprint: systemFp,
        evaluatedAt: atIso,
        ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
        outcome,
      });
      assertNoDeploymentFields(record);

      if (this.deps.qualificationFailpoint?.name === "AFTER_RECORD_BEFORE_COMMIT") {
        this.deps.qualificationFailpoint.trigger();
      }

      const savedRecord = await this.deps.records.save(record);

      let manifest: ReleaseManifest | null = null;
      if (savedRecord.outcome === "QUALIFIED_FOR_RELEASE") {
        manifest = await this.deps.manifests.save(
          buildReleaseManifest({
            candidate: input.candidate,
            releaseCandidateFingerprint: candidateFp,
            record: savedRecord,
          }),
        );
        await this.audit("RELEASE_MANIFEST_EMITTED", {
          qualificationRunId: run.qualificationRunId,
          recordId: savedRecord.recordId,
          payload: { manifestFingerprint: manifest.manifestFingerprint },
        });
      }

      const status =
        outcome === "QUALIFIED_FOR_RELEASE"
          ? "QUALIFIED"
          : outcome === "INCONCLUSIVE"
            ? "INCONCLUSIVE"
            : "NOT_QUALIFIED";

      const nextRun = ProductionQualificationRunSchema.parse({
        ...run,
        status,
        readinessEvidenceSetFingerprint: input.readiness.evidenceSetFingerprint,
        systemEvidenceSetFingerprint: systemFp,
        completedAt: atIso,
        finalRecordId: savedRecord.recordId,
        finalRecordHash: savedRecord.recordHash,
        recordRevision: run.recordRevision + 1,
      });
      const savedRun = await this.deps.runs.transition(
        run.qualificationRunId,
        run.recordRevision,
        nextRun,
      );

      await this.audit("QUALIFICATION_DECIDED", {
        qualificationRunId: savedRun.qualificationRunId,
        recordId: savedRecord.recordId,
        payload: { outcome, status },
      });
      await this.audit("RELEASE_RECORD_ISSUED", {
        qualificationRunId: savedRun.qualificationRunId,
        recordId: savedRecord.recordId,
        payload: {
          recordHash: savedRecord.recordHash,
          deploymentAuthorized: false,
        },
      });

      return {
        run: savedRun,
        record: savedRecord,
        manifest,
        bundle: manifest
          ? buildReleaseBundle(manifest, savedRecord)
          : null,
      };
    };

    if (this.deps.runFinalization) {
      return this.deps.runFinalization(finalize, input.qualificationRunId);
    }
    return finalize();
  }

  async getCurrentApplicability(input: {
    recordId: string;
    currentCandidate: ReleaseCandidateIdentity;
    currentRuntimeManifestHash: string;
    currentBuildArtifactFingerprint: string;
    atIso?: string;
  }): Promise<{
    record: ReleaseQualificationRecord;
    applicability: CurrentReleaseApplicability;
  }> {
    const record = await this.deps.records.getById(input.recordId);
    if (!record) {
      throw new QualificationError(
        "QUALIFICATION_NOT_FOUND",
        `Record ${input.recordId} not found`,
      );
    }
    const certificate = await this.requireCertificate(record.phase23CertificateId);
    let certificateCurrentlyValid = false;
    try {
      await this.deps.assertPhase23EvidenceIntegrity(certificate.assuranceRunId);
      const revoked = await this.deps.listCertificateRevoked(
        certificate.certificateId,
      );
      const validity = this.deps.evaluateCertificateValidity({
        certificate,
        currentTargetFingerprint: input.currentCandidate.assuranceTargetFingerprint,
        atIso: input.atIso ?? this.deps.nowIso(),
        revoked,
      });
      certificateCurrentlyValid =
        validity === "VALID" &&
        certificate.targetFingerprint ===
          input.currentCandidate.assuranceTargetFingerprint;
    } catch {
      certificateCurrentlyValid = false;
    }
    const applicability = evaluateCurrentReleaseApplicability({
      record,
      currentReleaseCandidateFingerprint: computeReleaseCandidateFingerprint(
        input.currentCandidate,
      ),
      currentRuntimeManifestHash: input.currentRuntimeManifestHash,
      currentBuildArtifactFingerprint: input.currentBuildArtifactFingerprint,
      phase23CertificateCurrentlyValid: certificateCurrentlyValid,
      evidenceIntegrityValid: true,
      atIso: input.atIso ?? this.deps.nowIso(),
    });
    return { record, applicability };
  }

  /** Explicit proof: qualification APIs never authorize deployment. */
  assertNoDeployer(): void {
    // Intentionally empty — no deployer exists in Phase24.
  }

  private async completeWithExisting(
    run: ProductionQualificationRun,
    existing: ReleaseQualificationRecord,
    candidate: ReleaseCandidateIdentity,
  ) {
    const manifest =
      existing.outcome === "QUALIFIED_FOR_RELEASE"
        ? await this.deps.manifests.save(
            buildReleaseManifest({
              candidate,
              releaseCandidateFingerprint: run.releaseCandidateFingerprint,
              record: existing,
            }),
          )
        : null;
    const bundle = manifest ? buildReleaseBundle(manifest, existing) : null;

    // Idempotent: run already bound to this terminal record.
    if (
      run.finalRecordId === existing.recordId &&
      run.status !== "CREATED" &&
      run.status !== "EVALUATING"
    ) {
      return { run, record: existing, manifest, bundle };
    }

    const status =
      existing.outcome === "QUALIFIED_FOR_RELEASE"
        ? "QUALIFIED"
        : existing.outcome === "INCONCLUSIVE"
          ? "INCONCLUSIVE"
          : "NOT_QUALIFIED";
    const nextRun = ProductionQualificationRunSchema.parse({
      ...run,
      status,
      readinessEvidenceSetFingerprint: existing.readinessEvidenceSetFingerprint,
      systemEvidenceSetFingerprint:
        existing.systemQualificationEvidenceSetFingerprint,
      completedAt: this.deps.nowIso(),
      finalRecordId: existing.recordId,
      finalRecordHash: existing.recordHash,
      recordRevision: run.recordRevision + 1,
    });
    const savedRun = await this.deps.runs.transition(
      run.qualificationRunId,
      run.recordRevision,
      nextRun,
    );
    return {
      run: savedRun,
      record: existing,
      manifest,
      bundle,
    };
  }

  private async buildManifestFor(
    candidate: ReleaseCandidateIdentity,
    record: ReleaseQualificationRecord,
  ): Promise<ReleaseManifest> {
    return buildReleaseManifest({
      candidate,
      releaseCandidateFingerprint: record.releaseCandidateFingerprint,
      record,
    });
  }

  private async requireRun(
    qualificationRunId: string,
  ): Promise<ProductionQualificationRun> {
    const run = await this.deps.runs.getById(qualificationRunId);
    if (!run) {
      throw new QualificationError(
        "QUALIFICATION_NOT_FOUND",
        `Qualification run ${qualificationRunId} not found`,
      );
    }
    return run;
  }

  private async requireCertificate(
    certificateId: string,
  ): Promise<SystemCertificate> {
    const certificate = await this.deps.getSystemCertificate(certificateId);
    if (!certificate) {
      throw new QualificationError(
        "PHASE23_CERTIFICATE_REQUIRED",
        `Phase23 certificate ${certificateId} required`,
      );
    }
    return certificate;
  }

  private async audit(
    eventType: QualificationAuditEventType,
    input: {
      qualificationRunId?: string;
      recordId?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const event: QualificationAuditEvent = {
      auditEventId: randomUUID(),
      eventType,
      ...(input.qualificationRunId !== undefined
        ? { qualificationRunId: input.qualificationRunId }
        : {}),
      ...(input.recordId !== undefined ? { recordId: input.recordId } : {}),
      payload: input.payload,
      createdAt: this.deps.nowIso(),
    };
    await this.deps.audits.append(event);
  }
}

// Re-export helper used by tests / wiring
export { evaluateCertificateCurrentValidity };

const CRITICAL_QUALIFICATION_EVIDENCE_KINDS: readonly QualificationEvidenceKind[] =
  [
    "PHASE23_CERTIFICATE_REF",
    "READINESS_REPORT",
    "GOLDEN_PATH_ACCEPTANCE",
    "RESTART_RECOVERY",
    "BUILD_MANIFEST_VERIFICATION",
  ];

function deriveSystemEvidenceOverall(
  evidence: readonly QualificationEvidenceRecord[],
): "PASS" | "FAIL" | "INCONCLUSIVE" {
  const critical = evidence.filter((e) =>
    CRITICAL_QUALIFICATION_EVIDENCE_KINDS.includes(e.evidenceKind),
  );
  if (critical.length < CRITICAL_QUALIFICATION_EVIDENCE_KINDS.length) {
    return "INCONCLUSIVE";
  }
  if (critical.some((e) => e.resultCode === "FAIL")) return "FAIL";
  if (critical.some((e) => e.resultCode === "INCONCLUSIVE")) return "INCONCLUSIVE";
  if (critical.every((e) => e.resultCode === "PASS")) return "PASS";
  return "INCONCLUSIVE";
}

function assertCriticalQualificationEvidence(
  evidence: readonly QualificationEvidenceRecord[],
): void {
  for (const kind of CRITICAL_QUALIFICATION_EVIDENCE_KINDS) {
    const hit = evidence.find((e) => e.evidenceKind === kind);
    if (!hit) {
      throw new QualificationError(
        "QUALIFICATION_EVIDENCE_MISSING",
        `Missing trusted qualification evidence kind: ${kind}`,
        { evidenceKind: kind },
      );
    }
    if (hit.resultCode !== "PASS") {
      throw new QualificationError(
        "QUALIFICATION_INCONCLUSIVE",
        `Critical evidence ${kind} is ${hit.resultCode}`,
        { evidenceKind: kind, resultCode: hit.resultCode },
      );
    }
    if (!hit.referencedIdentity || !hit.referencedHash) {
      throw new QualificationError(
        "QUALIFICATION_EVIDENCE_MISSING",
        `Evidence ${kind} missing referenced identity/hash`,
      );
    }
  }
}
