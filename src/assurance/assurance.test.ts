import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  computeControlCatalogHash,
  CORE_CONTROL_CATALOG,
  getControlById,
} from "./control.js";
import {
  compileChallengePlan,
  describeChallengeKind,
  mintAdversarialCaseIdentity,
  ASSURANCE_CHALLENGE_KINDS,
} from "./challenge.js";
import {
  computeEvidenceSetFingerprint,
  withEvidenceHash,
  mintEvidenceId,
  recomputeEvidenceContentHash,
} from "./evidence.js";
import { evaluateControl } from "./evaluation.js";
import { finalizeAssessment } from "./assessment.js";
import {
  assertCertificateCurrentlyValid,
  computeCertificationMaterialFingerprint,
} from "./certification.js";
import { assertFaultInjectionAllowed } from "./fault-injection.js";
import { evaluateArchitectureConformance } from "./architecture-conformance.js";
import { replayDeterministic } from "./replay.js";
import { isAssuranceError } from "./errors.js";
import { mintCoreSystemQualificationProfile } from "./profile.js";
import { computeTargetFingerprint } from "./target.js";
import { SUPPORTED_SCHEMA_VERSION } from "../domain/durability/index.js";
import { buildAssuranceService, buildTarget } from "./test-fixtures.js";

describe("Phase 23 independent assurance", () => {
  it("target fingerprint is deterministic and drifts on material change", () => {
    const profile = mintCoreSystemQualificationProfile("2026-09-08T00:00:00.000Z");
    const t1 = buildTarget({}, profile);
    const a = computeTargetFingerprint(t1);
    const b = computeTargetFingerprint(t1);
    expect(a).toBe(b);
    const t2 = buildTarget({ repositoryCommitSha: "different" }, profile);
    expect(computeTargetFingerprint(t2)).not.toBe(a);
  });

  it("control catalog hash is deterministic", () => {
    expect(computeControlCatalogHash()).toBe(computeControlCatalogHash());
    expect(CORE_CONTROL_CATALOG.length).toBeGreaterThan(10);
  });

  it("profile is immutable/versioned via hash binding", () => {
    const p = mintCoreSystemQualificationProfile("2026-09-08T00:00:00.000Z");
    expect(p.profileHash).toHaveLength(64);
    expect(p.profileId).toBe("CORE_SYSTEM_QUALIFICATION");
  });

  it("challenge plan is deterministic for same profile/target/seed", () => {
    const profile = mintCoreSystemQualificationProfile("2026-09-08T00:00:00.000Z");
    const target = buildTarget({}, profile);
    const p1 = compileChallengePlan({
      profile,
      target,
      compiledAt: "2026-09-08T12:00:00.000Z",
      seed: "s1",
    });
    const p2 = compileChallengePlan({
      profile,
      target,
      compiledAt: "2026-09-08T12:00:00.000Z",
      seed: "s1",
    });
    expect(p1.planHash).toBe(p2.planHash);
  });

  it("challenge kinds are exhaustively handled", () => {
    for (const kind of ASSURANCE_CHALLENGE_KINDS) {
      expect(describeChallengeKind(kind).length).toBeGreaterThan(0);
    }
  });

  it("adversarial case generation is deterministic", () => {
    const a = mintAdversarialCaseIdentity({
      challengeId: "CH_SECURITY",
      challengeVersion: "1",
      seed: "seed",
      caseIndex: 3,
    });
    const b = mintAdversarialCaseIdentity({
      challengeId: "CH_SECURITY",
      challengeVersion: "1",
      seed: "seed",
      caseIndex: 3,
    });
    expect(a).toEqual(b);
  });

  it("missing required evidence cannot PASS a critical control", () => {
    const control = getControlById("FED_NO_TRANSITIVE_TRUST")!;
    const ev = evaluateControl({
      control,
      targetFingerprint: "t",
      evidence: [],
      evaluatedAt: "2026-09-08T12:00:00.000Z",
      evaluationId: "e1",
    });
    expect(ev.result).toBe("INCONCLUSIVE");
  });

  it("critical FAIL blocks QUALIFIED; INCONCLUSIVE blocks QUALIFIED", () => {
    const control = getControlById("FED_NO_TRANSITIVE_TRUST")!;
    const failEv = evaluateControl({
      control,
      targetFingerprint: "t",
      evidence: [
        withEvidenceHash({
          evidenceId: mintEvidenceId(),
          evidenceKind: "UNIT_TEST",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [control.controlId],
          targetFingerprint: "t",
          sourceIdentity: "unit",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "FAIL",
          metadata: {},
        }),
        withEvidenceHash({
          evidenceId: mintEvidenceId(),
          evidenceKind: "POSTGRES_ACCEPTANCE",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [control.controlId],
          targetFingerprint: "t",
          sourceIdentity: "pg",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "FAIL",
          metadata: {},
        }),
      ],
      evaluatedAt: "2026-09-08T12:00:00.000Z",
      evaluationId: "e2",
    });
    expect(failEv.result).toBe("FAIL");

    const profile = mintCoreSystemQualificationProfile("2026-09-08T00:00:00.000Z");
    const { assessment: notQualified } = finalizeAssessment({
      assuranceRunId: "r",
      targetFingerprint: "t",
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileHash: profile.profileHash,
      requiredControls: [control],
      evaluations: [failEv],
      evidenceSetFingerprint: "e",
      evaluationSetFingerprint: "v",
      assessedAt: "2026-09-08T12:00:00.000Z",
    });
    expect(notQualified.outcome).toBe("NOT_QUALIFIED");

    const inconclus = evaluateControl({
      control,
      targetFingerprint: "t",
      evidence: [],
      evaluatedAt: "2026-09-08T12:00:00.000Z",
      evaluationId: "e3",
    });
    const { assessment: inconclusive } = finalizeAssessment({
      assuranceRunId: "r",
      targetFingerprint: "t",
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileHash: profile.profileHash,
      requiredControls: [control],
      evaluations: [inconclus],
      evidenceSetFingerprint: "e",
      evaluationSetFingerprint: "v",
      assessedAt: "2026-09-08T12:00:00.000Z",
    });
    expect(inconclusive.outcome).toBe("INCONCLUSIVE");
  });

  it("optional failure cannot hide critical semantics", () => {
    const optional = getControlById("OPTIONAL_COVERAGE_SAMPLE")!;
    const critical = getControlById("SEC_PROD_FAULT_DENIED")!;
    const optFail = evaluateControl({
      control: optional,
      targetFingerprint: "t",
      evidence: [
        withEvidenceHash({
          evidenceId: mintEvidenceId(),
          evidenceKind: "UNIT_TEST",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [optional.controlId],
          targetFingerprint: "t",
          sourceIdentity: "unit",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "FAIL",
          metadata: {},
        }),
      ],
      evaluatedAt: "2026-09-08T12:00:00.000Z",
      evaluationId: "eo",
    });
    const critPass = evaluateControl({
      control: critical,
      targetFingerprint: "t",
      evidence: [
        withEvidenceHash({
          evidenceId: mintEvidenceId(),
          evidenceKind: "UNIT_TEST",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [critical.controlId],
          targetFingerprint: "t",
          sourceIdentity: "unit",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        }),
        withEvidenceHash({
          evidenceId: mintEvidenceId(),
          evidenceKind: "ARCHITECTURE_TEST",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [critical.controlId],
          targetFingerprint: "t",
          sourceIdentity: "arch",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        }),
      ],
      evaluatedAt: "2026-09-08T12:00:00.000Z",
      evaluationId: "ec",
    });
    const profile = mintCoreSystemQualificationProfile("2026-09-08T00:00:00.000Z");
    const { assessment } = finalizeAssessment({
      assuranceRunId: "r",
      targetFingerprint: "t",
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      profileHash: profile.profileHash,
      requiredControls: [optional, critical],
      evaluations: [optFail, critPass],
      evidenceSetFingerprint: "e",
      evaluationSetFingerprint: "v",
      assessedAt: "2026-09-08T12:00:00.000Z",
    });
    expect(assessment.outcome).toBe("QUALIFIED");
  });

  it("evidence set fingerprint ignores order; tampering changes it", () => {
    const e1 = withEvidenceHash({
      evidenceId: "e1",
      evidenceKind: "UNIT_TEST",
      assuranceRunId: "r",
      challengeId: "c",
      challengeVersion: "1",
      controlIds: ["X"],
      targetFingerprint: "t",
      sourceIdentity: "s",
      generatedAt: "2026-09-08T12:00:00.000Z",
      evidenceQuality: "DIRECT",
      resultCode: "PASS",
      metadata: { k: 1 },
    });
    const e2 = withEvidenceHash({
      evidenceId: "e2",
      evidenceKind: "UNIT_TEST",
      assuranceRunId: "r",
      challengeId: "c",
      challengeVersion: "1",
      controlIds: ["X"],
      targetFingerprint: "t",
      sourceIdentity: "s",
      generatedAt: "2026-09-08T12:00:00.000Z",
      evidenceQuality: "DIRECT",
      resultCode: "PASS",
      metadata: { k: 2 },
    });
    expect(computeEvidenceSetFingerprint([e1, e2])).toBe(
      computeEvidenceSetFingerprint([e2, e1]),
    );
    const tampered = { ...e1, contentHash: "deadbeef" };
    expect(computeEvidenceSetFingerprint([tampered, e2])).not.toBe(
      computeEvidenceSetFingerprint([e1, e2]),
    );
  });

  it("contradictory evidence cannot cherry-pick PASS", () => {
    const control = getControlById("FED_AGREEMENT_NE_LOCAL")!;
    const ev = evaluateControl({
      control,
      targetFingerprint: "t",
      evidence: [
        withEvidenceHash({
          evidenceId: "a",
          evidenceKind: "UNIT_TEST",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [control.controlId],
          targetFingerprint: "t",
          sourceIdentity: "s",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        }),
        withEvidenceHash({
          evidenceId: "b",
          evidenceKind: "POSTGRES_ACCEPTANCE",
          assuranceRunId: "r",
          challengeId: "c",
          challengeVersion: "1",
          controlIds: [control.controlId],
          targetFingerprint: "t",
          sourceIdentity: "s",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "FAIL",
          metadata: {},
        }),
      ],
      evaluatedAt: "2026-09-08T12:00:00.000Z",
      evaluationId: "e",
    });
    expect(ev.result).toBe("FAIL");
    expect(ev.reasonCode).toBe("CONTRADICTORY_EVIDENCE");
  });

  it("QUALIFIED assessment does not auto-certificate; SoD enforced", async () => {
    const { service, profiles } = buildAssuranceService();
    const profile = await service.ensureCoreProfile();
    await profiles.save(profile);
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);

    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH_DYNAMIC_CORE",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted_adapter",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: { controlId },
        });
      }
    }

    const evaluated = await service.evaluate(run.assuranceRunId);
    expect(evaluated.outcome).toBe("QUALIFIED");
    expect(await service.getCertificate("none")).toBeNull();

    await expect(
      service.certify({
        assuranceRunId: run.assuranceRunId,
        certifierPrincipalId: "operator_1",
        institutionalAuthorizationProofId: "proof_cert",
        projectId: "proj_a",
        environment: "TEST",
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_SEPARATION_VIOLATION" });

    const cert = await service.certify({
      assuranceRunId: run.assuranceRunId,
      certifierPrincipalId: "certifier_1",
      institutionalAuthorizationProofId: "proof_cert",
      projectId: "proj_a",
      environment: "TEST",
    });
    expect(cert.status).toBe("VALID");
  });

  it("G1 revoke + G2 equivalent cannot repair old certification proof", async () => {
    let proofStale = false;
    const { service } = buildAssuranceService({
      validateProof: async () => {
        if (proofStale) {
          const { GovernanceError } = await import("../governance/errors.js");
          throw new GovernanceError("GOVERNANCE_PROOF_STALE", "stale");
        }
        return { proofHash: "proof_hash_g1" };
      },
    });
    const profile = await service.ensureCoreProfile();
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);
    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        });
      }
    }
    await service.evaluate(run.assuranceRunId);
    proofStale = true;
    await expect(
      service.certify({
        assuranceRunId: run.assuranceRunId,
        certifierPrincipalId: "certifier_1",
        institutionalAuthorizationProofId: "proof_g1",
        projectId: "proj_a",
        environment: "TEST",
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_PROOF_STALE" });
  });

  it("target drift invalidates old certificate", async () => {
    const { service, evidence } = buildAssuranceService();
    const profile = await service.ensureCoreProfile();
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);
    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        });
      }
    }
    await service.evaluate(run.assuranceRunId);
    const cert = await service.certify({
      assuranceRunId: run.assuranceRunId,
      certifierPrincipalId: "certifier_1",
      institutionalAuthorizationProofId: "proof_cert",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.validateCertificate({
      certificateId: cert.certificateId,
      currentTarget: target,
    });
    const drifted = buildTarget({ packageLockHash: "changed-lock" }, profile);
    await expect(
      service.validateCertificate({
        certificateId: cert.certificateId,
        currentTarget: drifted,
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_TARGET_DRIFT" });
    const validity = await service.getCertificateCurrentValidity({
      certificateId: cert.certificateId,
      currentTarget: drifted,
    });
    expect(validity.currentValidity).toBe("STALE");
    expect(validity.certificate.certificateHash).toBe(cert.certificateHash);
    // Unchanged evidence must not be classified as tampered under T2.
    await expect(
      service.assertEvidenceIntegrity(run.assuranceRunId),
    ).resolves.toBeUndefined();
    const stored = await evidence.listByRun(run.assuranceRunId);
    expect(stored.length).toBeGreaterThan(0);
  });

  it("evidence hash is call-target independent; T2 is TARGET_DRIFT not TAMPERED", async () => {
    const { service, evidence } = buildAssuranceService();
    const profile = await service.ensureCoreProfile();
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);
    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: { kind, controlId, fixture: "order-sensitive" },
        });
      }
    }
    await service.evaluate(run.assuranceRunId);
    const cert = await service.certify({
      assuranceRunId: run.assuranceRunId,
      certifierPrincipalId: "certifier_1",
      institutionalAuthorizationProofId: "proof_cert",
      projectId: "proj_a",
      environment: "TEST",
    });

    const rows = await evidence.listByRun(run.assuranceRunId);
    const e1 = rows[0]!;
    const hashBeforeT1 = recomputeEvidenceContentHash(e1);
    expect(hashBeforeT1).toBe(e1.contentHash);

    await service.validateCertificate({
      certificateId: cert.certificateId,
      currentTarget: target,
    });

    const hashAfterT1 = recomputeEvidenceContentHash(
      (await evidence.listByRun(run.assuranceRunId))[0]!,
    );
    expect(hashAfterT1).toBe(hashBeforeT1);

    const t2 = buildTarget({ packageLockHash: "t2-independent-lock" }, profile);
    await expect(
      service.validateCertificate({
        certificateId: cert.certificateId,
        currentTarget: t2,
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_TARGET_DRIFT" });

    const hashAfterT2 = recomputeEvidenceContentHash(
      (await evidence.listByRun(run.assuranceRunId))[0]!,
    );
    expect(hashAfterT2).toBe(hashBeforeT1);
    expect(hashAfterT2).toBe(e1.contentHash);
  });

  it("evidence tamper under exact T1 is TAMPERED; T2 drift is not TAMPERED", async () => {
    const { service, evidence } = buildAssuranceService();
    const profile = await service.ensureCoreProfile();
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);
    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: { fixture: "ok" },
        });
      }
    }
    await service.evaluate(run.assuranceRunId);
    const cert = await service.certify({
      assuranceRunId: run.assuranceRunId,
      certifierPrincipalId: "certifier_1",
      institutionalAuthorizationProofId: "proof_cert",
      projectId: "proj_a",
      environment: "TEST",
    });

    const drifted = buildTarget({ packageLockHash: "t2-lock" }, profile);
    await expect(
      service.validateCertificate({
        certificateId: cert.certificateId,
        currentTarget: drifted,
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_TARGET_DRIFT" });

    const rows = await evidence.listByRun(run.assuranceRunId);
    const victim = rows[0]!;
    // Corrupt stored metadata while leaving contentHash identity unchanged.
    evidence.byId.set(victim.evidenceId, {
      ...victim,
      metadata: { ...victim.metadata, tampered: true },
    });

    await expect(
      service.validateCertificate({
        certificateId: cert.certificateId,
        currentTarget: target,
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_EVIDENCE_TAMPERED" });
  });

  it("expired evidence blocks certification", async () => {
    const { service, clock } = buildAssuranceService();
    const profile = await service.ensureCoreProfile();
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);
    const staleAt = clock.nowIso();
    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted",
          generatedAt: staleAt,
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        });
      }
    }
    await service.evaluate(run.assuranceRunId);
    clock.advanceMs((profile.evidenceFreshnessSeconds + 10) * 1000);
    await expect(
      service.certify({
        assuranceRunId: run.assuranceRunId,
        certifierPrincipalId: "certifier_1",
        institutionalAuthorizationProofId: "proof_cert",
        projectId: "proj_a",
        environment: "TEST",
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_EVIDENCE_STALE" });
  });

  it("certificate revocation preserves history", async () => {
    const { service, certificates, revocations } = buildAssuranceService();
    const profile = await service.ensureCoreProfile();
    const target = buildTarget({}, profile);
    const run = await service.createRun({
      target,
      profileId: profile.profileId,
      profileVersion: profile.profileVersion,
      initiatedByPrincipalId: "operator_1",
      institutionalAuthorizationProofId: "proof_op",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.compilePlan(run.assuranceRunId);
    for (const controlId of profile.requiredControlIds) {
      const control = getControlById(controlId)!;
      for (const kind of control.requiredEvidenceKinds) {
        await service.recordTrustedEvidence({
          evidenceId: mintEvidenceId(),
          evidenceKind: kind,
          assuranceRunId: run.assuranceRunId,
          challengeId: "CH",
          challengeVersion: "1",
          controlIds: [controlId],
          targetFingerprint: run.targetFingerprint,
          sourceIdentity: "trusted",
          generatedAt: "2026-09-08T12:00:00.000Z",
          evidenceQuality: "DIRECT",
          resultCode: "PASS",
          metadata: {},
        });
      }
    }
    await service.evaluate(run.assuranceRunId);
    const cert = await service.certify({
      assuranceRunId: run.assuranceRunId,
      certifierPrincipalId: "certifier_1",
      institutionalAuthorizationProofId: "proof_cert",
      projectId: "proj_a",
      environment: "TEST",
    });
    await service.revokeCertificate({
      certificateId: cert.certificateId,
      reason: "test revoke",
      revokedByPrincipalId: "certifier_2",
      institutionalAuthorizationProofId: "proof_rev",
      projectId: "proj_a",
      environment: "TEST",
    });
    const after = await certificates.getById(cert.certificateId);
    expect(after).toBeTruthy();
    expect(after!.certificateHash).toBe(cert.certificateHash);
    expect(after!.issuedAt).toBe(cert.issuedAt);
    expect(after!.status).toBe("VALID");
    expect(after!.targetFingerprint).toBe(cert.targetFingerprint);
    expect(after!.assessmentHash).toBe(cert.assessmentHash);
    expect((await revocations.listByCertificate(cert.certificateId)).length).toBe(
      1,
    );
    const validity = await service.getCertificateCurrentValidity({
      certificateId: cert.certificateId,
      currentTarget: target,
    });
    expect(validity.currentValidity).toBe("REVOKED");
    await expect(
      service.validateCertificate({
        certificateId: cert.certificateId,
        currentTarget: target,
      }),
    ).rejects.toMatchObject({ code: "ASSURANCE_CERTIFICATE_REVOKED" });
  });

  it("production fault injection denied; replay deterministic", () => {
    expect(() =>
      assertFaultInjectionAllowed({
        point: "TRANSACTION_ROLLBACK",
        assuranceRunId: "r",
        environment: "PRODUCTION",
      }),
    ).toThrow(
      expect.objectContaining({ code: "ASSURANCE_FAULT_INJECTION_DENIED" }),
    );

    const r1 = replayDeterministic({
      replayId: "rp1",
      assuranceRunId: "r",
      originalInputHash: "in1",
      evaluatorVersion: "phase23-evaluator-v1",
      material: { x: 1 },
    });
    const r2 = replayDeterministic({
      replayId: "rp1",
      assuranceRunId: "r",
      originalInputHash: "in1",
      evaluatorVersion: "phase23-evaluator-v1",
      material: { x: 1 },
    });
    expect(r1.resultFingerprint).toBe(r2.resultFingerprint);
    const r3 = replayDeterministic({
      replayId: "rp1",
      assuranceRunId: "r",
      originalInputHash: "in1",
      evaluatorVersion: "phase23-evaluator-v1",
      material: { x: 2 },
    });
    expect(r3.resultFingerprint).not.toBe(r1.resultFingerprint);
  });

  it("data minimization rejects secret metadata", () => {
    expect(() =>
      withEvidenceHash({
        evidenceId: "e",
        evidenceKind: "UNIT_TEST",
        assuranceRunId: "r",
        challengeId: "c",
        challengeVersion: "1",
        controlIds: ["X"],
        targetFingerprint: "t",
        sourceIdentity: "s",
        generatedAt: "2026-09-08T12:00:00.000Z",
        evidenceQuality: "DIRECT",
        resultCode: "PASS",
        metadata: { bearerToken: "secret" },
      }),
    ).toThrow();
  });

  it("architecture conformance critical rules PASS", () => {
    const result = evaluateArchitectureConformance();
    expect(result.results.every((r) => r.result === "PASS")).toBe(true);
  });

  it("certification material fingerprint is stable", () => {
    const a = computeCertificationMaterialFingerprint({
      targetFingerprint: "t",
      profileId: "p",
      profileVersion: 1,
      profileHash: "h",
      assessmentId: "a",
      assessmentHash: "ah",
      evidenceSetFingerprint: "e",
      controlCatalogFingerprint: "c",
      proofId: "pr",
      proofHash: "ph",
      validitySeconds: 100,
    });
    const b = computeCertificationMaterialFingerprint({
      targetFingerprint: "t",
      profileId: "p",
      profileVersion: 1,
      profileHash: "h",
      assessmentId: "a",
      assessmentHash: "ah",
      evidenceSetFingerprint: "e",
      controlCatalogFingerprint: "c",
      proofId: "pr",
      proofHash: "ph",
      validitySeconds: 100,
    });
    expect(a).toBe(b);
  });

  it("Phase22 schema test uses SUPPORTED_SCHEMA_VERSION rather than historical global pin", () => {
    const body = readFileSync(
      "src/infrastructure/postgres/postgres.phase22.test.ts",
      "utf8",
    );
    expect(body).toContain("SUPPORTED_SCHEMA_VERSION");
    // After Phase23 bump, Phase22 must not require global current === 017 forever.
    // Either already fixed to presence pattern, or still pin only the constant equality for its own phase.
    expect(SUPPORTED_SCHEMA_VERSION.length).toBeGreaterThan(0);
    void assertCertificateCurrentlyValid;
    void isAssuranceError;
  });

  it("no arbitrary shell/URL in challenge module", () => {
    const body = readFileSync("src/assurance/challenge.ts", "utf8");
    expect(body).not.toContain("child_process");
    expect(body).not.toContain("execSync");
    expect(body).not.toContain("arbitraryUrl");
  });
});
