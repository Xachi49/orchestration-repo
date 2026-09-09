import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { isDurabilityError } from "../../durability/errors.js";
import { AssuranceError, isAssuranceError } from "../../assurance/errors.js";
import { assertFaultInjectionAllowed } from "../../assurance/fault-injection.js";
import { evaluateArchitectureConformance } from "../../assurance/architecture-conformance.js";
import { replayDeterministic } from "../../assurance/replay.js";
import { buildTarget } from "../../assurance/test-fixtures.js";
import { computeTargetFingerprint } from "../../assurance/target.js";
import { MutableClock } from "../clock.js";
import { PostgresHealthService } from "./health.js";
import { PostgresMigrationRunner } from "./migrate.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import {
  createP23ConcurrentStack,
  createP23Env,
  P23_CERTIFIER,
  P23_CERTIFIER_Q,
  P23_DUAL,
  P23_ENV,
  P23_GOV_ADMIN,
  P23_OPERATOR,
  p23CertifyQualified,
  p23CountScoped,
  p23CreateInstitution,
  p23LifecycleFromAnchor,
  p23OpenCertificationProof,
  p23OpenRevocationProof,
  p23QualifyThroughAssessment,
  seedP23Authority,
} from "./postgres.phase23.helpers.js";

const ANCHOR = "2026-09-08T00:00:00.000Z";

describe("Phase 23 postgres independent assurance", () => {
  it("TX. preserves AssuranceError through withTransaction", async () => {
    const env = await createP23Env("tx-preserve");
    try {
      await expect(
        env.db.withTransaction(async () => {
          throw new AssuranceError(
            "ASSURANCE_NOT_QUALIFIED",
            "assessment not qualified",
            { assuranceRunId: "arun_x" },
          );
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AssuranceError);
        expect(err).toMatchObject({
          code: "ASSURANCE_NOT_QUALIFIED",
          details: { assuranceRunId: "arun_x" },
        });
        expect(isDurabilityError(err)).toBe(false);
        return true;
      });

      await expect(
        env.db.withTransaction(async () => {
          throw new Error("driver boom");
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(isDurabilityError(err)).toBe(true);
        expect(err).toMatchObject({ code: "DATABASE_TRANSACTION_FAILED" });
        return true;
      });
    } finally {
      await env.close();
    }
  });

  it("O. current-schema restart — 018 with Phase22 migration present", async () => {
    const env = await createP23Env("schema");
    try {
      expect(SUPPORTED_SCHEMA_VERSION).toBe(
        "018_phase23_independent_assurance",
      );
      const health = await new PostgresHealthService(
        env.db,
        "postgres",
      ).readiness();
      expect(health.supportedSchemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaCompatible).toBe(true);
      const status = await new PostgresMigrationRunner(env.db).status();
      expect(status.applied.map((r) => r.version)).toContain(
        "017_phase22_governed_federation",
      );
      expect(status.applied.map((r) => r.version)).toContain(
        "018_phase23_independent_assurance",
      );

      const restarted = await createP23ConcurrentStack(env.db, "schema-r");
      expect(restarted.assuranceService).toBeDefined();
      expect(restarted.federationService).toBeDefined();
      const profile = await restarted.assuranceService.ensureCoreProfile();
      expect(profile.profileId).toBe("CORE_SYSTEM_QUALIFICATION");
    } finally {
      await env.close();
    }
  });

  it("K. production fault injection denied before mutation", () => {
    expect(() =>
      assertFaultInjectionAllowed({
        point: "AFTER_CERTIFICATE_MATERIAL_BEFORE_COMMIT",
        assuranceRunId: "arun_probe",
        environment: "PRODUCTION",
      }),
    ).toThrow(
      expect.objectContaining({ code: "ASSURANCE_FAULT_INJECTION_DENIED" }),
    );
  });

  it("N. architecture conformance critical rules block QUALIFIED when FAIL", () => {
    const result = evaluateArchitectureConformance();
    expect(result.results.every((r) => r.result === "PASS")).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "ONE_CANONICAL_AUTHORITY_REGISTRY"),
    ).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "FEDERATION_ENTERS_PHASE2"),
    ).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "CONSTITUTIONAL_GATE_PROTECTED"),
    ).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "SUPPORTED_SCHEMA_MATCHES_HEAD"),
    ).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "NO_ASSURANCE_SHELL_CHALLENGE"),
    ).toBe(true);
    expect(
      result.results.some((r) => r.ruleId === "PHASE22_MIGRATION_PRESENT"),
    ).toBe(true);
  });

  it("A. primary qualification ladder + revocation + zero operational authority", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("ladder-a");
    const projectId = uniquePostgresTestId("p23a");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );

      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      expect(ctx.run.status).toBe("EVALUATED");
      expect(
        await env.stack.assuranceService.getCertificateByRun(ctx.assuranceRunId),
      ).toBeNull();

      const grantsBefore = await p23CountScoped(
        env.db,
        `SELECT COUNT(*)::int AS c FROM authority_grants WHERE project_id = $1`,
        [projectId],
      );
      const mandatesBefore = await p23CountScoped(
        env.db,
        `SELECT COUNT(*)::int AS c FROM governance_mandates WHERE institution_id = $1`,
        [institutionId],
      );

      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      expect(cert.status).toBe("VALID");
      expect(cert.targetFingerprint).toBe(ctx.run.targetFingerprint);
      expect(cert.profileId).toBe(ctx.profile.profileId);
      expect(cert.profileVersion).toBe(ctx.profile.profileVersion);
      expect(cert.profileHash).toBe(ctx.profile.profileHash);
      expect(cert.assessmentId).toBe(ctx.assessmentId);
      expect(cert.assessmentHash).toBe(ctx.assessmentHash);
      expect(cert.assuranceRunId).toBe(ctx.assuranceRunId);

      const certs = await p23CountScoped(
        env.db,
        `SELECT COUNT(*)::int AS c FROM system_certificates
         WHERE payload->>'assuranceRunId' = $1`,
        [ctx.assuranceRunId],
      );
      expect(certs).toBe(1);

      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM runs WHERE project_id = $1`,
          [projectId],
        ),
      ).toBe(0);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM json_documents
           WHERE collection = 'approval_requests' AND project_id = $1`,
          [projectId],
        ),
      ).toBe(0);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM json_documents
           WHERE collection = 'authorization_records' AND project_id = $1`,
          [projectId],
        ),
      ).toBe(0);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM json_documents
           WHERE collection = 'execution_attempts' AND project_id = $1`,
          [projectId],
        ),
      ).toBe(0);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM authority_grants WHERE project_id = $1`,
          [projectId],
        ),
      ).toBe(grantsBefore);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM federation_agreements
           WHERE payload::text LIKE '%' || $1 || '%'`,
          [institutionId],
        ),
      ).toBe(0);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM constitutional_activation_records
           WHERE payload::text LIKE '%' || $1 || '%'`,
          [institutionId],
        ),
      ).toBe(0);
      // Certification proof opens a mandate before certify; issuance itself adds none.
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM governance_mandates WHERE institution_id = $1`,
          [institutionId],
        ),
      ).toBeGreaterThanOrEqual(mandatesBefore);

      const restarted = await createP23ConcurrentStack(env.db, "a-restart");
      const validity = await restarted.assuranceService.getCertificateCurrentValidity(
        {
          certificateId: cert.certificateId,
          currentTarget: ctx.target,
        },
      );
      expect(validity.currentValidity).toBe("VALID");
      expect(validity.certificate.certificateHash).toBe(cert.certificateHash);

      const historicalHash = cert.certificateHash;
      const historicalIssuedAt = cert.issuedAt;
      const revProof = await p23OpenRevocationProof(env.stack, {
        institutionId,
        projectId,
        certificate: cert,
        certifierPrincipalId: P23_CERTIFIER_Q,
        effectiveFrom: life.postRevocationAt,
        expiresAt: life.caseExpiresAt,
      });
      await env.stack.assuranceService.revokeCertificate({
        certificateId: cert.certificateId,
        reason: "acceptance revocation",
        revokedByPrincipalId: P23_CERTIFIER_Q,
        institutionalAuthorizationProofId: revProof,
        projectId,
        environment: P23_ENV,
      });
      const afterRevoke = await env.stack.assuranceService.getCertificate(
        cert.certificateId,
      );
      expect(afterRevoke?.certificateHash).toBe(historicalHash);
      expect(afterRevoke?.issuedAt).toBe(historicalIssuedAt);
      expect(afterRevoke?.status).toBe("VALID");
      const revokedValidity =
        await env.stack.assuranceService.getCertificateCurrentValidity({
          certificateId: cert.certificateId,
          currentTarget: ctx.target,
        });
      expect(revokedValidity.currentValidity).toBe("REVOKED");
      await expect(
        env.stack.assuranceService.validateCertificate({
          certificateId: cert.certificateId,
          currentTarget: ctx.target,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_CERTIFICATE_REVOKED" });

      const afterRestart = await createP23ConcurrentStack(env.db, "a-rev-r");
      const persisted =
        await afterRestart.assuranceService.getCertificateCurrentValidity({
          certificateId: cert.certificateId,
          currentTarget: ctx.target,
        });
      expect(persisted.currentValidity).toBe("REVOKED");
      expect(persisted.certificate.certificateHash).toBe(historicalHash);
      expect(
        (await afterRestart.assuranceService.listRevocations(cert.certificateId))
          .length,
      ).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("B. critical control FAIL → NOT_QUALIFIED → certify denied → zero certificate", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("crit-b");
    const projectId = uniquePostgresTestId("p23b");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
        controlOverrides: {
          AUTHZ_PASS_NE_APPROVED: { resultCode: "FAIL" },
        },
      });
      expect(ctx.run.status).toBe("FAILED");
      const assessment = await env.stack.assuranceService.getAssessmentByRun(
        ctx.assuranceRunId,
      );
      expect(assessment?.outcome).toBe("NOT_QUALIFIED");

      await expect(
        p23CertifyQualified(env.stack, ctx, {
          proofEffectiveFrom: life.certificationProofAt,
          proofExpiresAt: life.caseExpiresAt,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(isAssuranceError(err)).toBe(true);
        expect((err as AssuranceError).code).toMatch(
          /ASSURANCE_NOT_QUALIFIED|ASSURANCE_AUTHORITY_REQUIRED/,
        );
        return true;
      });
      // Even with a forged certify attempt path: open proof then certify fails closed.
      const proofId = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: life.certificationProofAt,
        expiresAt: life.caseExpiresAt,
      });
      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: proofId,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_NOT_QUALIFIED" });
      expect(
        await env.stack.assuranceService.getCertificateByRun(ctx.assuranceRunId),
      ).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("C. inconclusive / contradictory / freshness — zero certificate", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const clock = new MutableClock(life.runCreatedAt);
    const env = await createP23Env("inconclusive-c", { clock });
    const projectId = uniquePostgresTestId("p23c");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );

      // C1 — missing required evidence → INCONCLUSIVE
      clock.set(life.runCreatedAt);
      const missing = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.farFuture,
        controlOverrides: {
          AUTHZ_APPROVED_NE_EXECUTED: { skip: true },
        },
      });
      expect(missing.run.status).toBe("INCONCLUSIVE");
      expect(
        (
          await env.stack.assuranceService.getAssessmentByRun(
            missing.assuranceRunId,
          )
        )?.outcome,
      ).toBe("INCONCLUSIVE");
      expect(
        await env.stack.assuranceService.getCertificateByRun(
          missing.assuranceRunId,
        ),
      ).toBeNull();

      // C2 — contradictory admissible evidence → not QUALIFIED + findings
      clock.set(life.runCreatedAt);
      const contradict = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.farFuture,
        controlOverrides: {
          VERIFY_EXEC_NE_VERIFIED: { contradict: true },
        },
      });
      const contradictAssessment =
        await env.stack.assuranceService.getAssessmentByRun(
          contradict.assuranceRunId,
        );
      expect(contradictAssessment?.outcome).not.toBe("QUALIFIED");
      const findings = await env.stack.assuranceService.listFindings(
        contradict.assuranceRunId,
      );
      expect(findings.length).toBeGreaterThan(0);
      expect(
        await env.stack.assuranceService.getCertificateByRun(
          contradict.assuranceRunId,
        ),
      ).toBeNull();

      // C1b — PARTIAL quality → INCONCLUSIVE
      clock.set(life.runCreatedAt);
      const partial = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.farFuture,
        controlOverrides: {
          MEMORY_HIST_NE_TRUSTED: { evidenceQuality: "PARTIAL" },
        },
      });
      expect(
        (
          await env.stack.assuranceService.getAssessmentByRun(
            partial.assuranceRunId,
          )
        )?.outcome,
      ).toBe("INCONCLUSIVE");

      // C3 — evidence fresh at assessment; certifier proof still fresh; evidence stale at certification
      // T0 run / T1 evidence / T2 assessment / T3 certifier proof / T4 certification
      const t1 = life.evidenceGeneratedAt;
      clock.set(t1);
      const fresh = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: t1,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.farFuture,
      });
      expect(
        (
          await env.stack.assuranceService.getAssessmentByRun(
            fresh.assuranceRunId,
          )
        )?.outcome,
      ).toBe("QUALIFIED");

      // Advance past evidence freshness; keep governance/proof expiry at farFuture.
      clock.advanceMs((fresh.profile.evidenceFreshnessSeconds + 60) * 1000);
      const t4 = clock.nowIso();
      expect(Date.parse(t4)).toBeGreaterThan(Date.parse(t1));
      expect(Date.parse(life.farFuture)).toBeGreaterThan(Date.parse(t4));

      const staleProof = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: fresh.run,
        assessmentId: fresh.assessmentId,
        assessmentHash: fresh.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: t4,
        expiresAt: life.farFuture,
      });
      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: fresh.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: staleProof,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_EVIDENCE_STALE" });
      expect(
        await env.stack.assuranceService.getCertificateByRun(
          fresh.assuranceRunId,
        ),
      ).toBeNull();
    } finally {
      await env.close();
    }
  });

  it("D. target drift — T1 valid, T2 STALE/DRIFT, historical preserved", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("drift-d");
    const projectId = uniquePostgresTestId("p23d");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      const certRowBefore = await env.db.query<{
        certificate_hash: string;
        target_fingerprint: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT certificate_hash, target_fingerprint, payload
         FROM system_certificates WHERE certificate_id = $1`,
        [cert.certificateId],
      );
      const evidenceBefore = await env.db.query<{
        evidence_id: string;
        content_hash: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT evidence_id, content_hash, payload
         FROM assurance_evidence WHERE assurance_run_id = $1
         ORDER BY evidence_id ASC`,
        [ctx.assuranceRunId],
      );
      const revocationsBefore = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM system_certificate_revocations
         WHERE certificate_id = $1`,
        [cert.certificateId],
      );
      const certCountBefore = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM system_certificates
         WHERE payload->>'assuranceRunId' = $1`,
        [ctx.assuranceRunId],
      );

      await env.stack.assuranceService.validateCertificate({
        certificateId: cert.certificateId,
        currentTarget: ctx.target,
      });

      const t2 = buildTarget(
        { packageLockHash: "drifted-lock-hash-material" },
        ctx.profile,
      );
      expect(computeTargetFingerprint(t2)).not.toBe(cert.targetFingerprint);

      await expect(
        env.stack.assuranceService.validateCertificate({
          certificateId: cert.certificateId,
          currentTarget: t2,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_TARGET_DRIFT" });

      const stale =
        await env.stack.assuranceService.getCertificateCurrentValidity({
          certificateId: cert.certificateId,
          currentTarget: t2,
        });
      expect(stale.currentValidity).toBe("STALE");

      const certRowAfter = await env.db.query<{
        certificate_hash: string;
        target_fingerprint: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT certificate_hash, target_fingerprint, payload
         FROM system_certificates WHERE certificate_id = $1`,
        [cert.certificateId],
      );
      expect(certRowAfter.rows[0]!.certificate_hash).toBe(
        certRowBefore.rows[0]!.certificate_hash,
      );
      expect(certRowAfter.rows[0]!.target_fingerprint).toBe(
        certRowBefore.rows[0]!.target_fingerprint,
      );
      expect(certRowAfter.rows[0]!.payload).toEqual(
        certRowBefore.rows[0]!.payload,
      );
      expect(
        await env.stack.assuranceService.getCertificate(cert.certificateId),
      ).toMatchObject({ certificateHash: cert.certificateHash });

      const evidenceAfter = await env.db.query<{
        evidence_id: string;
        content_hash: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT evidence_id, content_hash, payload
         FROM assurance_evidence WHERE assurance_run_id = $1
         ORDER BY evidence_id ASC`,
        [ctx.assuranceRunId],
      );
      expect(evidenceAfter.rows).toEqual(evidenceBefore.rows);

      const revocationsAfter = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM system_certificate_revocations
         WHERE certificate_id = $1`,
        [cert.certificateId],
      );
      expect(revocationsAfter.rows[0]!.c).toBe(revocationsBefore.rows[0]!.c);

      const certCountAfter = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM system_certificates
         WHERE payload->>'assuranceRunId' = $1`,
        [ctx.assuranceRunId],
      );
      expect(certCountAfter.rows[0]!.c).toBe(certCountBefore.rows[0]!.c);
      expect(certCountAfter.rows[0]!.c).toBe("1");
    } finally {
      await env.close();
    }
  });

  it("E. evidence tamper — integrity fail-closed, stored evidence immutable", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("tamper-e");
    const projectId = uniquePostgresTestId("p23e");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      const ev = await env.db.query<{
        evidence_id: string;
        content_hash: string;
        payload: Record<string, unknown>;
      }>(
        `SELECT evidence_id, content_hash, payload
         FROM assurance_evidence WHERE assurance_run_id = $1 LIMIT 1`,
        [ctx.assuranceRunId],
      );
      const row = ev.rows[0]!;
      const originalHash = row.content_hash;
      const originalContentHashField = (row.payload as { contentHash: string })
        .contentHash;

      // Test seam: mutate evidence body under the same identity while leaving
      // stored contentHash identity unchanged — integrity must fail closed.
      await env.db.query(
        `UPDATE assurance_evidence
         SET payload = jsonb_set(payload, '{metadata,tampered}', 'true'::jsonb)
         WHERE evidence_id = $1`,
        [row.evidence_id],
      );

      await expect(
        env.stack.assuranceService.assertEvidenceIntegrity(ctx.assuranceRunId),
      ).rejects.toMatchObject({ code: "ASSURANCE_EVIDENCE_TAMPERED" });

      await expect(
        env.stack.assuranceService.validateCertificate({
          certificateId: cert.certificateId,
          currentTarget: ctx.target,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_EVIDENCE_TAMPERED" });

      const after = await env.db.query<{
        content_hash: string;
        payload: { contentHash: string; metadata: Record<string, unknown> };
      }>(
        `SELECT content_hash, payload FROM assurance_evidence WHERE evidence_id = $1`,
        [row.evidence_id],
      );
      expect(after.rows[0]!.content_hash).toBe(originalHash);
      expect(after.rows[0]!.payload.contentHash).toBe(originalContentHashField);
      expect(after.rows[0]!.payload.metadata["tampered"]).toBe(true);
    } finally {
      await env.close();
    }
  });

  it("F. exact certifier provenance — G2 does not repair P1/S1", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("prov-f");
    const projectId = uniquePostgresTestId("p23f");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      const grants = await env.stack.canonicalAuthority.listByPrincipal(
        P23_CERTIFIER,
      );
      const g1 = grants.find(
        (g) =>
          g.authorityRole === "ASSURANCE_CERTIFIER" &&
          g.projectId === projectId,
      );
      expect(g1).toBeDefined();
      const g1Material = await env.db.query<{
        grant_id: string;
        principal_id: string;
        principal_type: string;
        project_id: string;
        authorized_environments: unknown;
        enabled: boolean;
      }>(
        `SELECT grant_id, principal_id, principal_type, project_id,
                authorized_environments, enabled
         FROM authority_grants WHERE grant_id = $1`,
        [g1!.grantId],
      );
      expect(g1Material.rows[0]).toBeDefined();

      const p1 = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: life.certificationProofAt,
        expiresAt: life.caseExpiresAt,
      });

      await env.stack.governanceService.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: g1!.grantId,
        reason: "F provenance — revoke G1; equivalent G2 must not repair P1",
        principalId: P23_GOV_ADMIN,
        effectiveAt: life.grantRevocationEffectiveAt,
      });

      const g2 = await env.stack.canonicalAuthority.seed!({
        principalId: P23_CERTIFIER,
        authorityRole: "ASSURANCE_CERTIFIER",
        projectId,
        environmentScope: [P23_ENV],
      });
      expect(g2.grantId).not.toBe(g1!.grantId);

      const g1After = await env.db.query<{
        grant_id: string;
        principal_id: string;
        principal_type: string;
        project_id: string;
        authorized_environments: unknown;
        enabled: boolean;
      }>(
        `SELECT grant_id, principal_id, principal_type, project_id,
                authorized_environments, enabled
         FROM authority_grants WHERE grant_id = $1`,
        [g1!.grantId],
      );
      expect(g1After.rows[0]).toMatchObject({
        grant_id: g1Material.rows[0]!.grant_id,
        principal_id: g1Material.rows[0]!.principal_id,
        principal_type: g1Material.rows[0]!.principal_type,
        project_id: g1Material.rows[0]!.project_id,
        enabled: g1Material.rows[0]!.enabled,
      });
      expect(g1After.rows[0]!.authorized_environments).toEqual(
        g1Material.rows[0]!.authorized_environments,
      );

      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: p1,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_PROOF_STALE" });
      expect(
        await env.stack.assuranceService.getCertificateByRun(ctx.assuranceRunId),
      ).toBeNull();

      const restarted = await createP23ConcurrentStack(env.db, "f-restart");
      await expect(
        restarted.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: p1,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_PROOF_STALE" });

      const p2 = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: life.postRevocationAt,
        expiresAt: life.caseExpiresAt,
      });
      const cert = await env.stack.assuranceService.certify({
        assuranceRunId: ctx.assuranceRunId,
        certifierPrincipalId: P23_CERTIFIER,
        institutionalAuthorizationProofId: p2,
        projectId,
        environment: P23_ENV,
      });
      expect(cert.institutionalAuthorizationProofId).toBe(p2);
      expect(cert.institutionalAuthorizationProofId).not.toBe(p1);
    } finally {
      await env.close();
    }
  });

  it("G. separation of duties — initiator cannot certify; Q can", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("sod-g");
    const projectId = uniquePostgresTestId("p23g");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        operatorPrincipalId: P23_DUAL,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      const dualProof = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_DUAL,
        effectiveFrom: life.certificationProofAt,
        expiresAt: life.caseExpiresAt,
      });
      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_DUAL,
          institutionalAuthorizationProofId: dualProof,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_SEPARATION_VIOLATION" });
      expect(
        await env.stack.assuranceService.getCertificateByRun(ctx.assuranceRunId),
      ).toBeNull();

      const cert = await p23CertifyQualified(env.stack, ctx, {
        certifierPrincipalId: P23_CERTIFIER_Q,
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      expect(cert.certifierPrincipalId).toBe(P23_CERTIFIER_Q);
    } finally {
      await env.close();
    }
  });

  it("H. same-certification concurrency — one canonical certificate", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("conc-h");
    const projectId = uniquePostgresTestId("p23h");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const sharedProof = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: life.certificationProofAt,
        expiresAt: life.caseExpiresAt,
      });

      const stackA = await createP23ConcurrentStack(env.db, "h-a");
      const stackB = await createP23ConcurrentStack(env.db, "h-b");
      const results = await Promise.allSettled([
        stackA.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: sharedProof,
          projectId,
          environment: P23_ENV,
        }),
        stackB.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: sharedProof,
          projectId,
          environment: P23_ENV,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      const ids = new Set(
        fulfilled.map(
          (r) =>
            (r as PromiseFulfilledResult<{ certificateId: string }>).value
              .certificateId,
        ),
      );
      expect(ids.size).toBe(1);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM system_certificates
           WHERE payload->>'assuranceRunId' = $1`,
          [ctx.assuranceRunId],
        ),
      ).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("I. competing certification material — conflict, no dual valid certs", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("conflict-i");
    const projectId = uniquePostgresTestId("p23i");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        certifierPrincipalId: P23_CERTIFIER,
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const competingProof = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER_Q,
        effectiveFrom: life.postRevocationAt,
        expiresAt: life.caseExpiresAt,
      });
      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER_Q,
          institutionalAuthorizationProofId: competingProof,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_CERTIFICATION_CONFLICT" });
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM system_certificates
           WHERE payload->>'assuranceRunId' = $1`,
          [ctx.assuranceRunId],
        ),
      ).toBe(1);
      expect(
        (await env.stack.assuranceService.getCertificate(cert.certificateId))
          ?.certifierPrincipalId,
      ).toBe(P23_CERTIFIER);
    } finally {
      await env.close();
    }
  });

  it("FAILPOINT. certification atomicity — rollback then retry", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const projectId = uniquePostgresTestId("p23fp");
    const env = await createP23Env("failpoint", {
      assuranceCertificationFailpoint: {
        name: "AFTER_CERTIFICATE_MATERIAL_BEFORE_COMMIT",
        trigger: () => {
          throw new Error("assurance certification failpoint");
        },
      },
    });
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const proofId = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: life.certificationProofAt,
        expiresAt: life.caseExpiresAt,
      });
      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: proofId,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toBeTruthy();

      const clean = await createP23ConcurrentStack(env.db, "fp-clean");
      expect(
        await clean.assuranceService.getCertificateByRun(ctx.assuranceRunId),
      ).toBeNull();
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM assurance_audit_events
           WHERE assurance_run_id = $1 AND event_type = 'CERTIFICATE_ISSUED'`,
          [ctx.assuranceRunId],
        ),
      ).toBe(0);

      const cert = await clean.assuranceService.certify({
        assuranceRunId: ctx.assuranceRunId,
        certifierPrincipalId: P23_CERTIFIER,
        institutionalAuthorizationProofId: proofId,
        projectId,
        environment: P23_ENV,
      });
      expect(cert.certificateId).toBeTruthy();
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM system_certificates
           WHERE payload->>'assuranceRunId' = $1`,
          [ctx.assuranceRunId],
        ),
      ).toBe(1);
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM assurance_audit_events
           WHERE assurance_run_id = $1 AND event_type = 'CERTIFICATE_ISSUED'`,
          [ctx.assuranceRunId],
        ),
      ).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("J. bounded fault injection — scoped, recoverable", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("fault-j");
    const projectId = uniquePostgresTestId("p23j");
    const otherProject = uniquePostgresTestId("p23j-other");
    try {
      await seedP23Authority(env.db, projectId);
      await seedP23Authority(env.db, otherProject);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const unrelatedInstitution = await p23CreateInstitution(
        env.stack,
        otherProject,
      );

      const snapshotUnrelated = async () => {
        const grants = await env.db.query<{
          grant_id: string;
          enabled: boolean;
        }>(
          `SELECT grant_id, enabled FROM authority_grants
           WHERE project_id = $1 ORDER BY grant_id ASC`,
          [otherProject],
        );
        const runs = await env.db.query<{ assurance_run_id: string }>(
          `SELECT assurance_run_id FROM assurance_runs
           WHERE payload->'targetIdentity' IS NOT NULL
             AND (
               payload->>'profileId' IS NOT NULL
               AND payload::text LIKE '%' || $1 || '%'
             )
           ORDER BY assurance_run_id ASC`,
          [otherProject],
        );
        const certs = await env.db.query<{ certificate_id: string }>(
          `SELECT certificate_id FROM system_certificates
           WHERE payload::text LIKE '%' || $1 || '%'
           ORDER BY certificate_id ASC`,
          [otherProject],
        );
        const mandates = await env.db.query<{ mandate_id: string }>(
          `SELECT mandate_id FROM governance_mandates
           WHERE institution_id = $1 ORDER BY mandate_id ASC`,
          [unrelatedInstitution.institutionId],
        );
        return {
          grants: grants.rows,
          runs: runs.rows.map((r) => r.assurance_run_id),
          certs: certs.rows.map((r) => r.certificate_id),
          mandates: mandates.rows.map((r) => r.mandate_id),
        };
      };

      const beforeUnrelated = await snapshotUnrelated();

      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      env.stack.assuranceService.armFaultInjection({
        point: "AFTER_CERTIFICATE_MATERIAL_BEFORE_COMMIT",
        assuranceRunId: ctx.assuranceRunId,
        environment: "TEST",
      });
      const proofId = await p23OpenCertificationProof(env.stack, {
        institutionId,
        projectId,
        run: ctx.run,
        assessmentId: ctx.assessmentId,
        assessmentHash: ctx.assessmentHash,
        certifierPrincipalId: P23_CERTIFIER,
        effectiveFrom: life.certificationProofAt,
        expiresAt: life.caseExpiresAt,
      });
      await expect(
        env.stack.assuranceService.certify({
          assuranceRunId: ctx.assuranceRunId,
          certifierPrincipalId: P23_CERTIFIER,
          institutionalAuthorizationProofId: proofId,
          projectId,
          environment: P23_ENV,
        }),
      ).rejects.toMatchObject({ code: "ASSURANCE_EVALUATION_FAILED" });
      expect(
        await env.stack.assuranceService.getCertificateByRun(ctx.assuranceRunId),
      ).toBeNull();
      expect(
        await p23CountScoped(
          env.db,
          `SELECT COUNT(*)::int AS c FROM assurance_runs
           WHERE assurance_run_id = $1`,
          [ctx.assuranceRunId],
        ),
      ).toBe(1);

      const afterFaultUnrelated = await snapshotUnrelated();
      expect(afterFaultUnrelated).toEqual(beforeUnrelated);

      const cert = await env.stack.assuranceService.certify({
        assuranceRunId: ctx.assuranceRunId,
        certifierPrincipalId: P23_CERTIFIER,
        institutionalAuthorizationProofId: proofId,
        projectId,
        environment: P23_ENV,
      });
      expect(cert.certificateId).toBeTruthy();

      const afterRetryUnrelated = await snapshotUnrelated();
      expect(afterRetryUnrelated).toEqual(beforeUnrelated);
    } finally {
      await env.close();
    }
  });

  it("L. replay determinism", async () => {
    const r1 = replayDeterministic({
      replayId: "rp_p23_l",
      assuranceRunId: "arun_replay",
      originalInputHash: "in_hash_1",
      evaluatorVersion: "phase23-evaluator-v1",
      material: { seed: 7, challengeVersion: "1" },
    });
    const env = await createP23Env("replay-l");
    try {
      const restarted = await createP23ConcurrentStack(env.db, "l-r");
      const r2 = restarted.assuranceService.replay({
        replayId: "rp_p23_l",
        assuranceRunId: "arun_replay",
        originalInputHash: "in_hash_1",
        evaluatorVersion: "phase23-evaluator-v1",
        material: { seed: 7, challengeVersion: "1" },
      });
      expect(r2.resultFingerprint).toBe(r1.resultFingerprint);
      const r3 = restarted.assuranceService.replay({
        replayId: "rp_p23_l",
        assuranceRunId: "arun_replay",
        originalInputHash: "in_hash_1",
        evaluatorVersion: "phase23-evaluator-v1",
        material: { seed: 8, challengeVersion: "1" },
      });
      expect(r3.resultFingerprint).not.toBe(r1.resultFingerprint);
    } finally {
      await env.close();
    }
  });

  it("M. data minimization — sentinels absent from assurance storage", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP23Env("min-m");
    const projectId = uniquePostgresTestId("p23m");
    const sentinels = [
      "SENTINEL_APPROVAL_NONCE_P23",
      "SENTINEL_DELIVERY_SECRET_P23",
      "SENTINEL_DB_PASSWORD_P23",
      "SENTINEL_BEARER_TOKEN_P23",
      "SENTINEL_HIDDEN_REASONING_P23",
    ];
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(
        env.stack,
        projectId,
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      const evidenceIds = (
        await env.db.query<{ evidence_id: string }>(
          `SELECT evidence_id FROM assurance_evidence WHERE assurance_run_id = $1`,
          [ctx.assuranceRunId],
        )
      ).rows.map((r) => r.evidence_id);

      for (const sentinel of sentinels) {
        const hit = await env.db.query<{ c: number }>(
          `SELECT (
             (SELECT COUNT(*)::int FROM assurance_runs
              WHERE assurance_run_id = $1 AND payload::text LIKE '%' || $2 || '%')
           + (SELECT COUNT(*)::int FROM system_certificates
              WHERE certificate_id = $3 AND payload::text LIKE '%' || $2 || '%')
           + (SELECT COUNT(*)::int FROM assurance_evidence
              WHERE evidence_id = ANY($4::text[]) AND payload::text LIKE '%' || $2 || '%')
           + (SELECT COUNT(*)::int FROM assurance_audit_events
              WHERE assurance_run_id = $1 AND payload::text LIKE '%' || $2 || '%')
           ) AS c`,
          [ctx.assuranceRunId, sentinel, cert.certificateId, evidenceIds],
        );
        expect(hit.rows[0]!.c).toBe(0);
      }
    } finally {
      await env.close();
    }
  });
});
