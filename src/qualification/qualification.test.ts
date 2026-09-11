import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { evaluateArchitectureConformance } from "../assurance/architecture-conformance.js";
import {
  evaluateCertificateCurrentValidity,
  withCertificateHash,
} from "../assurance/certification.js";
import { SUPPORTED_SCHEMA_VERSION } from "../domain/durability/index.js";
import {
  FINAL_SYSTEM_DOCTRINE,
  QUALIFICATION_DOCTRINE,
  assertBuildArtifactIntegrity,
  assertProductionConfigEligible,
  assertReferenceRuntimeProductionEligible,
  assertReleaseCandidateMatchesAssuranceTarget,
  beginDrain,
  buildReleaseManifest,
  completeStop,
  computeBuildArtifactFingerprint,
  computeProductionConfigProfileFingerprint,
  computeReleaseCandidateFingerprint,
  computeReleaseManifestFingerprint,
  createRuntimeLifecycle,
  advanceStartup,
  evaluateCurrentReleaseApplicability,
  evaluateReadinessOverall,
  evaluateReleaseQualificationOutcome,
  hashDistDirectory,
  listDistRelativePaths,
  mintProductionReferenceRuntimeManifest,
  withBuildArtifactFingerprint,
  withReadinessReport,
  withReferenceRuntimeManifestHash,
  withReleaseQualificationRecordHash,
  QualificationError,
  isQualificationError,
  QualificationOrchestrationService,
  InMemoryProductionQualificationRunRepository,
  InMemoryQualificationEvidenceRepository,
  InMemoryReleaseQualificationRecordRepository,
  InMemoryReleaseManifestRepository,
  InMemoryQualificationAuditRepository,
  REFERENCE_RUNTIME_ASSEMBLY_SIGNATURE,
  productionConfigProfileFromRuntimeConfig,
  STARTUP_ORDER_DOCUMENTED,
  type ReleaseCandidateIdentity,
} from "./index.js";

function mintCert(targetFingerprint: string) {
  return withCertificateHash({
    certificateId: "acert_test",
    certificateVersion: 1,
    certificationMaterialFingerprint: "mat",
    targetFingerprint,
    profileId: "CORE_SYSTEM_QUALIFICATION",
    profileVersion: 1,
    profileHash: "ph",
    assuranceRunId: "arun_1",
    assessmentId: "aassess_1",
    assessmentHash: "ah",
    controlCatalogFingerprint: "cc",
    evidenceSetFingerprint: "es",
    certifierPrincipalId: "certifier_1",
    institutionalAuthorizationProofId: "proof_1",
    proofHash: "prh",
    issuedAt: "2026-09-09T12:00:00.000Z",
    validUntil: "2026-12-09T12:00:00.000Z",
    status: "VALID",
    recordRevision: 1,
  });
}

function buildCandidate(
  overrides: Partial<ReleaseCandidateIdentity> = {},
): ReleaseCandidateIdentity {
  const runtime = mintProductionReferenceRuntimeManifest("PRODUCTION");
  return {
    repositoryIdentity: "orchestration-repo",
    commitSha: "abc123",
    repositoryFingerprint: createHash("sha256").update("repo").digest("hex"),
    packageLockHash: createHash("sha256").update("lock").digest("hex"),
    buildArtifactFingerprint: createHash("sha256").update("build").digest("hex"),
    migrationSetFingerprint: createHash("sha256").update("mig").digest("hex"),
    supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    runtimeVersion: "24.0.0",
    productionConfigurationProfileFingerprint: createHash("sha256")
      .update("cfg")
      .digest("hex"),
    referenceRuntimeManifestHash: runtime.manifestHash,
    assuranceTargetFingerprint: "target-t1",
    controlCatalogFingerprint: createHash("sha256").update("cat").digest("hex"),
    ...overrides,
  };
}

function allCriticalPass() {
  return withReadinessReport({
    reportId: "ready_1",
    evaluatedAt: "2026-09-09T12:00:00.000Z",
    results: [
      "DATABASE_CONNECTIVITY",
      "SCHEMA_COMPATIBILITY",
      "MIGRATION_HEAD",
      "PRODUCTION_CONFIG",
      "RUNTIME_MANIFEST",
      "ARTIFACT_INTEGRITY",
      "PHASE23_CERTIFICATE",
      "FAULT_INJECTION_DISABLED",
      "CANDIDATE_FINGERPRINT",
      "GOLDEN_PATH",
      "RESTART_RECOVERY",
      "NO_AUTHORITY_BYPASS",
    ].map((checkId) => ({
      checkId: checkId as
        | "DATABASE_CONNECTIVITY"
        | "SCHEMA_COMPATIBILITY"
        | "MIGRATION_HEAD"
        | "PRODUCTION_CONFIG"
        | "RUNTIME_MANIFEST"
        | "ARTIFACT_INTEGRITY"
        | "PHASE23_CERTIFICATE"
        | "FAULT_INJECTION_DISABLED"
        | "CANDIDATE_FINGERPRINT"
        | "GOLDEN_PATH"
        | "RESTART_RECOVERY"
        | "NO_AUTHORITY_BYPASS",
      result: "PASS" as const,
      reasonCode: "OK",
      critical: true,
    })),
  });
}

describe("Phase 24 qualification", () => {
  it("release candidate fingerprint is deterministic", () => {
    const c = buildCandidate();
    expect(computeReleaseCandidateFingerprint(c)).toBe(
      computeReleaseCandidateFingerprint(c),
    );
  });

  it("material candidate change changes fingerprint", () => {
    const a = computeReleaseCandidateFingerprint(buildCandidate());
    const b = computeReleaseCandidateFingerprint(
      buildCandidate({ commitSha: "def456" }),
    );
    expect(a).not.toBe(b);
  });

  it("build manifest / dist hashing is path-order independent", async () => {
    const root = mkdtempSync(join(tmpdir(), "p24-dist-"));
    mkdirSync(join(root, "b"));
    writeFileSync(join(root, "a.js"), "one");
    writeFileSync(join(root, "b", "c.js"), "two");
    const files = await hashDistDirectory(root);
    const shuffled = [...files].reverse();
    const base = {
      buildManifestVersion: "phase24-build-manifest-v1" as const,
      commitSha: "c1",
      packageLockHash: "l1",
      migrationSetFingerprint: "m1",
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      runtimeTarget: "node24",
    };
    expect(computeBuildArtifactFingerprint({ ...base, files })).toBe(
      computeBuildArtifactFingerprint({ ...base, files: shuffled }),
    );
    expect(listDistRelativePaths(root)).toEqual(["a.js", "b/c.js"]);
  });

  it("runtime manifest deterministic; missing critical component invalid", () => {
    const m1 = mintProductionReferenceRuntimeManifest("PRODUCTION");
    const m2 = mintProductionReferenceRuntimeManifest("PRODUCTION");
    expect(m1.manifestHash).toBe(m2.manifestHash);
    const broken = withReferenceRuntimeManifestHash({
      manifestVersion: m1.manifestVersion,
      environmentClass: m1.environmentClass,
      faultInjectionAllowed: false,
      authoritySeedingOnStartup: false,
      components: m1.components.map((c) =>
        c.componentId === "POSTGRES_PERSISTENCE"
          ? { ...c, present: false, storageClass: "MEMORY" as const }
          : c,
      ),
    });
    expect(() => assertReferenceRuntimeProductionEligible(broken)).toThrow(
      expect.objectContaining({ code: "REFERENCE_RUNTIME_INVALID" }),
    );
  });

  it("secret values excluded from config fingerprint", () => {
    const profile = productionConfigProfileFromRuntimeConfig({
      runtimeEnvironment: "PRODUCTION",
      storageMode: "POSTGRES",
      runtimeRole: "COMBINED",
      authenticationMode: "HEADER_PRINCIPAL",
      workerConcurrency: 4,
      deliverySecretConfigured: true,
      debugMode: false,
      modelProviderEnabled: false,
    });
    expect(JSON.stringify(profile)).not.toMatch(/secret_value|password|bearer/i);
    expect(profile.deliverySecretConfigured).toBe(true);
    expect(computeProductionConfigProfileFingerprint(profile)).toHaveLength(64);
    assertProductionConfigEligible(profile);
  });

  it("Phase23 exact target match required; old target cannot qualify", () => {
    const candidate = buildCandidate({ assuranceTargetFingerprint: "t1" });
    expect(() =>
      assertReleaseCandidateMatchesAssuranceTarget(candidate, "t2"),
    ).toThrow(expect.objectContaining({ code: "PHASE23_TARGET_MISMATCH" }));
  });

  it("readiness critical FAIL / INCONCLUSIVE blocks QUALIFIED_FOR_RELEASE", () => {
    const cert = mintCert("target-t1");
    const candidate = buildCandidate();
    const failReport = withReadinessReport({
      reportId: "r1",
      evaluatedAt: "2026-09-09T12:00:00.000Z",
      results: [
        {
          checkId: "PHASE23_CERTIFICATE",
          result: "FAIL",
          reasonCode: "INVALID",
          critical: true,
        },
      ],
    });
    expect(evaluateReadinessOverall(failReport.results)).toBe("FAIL");
    expect(
      evaluateReleaseQualificationOutcome({
        candidate,
        expectedCandidateFingerprint:
          computeReleaseCandidateFingerprint(candidate),
        certificate: cert,
        certificateCurrentlyValid: true,
        readiness: failReport,
        systemEvidenceOverall: "PASS",
      }),
    ).toBe("NOT_QUALIFIED");

    const inconclusive = withReadinessReport({
      reportId: "r2",
      evaluatedAt: "2026-09-09T12:00:00.000Z",
      results: [
        {
          checkId: "GOLDEN_PATH",
          result: "INCONCLUSIVE",
          reasonCode: "MISSING",
          critical: true,
        },
      ],
    });
    expect(
      evaluateReleaseQualificationOutcome({
        candidate,
        expectedCandidateFingerprint:
          computeReleaseCandidateFingerprint(candidate),
        certificate: cert,
        certificateCurrentlyValid: true,
        readiness: inconclusive,
        systemEvidenceOverall: "PASS",
      }),
    ).toBe("INCONCLUSIVE");
  });

  it("qualification record immutable; applicability drifts without rewrite", () => {
    const record = withReleaseQualificationRecordHash({
      recordId: "rqr_1",
      recordVersion: 1,
      qualificationRunId: "pqrun_1",
      releaseCandidateFingerprint: "rc1",
      buildArtifactFingerprint: "b1",
      referenceRuntimeManifestHash: "m1",
      phase23CertificateId: "acert_1",
      phase23CertificateHash: "ch1",
      phase23TargetFingerprint: "t1",
      readinessEvidenceSetFingerprint: "re1",
      systemQualificationEvidenceSetFingerprint: "se1",
      evaluatedAt: "2026-09-09T12:00:00.000Z",
      outcome: "QUALIFIED_FOR_RELEASE",
    });
    const frozenHash = record.recordHash;
    expect(
      evaluateCurrentReleaseApplicability({
        record,
        currentReleaseCandidateFingerprint: "rc2",
        currentRuntimeManifestHash: "m1",
        currentBuildArtifactFingerprint: "b1",
        phase23CertificateCurrentlyValid: true,
        evidenceIntegrityValid: true,
        atIso: "2026-09-09T13:00:00.000Z",
      }),
    ).toBe("STALE");
    expect(record.recordHash).toBe(frozenHash);
  });

  it("release manifest deterministic; qualification != deployment", () => {
    const candidate = buildCandidate();
    const record = withReleaseQualificationRecordHash({
      recordId: "rqr_1",
      recordVersion: 1,
      qualificationRunId: "pqrun_1",
      releaseCandidateFingerprint: computeReleaseCandidateFingerprint(candidate),
      buildArtifactFingerprint: candidate.buildArtifactFingerprint,
      referenceRuntimeManifestHash: candidate.referenceRuntimeManifestHash,
      phase23CertificateId: "acert_1",
      phase23CertificateHash: "ch1",
      phase23TargetFingerprint: candidate.assuranceTargetFingerprint,
      readinessEvidenceSetFingerprint: "re1",
      systemQualificationEvidenceSetFingerprint: "se1",
      evaluatedAt: "2026-09-09T12:00:00.000Z",
      outcome: "QUALIFIED_FOR_RELEASE",
    });
    const m1 = buildReleaseManifest({
      candidate,
      releaseCandidateFingerprint: record.releaseCandidateFingerprint,
      record,
    });
    const m2 = buildReleaseManifest({
      candidate,
      releaseCandidateFingerprint: record.releaseCandidateFingerprint,
      record,
    });
    expect(m1.manifestFingerprint).toBe(m2.manifestFingerprint);
    const { manifestFingerprint: _drop, ...rest } = m1;
    expect(computeReleaseManifestFingerprint(rest)).toBe(m1.manifestFingerprint);
    expect(JSON.stringify(m1)).not.toContain("DEPLOYED");
  });

  it("production runtime cannot enable fault injection; drain state machine", () => {
    const manifest = mintProductionReferenceRuntimeManifest("PRODUCTION");
    expect(manifest.faultInjectionAllowed).toBe(false);
    expect(manifest.authoritySeedingOnStartup).toBe(false);
    expect(REFERENCE_RUNTIME_ASSEMBLY_SIGNATURE).toContain(
      "no FaultInjectionController",
    );
    let life = createRuntimeLifecycle();
    for (const next of STARTUP_ORDER_DOCUMENTED.slice(1)) {
      life = advanceStartup(life, next);
    }
    expect(life.acceptingTraffic).toBe(true);
    life = beginDrain(life);
    expect(life.acquiringLeases).toBe(false);
    life = completeStop(life);
    expect(life.state).toBe("STOPPED");
  });

  it("finalizeQualification issues QUALIFIED_FOR_RELEASE without deployment", async () => {
    const runtime = mintProductionReferenceRuntimeManifest("PRODUCTION");
    const build = withBuildArtifactFingerprint({
      buildManifestVersion: "phase24-build-manifest-v1",
      commitSha: "abc123",
      packageLockHash: createHash("sha256").update("lock").digest("hex"),
      migrationSetFingerprint: createHash("sha256").update("mig").digest("hex"),
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      runtimeTarget: "node24",
      files: [{ relativePath: "index.js", contentHash: "aa" }],
    });
    const candidate = buildCandidate({
      referenceRuntimeManifestHash: runtime.manifestHash,
      buildArtifactFingerprint: build.buildArtifactFingerprint,
      packageLockHash: build.packageLockHash,
      migrationSetFingerprint: build.migrationSetFingerprint,
      commitSha: build.commitSha,
    });
    const cert = mintCert(candidate.assuranceTargetFingerprint);
    const service = new QualificationOrchestrationService({
      nowIso: () => "2026-09-09T12:00:00.000Z",
      runs: new InMemoryProductionQualificationRunRepository(),
      evidence: new InMemoryQualificationEvidenceRepository(),
      records: new InMemoryReleaseQualificationRecordRepository(),
      manifests: new InMemoryReleaseManifestRepository(),
      audits: new InMemoryQualificationAuditRepository(),
      getSystemCertificate: async (id) =>
        id === cert.certificateId ? cert : null,
      evaluateCertificateValidity: evaluateCertificateCurrentValidity,
      listCertificateRevoked: async () => false,
      assertPhase23EvidenceIntegrity: async () => undefined,
    });
    service.assertNoDeployer();
    const run = await service.createQualificationRun({
      candidate,
      runtimeManifest: runtime,
      certificateId: cert.certificateId,
    });
    const readiness = allCriticalPass();
    const at = "2026-09-09T12:00:00.000Z";
    for (const kind of [
      "PHASE23_CERTIFICATE_REF",
      "READINESS_REPORT",
      "GOLDEN_PATH_ACCEPTANCE",
      "RESTART_RECOVERY",
      "BUILD_MANIFEST_VERIFICATION",
    ] as const) {
      await service.recordTrustedEvidence({
        qualificationRunId: run.qualificationRunId,
        evidenceKind: kind,
        referencedIdentity: `id:${kind}`,
        referencedHash: createHash("sha256").update(kind).digest("hex"),
        resultCode: "PASS",
        generatedAt: at,
        metadata: {},
      });
    }
    const result = await service.finalizeQualification({
      qualificationRunId: run.qualificationRunId,
      candidate,
      buildManifest: build,
      runtimeManifest: runtime,
      readiness,
    });
    expect(result.record.outcome).toBe("QUALIFIED_FOR_RELEASE");
    expect(result.manifest).not.toBeNull();
    expect(result.bundle?.deploymentAuthorized).toBe(false);
    assertBuildArtifactIntegrity(build);
  });

  it("finalize without trusted evidence cannot QUALIFY; no release manifest", async () => {
    const runtime = mintProductionReferenceRuntimeManifest("PRODUCTION");
    const build = withBuildArtifactFingerprint({
      buildManifestVersion: "phase24-build-manifest-v1",
      commitSha: "abc123",
      packageLockHash: createHash("sha256").update("lock").digest("hex"),
      migrationSetFingerprint: createHash("sha256").update("mig").digest("hex"),
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      runtimeTarget: "node24",
      files: [{ relativePath: "index.js", contentHash: "aa" }],
    });
    const candidate = buildCandidate({
      referenceRuntimeManifestHash: runtime.manifestHash,
      buildArtifactFingerprint: build.buildArtifactFingerprint,
      packageLockHash: build.packageLockHash,
      migrationSetFingerprint: build.migrationSetFingerprint,
      commitSha: build.commitSha,
    });
    const cert = mintCert(candidate.assuranceTargetFingerprint);
    const service = new QualificationOrchestrationService({
      nowIso: () => "2026-09-09T12:00:00.000Z",
      runs: new InMemoryProductionQualificationRunRepository(),
      evidence: new InMemoryQualificationEvidenceRepository(),
      records: new InMemoryReleaseQualificationRecordRepository(),
      manifests: new InMemoryReleaseManifestRepository(),
      audits: new InMemoryQualificationAuditRepository(),
      getSystemCertificate: async (id) =>
        id === cert.certificateId ? cert : null,
      evaluateCertificateValidity: evaluateCertificateCurrentValidity,
      listCertificateRevoked: async () => false,
      assertPhase23EvidenceIntegrity: async () => undefined,
    });
    const run = await service.createQualificationRun({
      candidate,
      runtimeManifest: runtime,
      certificateId: cert.certificateId,
    });
    const incomplete = await service.finalizeQualification({
      qualificationRunId: run.qualificationRunId,
      candidate,
      buildManifest: build,
      runtimeManifest: runtime,
      readiness: allCriticalPass(),
      systemEvidenceOverall: "PASS",
    });
    expect(incomplete.record.outcome).toBe("INCONCLUSIVE");
    expect(incomplete.manifest).toBeNull();
    expect(incomplete.bundle).toBeNull();
  });


  it("finalize same run is idempotent; conflicting material conflicts", async () => {
    const runtime = mintProductionReferenceRuntimeManifest("PRODUCTION");
    const build = withBuildArtifactFingerprint({
      buildManifestVersion: "phase24-build-manifest-v1",
      commitSha: "abc123",
      packageLockHash: createHash("sha256").update("lock").digest("hex"),
      migrationSetFingerprint: createHash("sha256").update("mig").digest("hex"),
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
      runtimeTarget: "node24",
      files: [{ relativePath: "index.js", contentHash: "aa" }],
    });
    const candidate = buildCandidate({
      referenceRuntimeManifestHash: runtime.manifestHash,
      buildArtifactFingerprint: build.buildArtifactFingerprint,
      packageLockHash: build.packageLockHash,
      migrationSetFingerprint: build.migrationSetFingerprint,
      commitSha: build.commitSha,
    });
    const cert = mintCert(candidate.assuranceTargetFingerprint);
    const service = new QualificationOrchestrationService({
      nowIso: () => "2026-09-09T12:00:00.000Z",
      runs: new InMemoryProductionQualificationRunRepository(),
      evidence: new InMemoryQualificationEvidenceRepository(),
      records: new InMemoryReleaseQualificationRecordRepository(),
      manifests: new InMemoryReleaseManifestRepository(),
      audits: new InMemoryQualificationAuditRepository(),
      getSystemCertificate: async (id) =>
        id === cert.certificateId ? cert : null,
      evaluateCertificateValidity: evaluateCertificateCurrentValidity,
      listCertificateRevoked: async () => false,
      assertPhase23EvidenceIntegrity: async () => undefined,
    });
    const run = await service.createQualificationRun({
      candidate,
      runtimeManifest: runtime,
      certificateId: cert.certificateId,
    });
    const readiness = allCriticalPass();
    const at = "2026-09-09T12:00:00.000Z";
    for (const kind of [
      "PHASE23_CERTIFICATE_REF",
      "READINESS_REPORT",
      "GOLDEN_PATH_ACCEPTANCE",
      "RESTART_RECOVERY",
      "BUILD_MANIFEST_VERIFICATION",
    ] as const) {
      await service.recordTrustedEvidence({
        qualificationRunId: run.qualificationRunId,
        evidenceKind: kind,
        referencedIdentity: `id:${kind}`,
        referencedHash: createHash("sha256").update(kind).digest("hex"),
        resultCode: "PASS",
        generatedAt: at,
        metadata: {},
      });
    }
    const first = await service.finalizeQualification({
      qualificationRunId: run.qualificationRunId,
      candidate,
      buildManifest: build,
      runtimeManifest: runtime,
      readiness,
    });
    const second = await service.finalizeQualification({
      qualificationRunId: run.qualificationRunId,
      candidate,
      buildManifest: build,
      runtimeManifest: runtime,
      readiness,
    });
    expect(second.record.recordId).toBe(first.record.recordId);
    const drifted = withReadinessReport({
      reportId: "ready_drift",
      evaluatedAt: "2026-09-09T13:00:00.000Z",
      results: readiness.results.map((r) =>
        r.checkId === "GOLDEN_PATH"
          ? { ...r, reasonCode: "DRIFTED_MATERIAL" }
          : r,
      ),
    });
    await expect(
      service.finalizeQualification({
        qualificationRunId: run.qualificationRunId,
        candidate,
        buildManifest: build,
        runtimeManifest: runtime,
        readiness: drifted,
      }),
    ).rejects.toMatchObject({ code: "RELEASE_QUALIFICATION_CONFLICT" });
  });

  it("E-identity: repeated admission fixtures produce distinct Phase2 logical identity", () => {
    const a = exampleAdmissionRequest({
      objectiveId: `pg-p24-golden-e-${randomUUID()}`,
      objectiveVersion: 1,
    });
    const b = exampleAdmissionRequest({
      objectiveId: `pg-p24-golden-e-${randomUUID()}`,
      objectiveVersion: 1,
    });
    expect(a.objectiveVersion).toBe(1);
    expect(b.objectiveVersion).toBe(1);
    expect(a.requestedEnvironment).toBe(b.requestedEnvironment);
    expect(a.objectiveId).not.toBe(b.objectiveId);
    expect(
      `${a.projectId}|${a.objectiveId}|${a.objectiveVersion}|${a.requestedEnvironment}`,
    ).not.toBe(
      `${b.projectId}|${b.objectiveId}|${b.objectiveVersion}|${b.requestedEnvironment}`,
    );
  });

  it("QualificationError preserved identity; schema head is 019", () => {
    const err = new QualificationError("RELEASE_NOT_QUALIFIED", "not qualified");
    expect(isQualificationError(err)).toBe(true);
    expect(FINAL_SYSTEM_DOCTRINE.releaseQualifiedNotDeployed).toContain(
      "DEPLOYED",
    );
    expect(QUALIFICATION_DOCTRINE.deploymentNotInScope).toBe(
      "DEPLOYMENT != IN SCOPE",
    );
    expect(SUPPORTED_SCHEMA_VERSION).toBe("019_phase24_production_synthesis");
  });

  it("architecture conformance includes Phase24 rules", () => {
    const result = evaluateArchitectureConformance();
    expect(result.results.every((r) => r.result === "PASS")).toBe(true);
    expect(result.results.some((r) => r.ruleId === "NO_PHASE24_DEPLOYER")).toBe(
      true,
    );
    expect(
      result.results.some((r) => r.ruleId === "READY_DERIVED_FROM_READINESS_EVALUATOR"),
    ).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "NO_STARTUP_AUTHORITY_SEED_BY_DEFAULT"),
    ).toBe(true);
    expect(
      result.results.some(
        (r) => r.ruleId === "NO_PRODUCTION_REPOSITORY_SOURCE_SEED_ON_STARTUP",
      ),
    ).toBe(true);
  });

  it("no deployment adapter exists in Phase24 module surface", () => {
    const service = readFileSync("src/qualification/service.ts", "utf8");
    expect(service).not.toMatch(/deployToProduction|DeploymentAdapter/);
    expect(service).toContain("deploymentAuthorized: false");
  });
});
