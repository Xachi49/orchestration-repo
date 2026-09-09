import { createHash } from "node:crypto";
import { CONTROL_CATALOG_VERSION } from "./doctrine.js";
import { computeControlCatalogHash } from "./control.js";
import {
  InMemoryAssuranceAssessmentRepository,
  InMemoryAssuranceAuditRepository,
  InMemoryAssuranceChallengePlanRepository,
  InMemoryAssuranceControlEvaluationRepository,
  InMemoryAssuranceEvidenceRepository,
  InMemoryAssuranceFindingRepository,
  InMemoryAssuranceProfileRepository,
  InMemoryAssuranceRunRepository,
  InMemorySystemCertificateRepository,
  InMemorySystemCertificateRevocationRepository,
} from "./memory-repositories.js";
import { mintCoreSystemQualificationProfile } from "./profile.js";
import { AssuranceOrchestrationService } from "./service.js";
import {
  computeTargetFingerprint,
  type AssuranceTargetIdentity,
} from "./target.js";
import { SUPPORTED_SCHEMA_VERSION } from "../domain/durability/index.js";

export type MutableClock = { now: string; nowIso: () => string; advanceMs: (ms: number) => void };

export function createMutableClock(startIso: string): MutableClock {
  let ms = Date.parse(startIso);
  return {
    get now() {
      return new Date(ms).toISOString();
    },
    nowIso: () => new Date(ms).toISOString(),
    advanceMs: (delta) => {
      ms += delta;
    },
  };
}

export function buildTarget(
  overrides: Partial<AssuranceTargetIdentity> = {},
  profile = mintCoreSystemQualificationProfile("2026-09-08T00:00:00.000Z"),
): AssuranceTargetIdentity {
  const base: AssuranceTargetIdentity = {
    repositoryCommitSha: "abc123commit",
    repositoryFingerprint: createHash("sha256").update("repo").digest("hex"),
    buildArtifactHash: createHash("sha256").update("build").digest("hex"),
    packageLockHash: createHash("sha256").update("lock").digest("hex"),
    migrationSetFingerprint: createHash("sha256")
      .update("migrations-through-017")
      .digest("hex"),
    supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    runtimeVersion: "24.0.0",
    controlCatalogVersion: CONTROL_CATALOG_VERSION,
    controlCatalogHash: computeControlCatalogHash(),
    configurationProfileFingerprint: createHash("sha256")
      .update("config-test")
      .digest("hex"),
    featureFlagsFingerprint: createHash("sha256")
      .update("flags-none")
      .digest("hex"),
    assuranceProfileId: profile.profileId,
    assuranceProfileVersion: profile.profileVersion,
    assuranceProfileHash: profile.profileHash,
    ...overrides,
  };
  return base;
}

export function buildAssuranceService(options?: {
  clock?: MutableClock;
  validateProof?: (input: unknown) => Promise<{ proofHash: string }>;
  certificationFailpoint?: { name: string; trigger: () => void };
}) {
  const clock =
    options?.clock ?? createMutableClock("2026-09-08T12:00:00.000Z");
  const profiles = new InMemoryAssuranceProfileRepository();
  const runs = new InMemoryAssuranceRunRepository();
  const challengePlans = new InMemoryAssuranceChallengePlanRepository();
  const evidence = new InMemoryAssuranceEvidenceRepository();
  const evaluations = new InMemoryAssuranceControlEvaluationRepository();
  const findings = new InMemoryAssuranceFindingRepository();
  const assessments = new InMemoryAssuranceAssessmentRepository();
  const certificates = new InMemorySystemCertificateRepository();
  const revocations = new InMemorySystemCertificateRevocationRepository();
  const audits = new InMemoryAssuranceAuditRepository();

  const governance = {
    validateProof:
      options?.validateProof ??
      (async () => ({
        proofHash: "proof_hash_ok",
        institutionalAuthorizationProofId: "proof_ok",
        authoritySnapshotIds: ["snap_1"],
        authoritySnapshotHashes: ["snap_hash_1"],
      })),
  };

  const service = new AssuranceOrchestrationService({
    nowIso: () => clock.nowIso(),
    profiles,
    runs,
    challengePlans,
    evidence,
    evaluations,
    findings,
    assessments,
    certificates,
    revocations,
    audits,
    governance: governance as never,
    canonicalAuthority: {
      getById: async () => null,
      listByPrincipal: async () => [],
      seed: async () => undefined as never,
    } as never,
    ...(options?.certificationFailpoint
      ? { certificationFailpoint: options.certificationFailpoint }
      : {}),
  });

  return {
    service,
    clock,
    profiles,
    runs,
    evidence,
    assessments,
    certificates,
    revocations,
    audits,
    findings,
    evaluations,
    computeTargetFingerprint,
  };
}
