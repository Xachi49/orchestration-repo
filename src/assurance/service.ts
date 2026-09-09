import { randomUUID } from "node:crypto";
import type { CanonicalAuthorityGrantPort } from "../governance/canonical-authority.js";
import { isGovernanceError } from "../governance/errors.js";
import type { GovernanceOrchestrationService } from "../governance/service.js";
import { finalizeAssessment } from "./assessment.js";
import type { AssuranceAuditEvent, AssuranceAuditEventType } from "./audit.js";
import { evaluateArchitectureConformance } from "./architecture-conformance.js";
import { compileChallengePlan } from "./challenge.js";
import {
  assertCertificateCurrentlyValid,
  computeCertificateHash,
  computeCertificationMaterialFingerprint,
  mintCertificateId,
  withCertificateHash,
  type SystemCertificate,
} from "./certification.js";
import {
  CORE_CONTROL_CATALOG,
  computeControlCatalogHash,
  getControlById,
} from "./control.js";
import { ASSURANCE_EVALUATOR_VERSION, CONTROL_CATALOG_VERSION } from "./doctrine.js";
import {
  evaluateControl,
  computeEvaluationSetFingerprint,
} from "./evaluation.js";
import {
  computeEvidenceSetFingerprint,
  recomputeEvidenceContentHash,
  withEvidenceHash,
  type AssuranceEvidenceRecord,
} from "./evidence.js";
import { AssuranceError, isAssuranceError } from "./errors.js";
import {
  assertFaultInjectionAllowed,
  createFaultInjectionRegistry,
  type FaultInjectionPoint,
  type FaultInjectionRegistry,
  type FaultInjectionRequest,
} from "./fault-injection.js";
import {
  assertProfileActive,
  mintCoreSystemQualificationProfile,
  type AssuranceProfile,
} from "./profile.js";
import { replayDeterministic } from "./replay.js";
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
import {
  mintRevocationId,
  withRevocationHash,
} from "./revocation.js";
import {
  compileCertificationSubjectBinding,
  compileRevocationSubjectBinding,
  compileRunInitiationSubjectBinding,
  mintAssuranceRunId,
  type AssuranceRun,
} from "./run.js";
import {
  assertTargetMatches,
  computeTargetFingerprint,
  type AssuranceTargetIdentity,
} from "./target.js";

export interface AssuranceOrchestrationDeps {
  nowIso: () => string;
  profiles: AssuranceProfileRepository;
  runs: AssuranceRunRepository;
  challengePlans: AssuranceChallengePlanRepository;
  evidence: AssuranceEvidenceRepository;
  evaluations: AssuranceControlEvaluationRepository;
  findings: AssuranceFindingRepository;
  assessments: AssuranceAssessmentRepository;
  certificates: SystemCertificateRepository;
  revocations: SystemCertificateRevocationRepository;
  audits: AssuranceAuditRepository;
  governance: GovernanceOrchestrationService;
  canonicalAuthority: CanonicalAuthorityGrantPort;
  runCertification?: <T>(fn: () => Promise<T>) => Promise<T>;
  certificationFailpoint?: { name: string; trigger: () => void };
  faultInjection?: FaultInjectionRegistry;
}

export class AssuranceOrchestrationService {
  private readonly faults: FaultInjectionRegistry;

  constructor(private readonly deps: AssuranceOrchestrationDeps) {
    this.faults = deps.faultInjection ?? createFaultInjectionRegistry();
  }

  async ensureCoreProfile(): Promise<AssuranceProfile> {
    const existing = await this.deps.profiles.getActive(
      "CORE_SYSTEM_QUALIFICATION",
    );
    if (existing) return existing;
    const profile = mintCoreSystemQualificationProfile(this.deps.nowIso());
    return this.deps.profiles.save(profile);
  }

  async createRun(input: {
    target: AssuranceTargetIdentity;
    profileId: string;
    profileVersion: number;
    initiatedByPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: AssuranceRun["environment"];
    /** Pre-minted id so Phase20 proof subject can bind before create. */
    assuranceRunId?: string;
  }): Promise<AssuranceRun> {
    const profile = await this.deps.profiles.getByIdVersion(
      input.profileId,
      input.profileVersion,
    );
    if (!profile) {
      throw new AssuranceError(
        "ASSURANCE_PROFILE_INVALID",
        `Profile ${input.profileId}@${input.profileVersion} not found`,
      );
    }
    assertProfileActive(profile);
    if (!profile.allowedEnvironments.includes(input.environment)) {
      throw new AssuranceError(
        "ASSURANCE_PROFILE_INVALID",
        `Environment ${input.environment} not allowed for profile`,
      );
    }

    const targetFingerprint = computeTargetFingerprint(input.target);
    if (
      input.target.assuranceProfileId !== profile.profileId ||
      input.target.assuranceProfileVersion !== profile.profileVersion ||
      input.target.assuranceProfileHash !== profile.profileHash
    ) {
      throw new AssuranceError(
        "ASSURANCE_TARGET_INVALID",
        "Target identity profile binding mismatch",
      );
    }

    const assuranceRunId = input.assuranceRunId ?? mintAssuranceRunId();
    if (input.assuranceRunId) {
      const existing = await this.deps.runs.getById(assuranceRunId);
      if (existing) {
        throw new AssuranceError(
          "ASSURANCE_STATE_CONFLICT",
          `Assurance run ${assuranceRunId} already exists`,
        );
      }
    }
    const subject = compileRunInitiationSubjectBinding({
      assuranceRunId,
      targetFingerprint,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileHash: profile.profileHash,
    });
    await this.validateProof({
      proofId: input.institutionalAuthorizationProofId,
      ...subject,
      projectId: input.projectId,
      environment: input.environment,
    });

    const now = this.deps.nowIso();
    const run: AssuranceRun = {
      assuranceRunId,
      targetIdentity: input.target,
      targetFingerprint,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileHash: profile.profileHash,
      initiatedByPrincipalId: input.initiatedByPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      environment: input.environment,
      status: "CREATED",
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
    };
    const saved = await this.deps.runs.save(run);
    await this.audit("ASSURANCE_RUN_CREATED", {
      assuranceRunId: saved.assuranceRunId,
      payload: {
        targetFingerprint,
        profileId: profile.profileId,
        createsZeroOperationalAuthority: true,
      },
    });
    return saved;
  }

  async compilePlan(assuranceRunId: string): Promise<AssuranceRun> {
    const run = await this.requireRun(assuranceRunId);
    if (run.status !== "CREATED" && run.status !== "PLANNED") {
      throw new AssuranceError(
        "ASSURANCE_STATE_CONFLICT",
        `Cannot compile plan from ${run.status}`,
      );
    }
    const profile = await this.requireProfile(run.profileId, run.profileVersion);
    const plan = compileChallengePlan({
      profile,
      target: run.targetIdentity,
      compiledAt: this.deps.nowIso(),
    });
    await this.deps.challengePlans.save(plan);
    const next = await this.deps.runs.transition(
      run.assuranceRunId,
      run.status,
      run.recordRevision,
      "PLANNED",
      this.deps.nowIso(),
      {
        challengePlanId: plan.planId,
        challengePlanHash: plan.planHash,
      },
    );
    await this.audit("CHALLENGE_PLAN_COMPILED", {
      assuranceRunId,
      payload: { planId: plan.planId, planHash: plan.planHash },
    });
    return next;
  }

  /**
   * Trusted internal adapter only — never accept PASS from public HTTP body.
   */
  async recordTrustedEvidence(
    evidence: Omit<AssuranceEvidenceRecord, "contentHash"> & {
      contentHash?: string;
    },
  ): Promise<AssuranceEvidenceRecord> {
    const run = await this.requireRun(evidence.assuranceRunId);
    if (evidence.targetFingerprint !== run.targetFingerprint) {
      throw new AssuranceError(
        "ASSURANCE_TARGET_DRIFT",
        "Evidence target fingerprint mismatch",
      );
    }
    const saved = await this.deps.evidence.save(withEvidenceHash(evidence));
    await this.audit("EVIDENCE_RECORDED", {
      assuranceRunId: run.assuranceRunId,
      payload: {
        evidenceId: saved.evidenceId,
        contentHash: saved.contentHash,
        resultCode: saved.resultCode,
      },
    });
    return saved;
  }

  async evaluate(assuranceRunId: string): Promise<{
    run: AssuranceRun;
    assessmentId: string;
    outcome: "QUALIFIED" | "NOT_QUALIFIED" | "INCONCLUSIVE";
  }> {
    const run = await this.requireRun(assuranceRunId);
    if (run.status !== "PLANNED" && run.status !== "EVALUATING") {
      throw new AssuranceError(
        "ASSURANCE_STATE_CONFLICT",
        `Cannot evaluate from ${run.status}`,
      );
    }
    const profile = await this.requireProfile(run.profileId, run.profileVersion);
    let working = run;
    if (run.status === "PLANNED") {
      working = await this.deps.runs.transition(
        run.assuranceRunId,
        "PLANNED",
        run.recordRevision,
        "EVALUATING",
        this.deps.nowIso(),
      );
    }

    const evidence = await this.deps.evidence.listByRun(assuranceRunId);
    const now = this.deps.nowIso();
    const requiredControls = profile.requiredControlIds.map((id) => {
      const c = getControlById(id);
      if (!c) {
        throw new AssuranceError(
          "ASSURANCE_CONTROL_MISSING",
          `Control ${id} missing from catalog`,
        );
      }
      return c;
    });

    const arch = evaluateArchitectureConformance();
    const archControlMap: Record<string, string> = {
      ARCH_ONE_AUTHORITY_REGISTRY: "ONE_CANONICAL_AUTHORITY_REGISTRY",
      ARCH_FED_ENTERS_PHASE2: "FEDERATION_ENTERS_PHASE2",
      CONST_CURRENT_AUTHORIZES_PROPOSED: "CONSTITUTIONAL_GATE_PROTECTED",
      MIG_COMPATIBILITY: "SUPPORTED_SCHEMA_MATCHES_HEAD",
      SEC_PROD_FAULT_DENIED: "NO_ASSURANCE_SHELL_CHALLENGE",
    };
    void ASSURANCE_EVALUATOR_VERSION;
    void CONTROL_CATALOG_VERSION;

    for (const control of requiredControls) {
      const ruleId = archControlMap[control.controlId];
      const rule = ruleId
        ? arch.results.find((r) => r.ruleId === ruleId)
        : undefined;
      const evaluation =
        rule !== undefined
          ? {
              evaluationId: `aeval_${assuranceRunId}_${control.controlId}`,
              controlId: control.controlId,
              controlVersion: control.controlVersion,
              targetFingerprint: working.targetFingerprint,
              evidenceIds: evidence
                .filter((e) => e.controlIds.includes(control.controlId))
                .map((e) => e.evidenceId)
                .sort(),
              evidenceHashes: evidence
                .filter((e) => e.controlIds.includes(control.controlId))
                .map((e) => e.contentHash)
                .sort(),
              evaluatorVersion: ASSURANCE_EVALUATOR_VERSION,
              result: (rule.result === "PASS" ? "PASS" : "FAIL") as
                | "PASS"
                | "FAIL",
              reasonCode: rule.reasonCode,
              evaluatedAt: now,
            }
          : evaluateControl({
              control,
              targetFingerprint: working.targetFingerprint,
              evidence,
              evaluatedAt: now,
              evaluationId: `aeval_${assuranceRunId}_${control.controlId}`,
            });
      await this.deps.evaluations.saveForRun(assuranceRunId, evaluation);
      await this.audit("CONTROL_EVALUATED", {
        assuranceRunId,
        payload: {
          controlId: control.controlId,
          result: evaluation.result,
          reasonCode: evaluation.reasonCode,
        },
      });
    }

    const evaluations = await this.deps.evaluations.listByRun(assuranceRunId);
    const evidenceSetFingerprint = computeEvidenceSetFingerprint(evidence);
    const evaluationSetFingerprint =
      computeEvaluationSetFingerprint(evaluations);
    const { assessment, findings } = finalizeAssessment({
      assuranceRunId,
      targetFingerprint: working.targetFingerprint,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileHash: profile.profileHash,
      requiredControls,
      evaluations,
      evidenceSetFingerprint,
      evaluationSetFingerprint,
      assessedAt: now,
    });
    await this.deps.assessments.save(assessment);
    for (const finding of findings) {
      await this.deps.findings.save(finding);
      await this.audit("FINDING_RECORDED", {
        assuranceRunId,
        payload: {
          findingId: finding.findingId,
          code: finding.code,
          severity: finding.severity,
        },
      });
    }
    await this.audit("ASSESSMENT_FINALIZED", {
      assuranceRunId,
      payload: {
        assessmentId: assessment.assessmentId,
        outcome: assessment.outcome,
        assessmentHash: assessment.assessmentHash,
      },
    });

    const toStatus =
      assessment.outcome === "QUALIFIED"
        ? "EVALUATED"
        : assessment.outcome === "NOT_QUALIFIED"
          ? "FAILED"
          : "INCONCLUSIVE";
    const next = await this.deps.runs.transition(
      working.assuranceRunId,
      "EVALUATING",
      working.recordRevision,
      toStatus,
      now,
      {
        assessmentId: assessment.assessmentId,
        assessmentHash: assessment.assessmentHash,
      },
    );
    return {
      run: next,
      assessmentId: assessment.assessmentId,
      outcome: assessment.outcome,
    };
  }

  async certify(input: {
    assuranceRunId: string;
    certifierPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
    currentTarget?: AssuranceTargetIdentity;
  }): Promise<SystemCertificate> {
    const runTx =
      this.deps.runCertification ??
      (async <T>(fn: () => Promise<T>) => fn());

    return runTx(async () => {
      const run = await this.requireRun(input.assuranceRunId);
      const assessment = await this.deps.assessments.getByRun(
        input.assuranceRunId,
      );
      if (!assessment) {
        throw new AssuranceError(
          "ASSURANCE_NOT_QUALIFIED",
          "No assessment available for certification",
        );
      }
      if (assessment.outcome !== "QUALIFIED") {
        throw new AssuranceError(
          assessment.outcome === "INCONCLUSIVE"
            ? "ASSURANCE_INCONCLUSIVE"
            : "ASSURANCE_NOT_QUALIFIED",
          `Assessment outcome ${assessment.outcome} cannot be certified`,
        );
      }

      if (run.initiatedByPrincipalId === input.certifierPrincipalId) {
        throw new AssuranceError(
          "ASSURANCE_SEPARATION_VIOLATION",
          "Certifier must be independent from assurance run initiator",
        );
      }

      const profile = await this.requireProfile(
        run.profileId,
        run.profileVersion,
      );
      if (profile.requireIndependentCertifier === false) {
        // still enforce default SoD above
      }

      const target = input.currentTarget ?? run.targetIdentity;
      assertTargetMatches(run.targetFingerprint, target);

      const evidence = await this.deps.evidence.listByRun(input.assuranceRunId);
      const evidenceSetFingerprint = computeEvidenceSetFingerprint(evidence);
      if (evidenceSetFingerprint !== assessment.evidenceSetFingerprint) {
        throw new AssuranceError(
          "ASSURANCE_EVIDENCE_TAMPERED",
          "Evidence set fingerprint mismatch",
        );
      }

      const now = this.deps.nowIso();
      for (const e of evidence) {
        const ageMs = Date.parse(now) - Date.parse(e.generatedAt);
        if (ageMs > profile.evidenceFreshnessSeconds * 1000) {
          throw new AssuranceError(
            "ASSURANCE_EVIDENCE_STALE",
            `Evidence ${e.evidenceId} is stale`,
          );
        }
      }

      const subject = compileCertificationSubjectBinding({
        assuranceRunId: run.assuranceRunId,
        targetFingerprint: run.targetFingerprint,
        profileId: run.profileId,
        profileVersion: run.profileVersion,
        profileHash: run.profileHash,
        assessmentId: assessment.assessmentId,
        assessmentHash: assessment.assessmentHash,
      });
      const proof = await this.validateProof({
        proofId: input.institutionalAuthorizationProofId,
        ...subject,
        projectId: input.projectId,
        environment: input.environment,
      });

      const controlCatalogFingerprint = computeControlCatalogHash(
        CORE_CONTROL_CATALOG,
      );
      const materialFingerprint = computeCertificationMaterialFingerprint({
        targetFingerprint: run.targetFingerprint,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        profileHash: profile.profileHash,
        assessmentId: assessment.assessmentId,
        assessmentHash: assessment.assessmentHash,
        evidenceSetFingerprint,
        controlCatalogFingerprint,
        proofId: input.institutionalAuthorizationProofId,
        proofHash: proof.proofHash,
        validitySeconds: profile.certificationValiditySeconds,
      });

      const existing =
        await this.deps.certificates.getByMaterialFingerprint(
          materialFingerprint,
        );
      if (existing) {
        return existing;
      }

      const existingForRun = await this.deps.certificates.getByRun(
        run.assuranceRunId,
      );
      if (
        existingForRun &&
        existingForRun.certificationMaterialFingerprint !== materialFingerprint
      ) {
        throw new AssuranceError(
          "ASSURANCE_CERTIFICATION_CONFLICT",
          "Incompatible certification material for assurance run",
          {
            assuranceRunId: run.assuranceRunId,
            existing: existingForRun.certificationMaterialFingerprint,
            attempted: materialFingerprint,
          },
        );
      }

      const validUntil = new Date(
        Date.parse(now) + profile.certificationValiditySeconds * 1000,
      ).toISOString();
      const certificateId = mintCertificateId(materialFingerprint);
      const certificate = withCertificateHash({
        certificateId,
        certificateVersion: 1,
        certificationMaterialFingerprint: materialFingerprint,
        targetFingerprint: run.targetFingerprint,
        profileId: profile.profileId,
        profileVersion: profile.profileVersion,
        profileHash: profile.profileHash,
        assuranceRunId: run.assuranceRunId,
        assessmentId: assessment.assessmentId,
        assessmentHash: assessment.assessmentHash,
        controlCatalogFingerprint,
        evidenceSetFingerprint,
        certifierPrincipalId: input.certifierPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId,
        proofHash: proof.proofHash,
        issuedAt: now,
        validUntil,
        status: "VALID",
        recordRevision: 1,
      });

      const saved = await this.deps.certificates.save(certificate);
      if (this.deps.certificationFailpoint) {
        this.deps.certificationFailpoint.trigger();
      }
      this.faults.maybeTrigger(
        "AFTER_CERTIFICATE_MATERIAL_BEFORE_COMMIT",
        run.assuranceRunId,
      );

      await this.audit("CERTIFICATION_DECIDED", {
        assuranceRunId: run.assuranceRunId,
        certificateId: saved.certificateId,
        payload: {
          decision: "ISSUED",
          createsZeroOperationalAuthority: true,
        },
      });
      await this.audit("CERTIFICATE_ISSUED", {
        assuranceRunId: run.assuranceRunId,
        certificateId: saved.certificateId,
        payload: {
          certificateHash: saved.certificateHash,
          targetFingerprint: saved.targetFingerprint,
          createsZeroOperationalAuthority: true,
        },
      });
      return saved;
    });
  }

  async getCertificateCurrentValidity(input: {
    certificateId: string;
    currentTarget: AssuranceTargetIdentity;
    atIso?: string;
  }): Promise<{
    certificate: SystemCertificate;
    currentValidity: import("./certification.js").CurrentCertificateValidationResult;
  }> {
    const certificate = await this.deps.certificates.getById(
      input.certificateId,
    );
    if (!certificate) {
      throw new AssuranceError(
        "ASSURANCE_NOT_FOUND",
        `Certificate ${input.certificateId} not found`,
      );
    }
    const revocations = await this.deps.revocations.listByCertificate(
      input.certificateId,
    );
    const atIso = input.atIso ?? this.deps.nowIso();
    const { evaluateCertificateCurrentValidity } = await import(
      "./certification.js"
    );
    const currentValidity = evaluateCertificateCurrentValidity({
      certificate,
      currentTargetFingerprint: computeTargetFingerprint(input.currentTarget),
      atIso,
      revoked: revocations.some(
        (r) => Date.parse(r.effectiveAt) <= Date.parse(atIso),
      ),
    });
    return { certificate, currentValidity };
  }

  /**
   * Recompute evidence content hashes from stored evidence material only.
   * Never accepts a candidate / caller target — substitution must not alter
   * the meaning of historical evidence hashes.
   */
  async assertEvidenceIntegrity(assuranceRunId: string): Promise<void> {
    const assessment = await this.deps.assessments.getByRun(assuranceRunId);
    if (!assessment) {
      throw new AssuranceError(
        "ASSURANCE_NOT_QUALIFIED",
        "No assessment for evidence integrity check",
      );
    }
    const evidence = await this.deps.evidence.listByRun(assuranceRunId);
    for (const e of evidence) {
      const recomputed = recomputeEvidenceContentHash(e);
      if (recomputed !== e.contentHash) {
        throw new AssuranceError(
          "ASSURANCE_EVIDENCE_TAMPERED",
          `Evidence ${e.evidenceId} content hash mismatch`,
          { evidenceId: e.evidenceId },
        );
      }
    }
    const setFp = computeEvidenceSetFingerprint(evidence);
    if (setFp !== assessment.evidenceSetFingerprint) {
      throw new AssuranceError(
        "ASSURANCE_EVIDENCE_TAMPERED",
        "Evidence set fingerprint mismatch vs assessment",
      );
    }
  }

  async validateCertificate(input: {
    certificateId: string;
    currentTarget: AssuranceTargetIdentity;
    atIso?: string;
  }): Promise<SystemCertificate> {
    // 1. Load immutable certificate
    const certificate = await this.deps.certificates.getById(
      input.certificateId,
    );
    if (!certificate) {
      throw new AssuranceError(
        "ASSURANCE_NOT_FOUND",
        `Certificate ${input.certificateId} not found`,
      );
    }

    // 2. Verify certificate issuance hash/material (no mutation)
    const { certificateHash: issuedHash, ...issuanceMaterial } = certificate;
    if (computeCertificateHash(issuanceMaterial) !== issuedHash) {
      throw new AssuranceError(
        "ASSURANCE_CERTIFICATION_CONFLICT",
        "Certificate issuance hash does not match immutable material",
        { certificateId: certificate.certificateId },
      );
    }

    // 3. Compute candidate target fingerprint
    const atIso = input.atIso ?? this.deps.nowIso();
    const candidateTargetFingerprint = computeTargetFingerprint(
      input.currentTarget,
    );

    // 4. Target drift precedes evidence integrity. Unchanged E1 + candidate T2
    // must classify as TARGET_DRIFT — never inspect evidence against T2.
    if (certificate.targetFingerprint !== candidateTargetFingerprint) {
      await this.audit("TARGET_DRIFT_DETECTED", {
        assuranceRunId: certificate.assuranceRunId,
        certificateId: certificate.certificateId,
        payload: {
          currentValidity: "STALE",
          certified: certificate.targetFingerprint,
          current: candidateTargetFingerprint,
        },
      });
      throw new AssuranceError(
        "ASSURANCE_TARGET_DRIFT",
        "Certificate target fingerprint does not match current target",
        {
          certified: certificate.targetFingerprint,
          current: candidateTargetFingerprint,
          currentValidity: "STALE",
        },
      );
    }

    // 5–6. Only after exact target match: load bound assessment/evidence and
    // assert stored evidence integrity (hash inputs from evidence alone).
    await this.assertEvidenceIntegrity(certificate.assuranceRunId);

    // 7–10. Freshness, revocation, provenance overlay → current validity
    const revocations = await this.deps.revocations.listByCertificate(
      input.certificateId,
    );
    const { evaluateCertificateCurrentValidity } = await import(
      "./certification.js"
    );
    const currentValidity = evaluateCertificateCurrentValidity({
      certificate,
      currentTargetFingerprint: candidateTargetFingerprint,
      atIso,
      revoked: revocations.some(
        (r) => Date.parse(r.effectiveAt) <= Date.parse(atIso),
      ),
    });
    if (currentValidity !== "VALID") {
      assertCertificateCurrentlyValid({
        certificate,
        currentTargetFingerprint: candidateTargetFingerprint,
        atIso,
        revoked: currentValidity === "REVOKED",
      });
    }

    return certificate;
  }

  async revokeCertificate(input: {
    certificateId: string;
    reason: string;
    revokedByPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
  }) {
    const certificate = await this.deps.certificates.getById(
      input.certificateId,
    );
    if (!certificate) {
      throw new AssuranceError(
        "ASSURANCE_NOT_FOUND",
        `Certificate ${input.certificateId} not found`,
      );
    }
    const subject = compileRevocationSubjectBinding({
      certificateId: certificate.certificateId,
      certificateHash: certificate.certificateHash,
    });
    const proof = await this.validateProof({
      proofId: input.institutionalAuthorizationProofId,
      ...subject,
      projectId: input.projectId,
      environment: input.environment,
    });
    const now = this.deps.nowIso();
    const revocation = withRevocationHash({
      revocationId: mintRevocationId(),
      certificateId: certificate.certificateId,
      certificateHash: certificate.certificateHash,
      reason: input.reason,
      revokedByPrincipalId: input.revokedByPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      proofHash: proof.proofHash,
      effectiveAt: now,
      createdAt: now,
    });
    // Historical certificate row is immutable — revocation is overlay only.
    await this.deps.revocations.save(revocation);
    await this.audit("CERTIFICATE_REVOKED", {
      assuranceRunId: certificate.assuranceRunId,
      certificateId: certificate.certificateId,
      payload: {
        revocationId: revocation.revocationId,
        historyPreserved: true,
        certificateHashUnchanged: certificate.certificateHash,
      },
    });
    return revocation;
  }

  armFaultInjection(request: FaultInjectionRequest): void {
    this.faults.arm(request);
  }

  assertProductionFaultDenied(request: FaultInjectionRequest): void {
    assertFaultInjectionAllowed(request);
  }

  replay(input: Parameters<typeof replayDeterministic>[0]) {
    return replayDeterministic(input);
  }

  getRun(assuranceRunId: string) {
    return this.deps.runs.getById(assuranceRunId);
  }

  listFindings(assuranceRunId: string) {
    return this.deps.findings.listByRun(assuranceRunId);
  }

  getCertificate(certificateId: string) {
    return this.deps.certificates.getById(certificateId);
  }

  getAssessmentByRun(assuranceRunId: string) {
    return this.deps.assessments.getByRun(assuranceRunId);
  }

  getCertificateByRun(assuranceRunId: string) {
    return this.deps.certificates.getByRun(assuranceRunId);
  }

  listRevocations(certificateId: string) {
    return this.deps.revocations.listByCertificate(certificateId);
  }

  listAuditsByRun(assuranceRunId: string) {
    return this.deps.audits.listByRun(assuranceRunId);
  }

  private async requireRun(assuranceRunId: string): Promise<AssuranceRun> {
    const run = await this.deps.runs.getById(assuranceRunId);
    if (!run) {
      throw new AssuranceError(
        "ASSURANCE_NOT_FOUND",
        `Run ${assuranceRunId} not found`,
      );
    }
    return run;
  }

  private async requireProfile(
    profileId: string,
    profileVersion: number,
  ): Promise<AssuranceProfile> {
    const profile = await this.deps.profiles.getByIdVersion(
      profileId,
      profileVersion,
    );
    if (!profile) {
      throw new AssuranceError(
        "ASSURANCE_PROFILE_INVALID",
        `Profile ${profileId}@${profileVersion} not found`,
      );
    }
    return profile;
  }

  private async validateProof(input: {
    proofId: string;
    subjectType: string;
    subjectId: string;
    subjectHash: string;
    subjectVersion?: number;
    requiredRole: string;
    action: string;
    projectId: string;
    environment: string;
  }) {
    try {
      return await this.deps.governance.validateProof({
        proofId: input.proofId,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectHash: input.subjectHash,
        ...(input.subjectVersion !== undefined
          ? { subjectVersion: input.subjectVersion }
          : {}),
        requiredRole: input.requiredRole,
        action: input.action,
        projectId: input.projectId,
        environment: input.environment,
        atIso: this.deps.nowIso(),
      });
    } catch (error) {
      if (isGovernanceError(error) && error.code === "GOVERNANCE_PROOF_STALE") {
        throw new AssuranceError(
          "ASSURANCE_PROOF_STALE",
          "Assurance proof provenance is stale",
          { proofId: input.proofId },
        );
      }
      throw new AssuranceError(
        "ASSURANCE_AUTHORITY_REQUIRED",
        "Assurance authority proof validation failed",
        {
          proofId: input.proofId,
          cause: isGovernanceError(error) ? error.code : "UNKNOWN",
        },
      );
    }
  }

  private async audit(
    eventType: AssuranceAuditEventType,
    input: {
      assuranceRunId?: string;
      certificateId?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const event: AssuranceAuditEvent = {
      auditEventId: randomUUID(),
      eventType,
      ...(input.assuranceRunId !== undefined
        ? { assuranceRunId: input.assuranceRunId }
        : {}),
      ...(input.certificateId !== undefined
        ? { certificateId: input.certificateId }
        : {}),
      payload: input.payload,
      createdAt: this.deps.nowIso(),
    };
    await this.deps.audits.append(event);
  }
}

export type { FaultInjectionPoint };
