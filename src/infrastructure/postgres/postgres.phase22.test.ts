import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { isDurabilityError } from "../../durability/errors.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { FederationError, isFederationError } from "../../federation/errors.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import {
  createP22ConcurrentStack,
  createP22Env,
  p22Accept,
  p22BilateralScope,
  p22LifecycleFromAnchor,
  p22Ratify,
  p22Withdraw,
  P22_ACCEPTOR_B,
  P22_EVIDENCE_A,
  P22_GOV_ADMIN,
  P22_NEGOTIATOR_A,
  P22_RATIFIER_A,
  P22_RATIFIER_B,
  P22_RATIFIER_C,
  P22_REQUESTER_B,
  seedP22Authority,
} from "./postgres.phase22.helpers.js";

const ANCHOR = "2026-09-01T00:00:00.000Z";

describe("Phase 22 postgres governed federation", () => {
  it("B-unit. preserves FederationError through withTransaction", async () => {
    const env = await createP22Env("tx-preserve");
    try {
      await expect(
        env.db.withTransaction(async () => {
          throw new FederationError(
            "FEDERATION_RATIFICATION_REQUIRED",
            "missing participant ratification",
            { institutionId: "inst_x" },
          );
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(FederationError);
        expect(err).toMatchObject({
          code: "FEDERATION_RATIFICATION_REQUIRED",
          details: { institutionId: "inst_x" },
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

  it("reports current schema compatibility with Phase22 migration present", async () => {
    const env = await createP22Env("schema");
    try {
      const health = await new (
        await import("./health.js")
      ).PostgresHealthService(env.db, "postgres").readiness();
      expect(health.supportedSchemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaCompatible).toBe(true);

      const status = await new (
        await import("./migrate.js")
      ).PostgresMigrationRunner(env.db).status();
      expect(status.applied.map((row) => row.version)).toContain(
        "017_phase22_governed_federation",
      );
    } finally {
      await env.close();
    }
  });

  it("A. primary bilateral ladder — activate, restart, zero runs", async () => {
    const env = await createP22Env("ladder");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22a");
      const projectB = uniquePostgresTestId("p22b");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);

      const instA = await env.stack.governanceService.createInstitution({
        name: `Inst A ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `Inst B ${projectB}`,
        projectIds: [projectB],
      });

      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [
          instA.institutionId,
          instB.institutionId,
        ],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE", "SHARE_EVIDENCE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });

      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });

      const activated = await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });
      expect(activated.agreement.status).toBe("ACTIVE");
      expect(activated.activation.targetFederationStateFingerprint).toBeTruthy();

      const runsBefore = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM runs WHERE project_id = ANY($1::text[])`,
        [[projectA, projectB]],
      );
      expect(runsBefore.rows[0]!.c).toBe(0);

      const env2 = await createP22ConcurrentStack(env.db, "reload");
      const reloaded = await env2.federationService.getAgreement(
        agreement.agreementId,
      );
      expect(reloaded.status).toBe("ACTIVE");
      const act = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_activation_records
         WHERE agreement_id = $1`,
        [agreement.agreementId],
      );
      expect(act.rows[0]!.c).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("B. unilateral ratification denied", async () => {
    const env = await createP22Env("unilateral");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ua");
      const projectB = uniquePostgresTestId("p22ub");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `UA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `UB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await expect(
        env.stack.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_RATIFICATION_REQUIRED" });
      const after = await env.stack.federationService.getAgreement(
        agreement.agreementId,
      );
      expect(after.status).not.toBe("ACTIVE");
      const activations = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_activation_records
         WHERE agreement_id = $1`,
        [agreement.agreementId],
      );
      expect(activations.rows[0]!.c).toBe(0);
      const runs = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM runs
         WHERE project_id = ANY($1::text[])`,
        [[projectA, projectB]],
      );
      expect(runs.rows[0]!.c).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("C. ratifier exact provenance — G1 revoke + G2 cannot repair", async () => {
    const env = await createP22Env("provenance");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22pa");
      const projectB = uniquePostgresTestId("p22pb");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `PA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `PB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });

      const ratificationB = await env.db.query<{ payload: unknown }>(
        `SELECT payload FROM federation_ratifications
         WHERE agreement_id = $1 AND institution_id = $2`,
        [agreement.agreementId, instB.institutionId],
      );
      const rawPayload = ratificationB.rows[0]?.payload;
      const stored =
        typeof rawPayload === "string"
          ? (JSON.parse(rawPayload) as {
              ratifiedAt: string;
              institutionalAuthorizationProofId: string;
              authoritySnapshotIds: string[];
            })
          : (rawPayload as {
              ratifiedAt: string;
              institutionalAuthorizationProofId: string;
              authoritySnapshotIds: string[];
            } | undefined);
      expect(stored?.institutionalAuthorizationProofId).toBeTruthy();
      expect(stored?.authoritySnapshotIds?.length).toBeGreaterThan(0);
      const t0 = stored!.ratifiedAt;

      const g1 = await env.db.query<{ grant_id: string }>(
        `SELECT grant_id FROM authority_grants
         WHERE principal_id = $1 AND principal_type = 'FEDERATION_RATIFIER'
           AND project_id = $2 AND enabled = TRUE`,
        [P22_RATIFIER_B, projectB],
      );
      expect(g1.rows[0]).toBeDefined();
      const g1Id = g1.rows[0]!.grant_id;

      // T0 < T1 <= T2 — no same-timestamp ambiguity; wall clock after ratification.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const t1 = new Date().toISOString();
      expect(Date.parse(t0)).toBeLessThan(Date.parse(t1));
      await env.stack.governanceService.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: g1Id,
        reason: "C provenance — G1 revoked; equivalent G2 must not repair",
        principalId: P22_GOV_ADMIN,
        effectiveAt: t1,
      });

      // Equivalent replacement principal/role exists but cannot repair G1 proof.
      await seedP22Authority(env.db, projectB, [
        {
          principalId: `${P22_RATIFIER_B}_g2_peer`,
          principalType: "FEDERATION_RATIFIER",
        },
      ]);

      await expect(
        env.stack.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_RATIFICATION_STALE" });

      // Restart proof: freshness is durable, not heap-local.
      const restarted = await createP22ConcurrentStack(env.db, "c-restart");
      await expect(
        restarted.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_RATIFICATION_STALE" });

      const historicalRatif = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_ratifications
         WHERE agreement_id = $1 AND institution_id = $2`,
        [agreement.agreementId, instB.institutionId],
      );
      expect(historicalRatif.rows[0]!.c).toBe(1);
      const stillG1Proof = await env.db.query<{
        payload: { institutionalAuthorizationProofId: string };
      }>(
        `SELECT payload FROM federation_ratifications
         WHERE agreement_id = $1 AND institution_id = $2`,
        [agreement.agreementId, instB.institutionId],
      );
      expect(
        stillG1Proof.rows[0]!.payload.institutionalAuthorizationProofId,
      ).toBe(stored!.institutionalAuthorizationProofId);

      // Fresh G2 path: new grant identity + new agreement + new ratification.
      // Do not mutate the G1-bound ratification; unique (principal, role, project)
      // requires retiring G1 before inserting G2.
      const g2Id = uniquePostgresTestId("p22_g2");
      await env.db.query(`DELETE FROM authority_grants WHERE grant_id = $1`, [
        g1Id,
      ]);
      await env.db.query(
        `INSERT INTO authority_grants (
           grant_id, principal_id, principal_type, project_id,
           authorized_environments, enabled, authority_version
         ) VALUES ($1, $2, 'FEDERATION_RATIFIER', $3, $4::jsonb, TRUE, '1')`,
        [
          g2Id,
          P22_RATIFIER_B,
          projectB,
          JSON.stringify([EXAMPLE_ENVIRONMENT]),
        ],
      );

      const agreement2 = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
        federationId: agreement.federationId,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement2.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement2.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      const freshRatif = await env.db.query<{
        payload: { institutionalAuthorizationProofId: string };
      }>(
        `SELECT payload FROM federation_ratifications
         WHERE agreement_id = $1 AND institution_id = $2`,
        [agreement2.agreementId, instB.institutionId],
      );
      expect(
        freshRatif.rows[0]!.payload.institutionalAuthorizationProofId,
      ).not.toBe(stored!.institutionalAuthorizationProofId);

      const { agreement: active } = await env.stack.federationService.activate({
        agreementId: agreement2.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });
      expect(active.status).toBe("ACTIVE");
      expect(active.agreementId).toBe(agreement2.agreementId);

      const oldStillStored = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_ratifications
         WHERE agreement_id = $1
           AND payload->>'institutionalAuthorizationProofId' = $2`,
        [agreement.agreementId, stored!.institutionalAuthorizationProofId],
      );
      expect(oldStillStored.rows[0]!.c).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("D. same-agreement concurrent activation is idempotent", async () => {
    const env = await createP22Env("concurrent-same");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22da");
      const projectB = uniquePostgresTestId("p22db");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `DA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `DB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });

      const stack2 = await createP22ConcurrentStack(env.db, "d2");
      const [r1, r2] = await Promise.all([
        env.stack.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
        stack2.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
      ]);
      expect(r1.agreement.status).toBe("ACTIVE");
      expect(r2.agreement.status).toBe("ACTIVE");
      expect(r1.activation.activationRecordId).toBe(
        r2.activation.activationRecordId,
      );
      const count = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_activation_records
         WHERE agreement_id = $1`,
        [agreement.agreementId],
      );
      expect(count.rows[0]!.c).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("E. competing version serialization — one ACTIVE, other STALE", async () => {
    const env = await createP22Env("compete");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ea");
      const projectB = uniquePostgresTestId("p22eb");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `EA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `EB ${projectB}`,
        projectIds: [projectB],
      });
      const p1 = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      const p2 = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE", "SHARE_EVIDENCE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
        federationId: p1.federationId,
      });
      expect(p1.baseFederationStateFingerprint).toBe(
        p2.baseFederationStateFingerprint,
      );

      for (const agreementId of [p1.agreementId, p2.agreementId]) {
        await p22Ratify(env.stack, {
          agreementId,
          institutionId: instA.institutionId,
          projectId: projectA,
          ratifierPrincipalId: P22_RATIFIER_A,
          effectiveFrom: life.proposedAt,
          expiresAt: life.caseExpiresAt,
        });
        await p22Ratify(env.stack, {
          agreementId,
          institutionId: instB.institutionId,
          projectId: projectB,
          ratifierPrincipalId: P22_RATIFIER_B,
          effectiveFrom: life.proposedAt,
          expiresAt: life.caseExpiresAt,
        });
      }

      const stack2 = await createP22ConcurrentStack(env.db, "e2");
      const results = await Promise.allSettled([
        env.stack.federationService.activate({
          agreementId: p1.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
        stack2.federationService.activate({
          agreementId: p2.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
      ]);
      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      const err = (rejected[0] as PromiseRejectedResult).reason;
      // After FederationError TX preservation: loser must surface exact domain code
      // (not DATABASE_TRANSACTION_FAILED).
      if (!isFederationError(err) || err.code !== "FEDERATION_BASE_STATE_STALE") {
        throw new Error(
          `E loser error expected FEDERATION_BASE_STATE_STALE, got ${
            err instanceof Error
              ? `${err.name}:${(err as { code?: string }).code ?? err.message}`
              : String(err)
          }`,
        );
      }
      expect(err.code).toBe("FEDERATION_BASE_STATE_STALE");
      const active = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_agreements
         WHERE federation_id = $1 AND status = 'ACTIVE'`,
        [p1.federationId],
      );
      expect(active.rows[0]!.c).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("F. activation failpoint rolls back; retry succeeds once", async () => {
    let armed = true;
    const env = await createP22Env("failpoint", {
      federationActivationFailpoint: {
        name: "after_material_before_record",
        trigger: () => {
          if (armed) {
            armed = false;
            throw new Error("federation-failpoint");
          }
        },
      },
    });
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22fa");
      const projectB = uniquePostgresTestId("p22fb");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `FA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `FB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });

      await expect(
        env.stack.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        }),
      ).rejects.toThrow("federation-failpoint");

      const mid = await env.stack.federationService.getAgreement(
        agreement.agreementId,
      );
      expect(mid.status).not.toBe("ACTIVE");
      const actCount = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_activation_records
         WHERE agreement_id = $1`,
        [agreement.agreementId],
      );
      expect(actCount.rows[0]!.c).toBe(0);

      const ok = await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });
      expect(ok.agreement.status).toBe("ACTIVE");
      expect(ok.activation.targetFederationStateFingerprint).toBeTruthy();
    } finally {
      await env.close();
    }
  });

  it("G. three-institution lock order is deterministic", async () => {
    const env = await createP22Env("lock-order");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ga");
      const projectB = uniquePostgresTestId("p22gb");
      const projectC = uniquePostgresTestId("p22gc");
      for (const p of [projectA, projectB, projectC]) {
        await seedP22Authority(env.db, p);
      }
      const instA = await env.stack.governanceService.createInstitution({
        name: `GA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `GB ${projectB}`,
        projectIds: [projectB],
      });
      const instC = await env.stack.governanceService.createInstitution({
        name: `GC ${projectC}`,
        projectIds: [projectC],
      });
      const participants = [
        instC.institutionId,
        instA.institutionId,
        instB.institutionId,
      ];
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: participants,
        scope: {
          participantInstitutionIds: participants,
          permittedPairs: [
            {
              sourceInstitutionId: instA.institutionId,
              targetInstitutionId: instB.institutionId,
            },
          ],
          permittedSourceProjectIds: [projectA],
          permittedTargetProjectIds: [projectB],
          permittedEnvironments: [EXAMPLE_ENVIRONMENT],
          permittedIntentKinds: ["OBJECTIVE"],
          evidenceSharingClasses: [],
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        },
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      for (const [inst, project, ratifier] of [
        [instA.institutionId, projectA, P22_RATIFIER_A],
        [instB.institutionId, projectB, P22_RATIFIER_B],
        [instC.institutionId, projectC, P22_RATIFIER_C],
      ] as const) {
        await p22Ratify(env.stack, {
          agreementId: agreement.agreementId,
          institutionId: inst,
          projectId: project,
          ratifierPrincipalId: ratifier,
          effectiveFrom: life.proposedAt,
          expiresAt: life.caseExpiresAt,
        });
      }
      const activated = await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });
      expect(activated.agreement.status).toBe("ACTIVE");
      expect(activated.activation.participantInstitutionIds).toEqual(
        [...participants].sort((a, b) => a.localeCompare(b)),
      );
    } finally {
      await env.close();
    }
  });

  it("H. no transitive trust A→C via AB+BC", async () => {
    const env = await createP22Env("no-transitive");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ha");
      const projectB = uniquePostgresTestId("p22hb");
      const projectC = uniquePostgresTestId("p22hc");
      for (const p of [projectA, projectB, projectC]) {
        await seedP22Authority(env.db, p);
      }
      const instA = await env.stack.governanceService.createInstitution({
        name: `HA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `HB ${projectB}`,
        projectIds: [projectB],
      });
      const instC = await env.stack.governanceService.createInstitution({
        name: `HC ${projectC}`,
        projectIds: [projectC],
      });

      async function activatePair(
        source: { id: string; project: string },
        target: { id: string; project: string; ratifier: string },
      ) {
        const agreement = await env.stack.federationService.proposeAgreement({
          participantInstitutionIds: [source.id, target.id],
          scope: p22BilateralScope({
            institutionA: source.id,
            institutionB: target.id,
            projectA: source.project,
            projectB: target.project,
            effectiveFrom: life.proposedAt,
            effectiveUntil: life.farFuture,
          }),
          allowedActions: ["PROPOSE_OBJECTIVE"],
          proposingInstitutionId: source.id,
          proposedByPrincipalId: P22_NEGOTIATOR_A,
          projectId: source.project,
          environment: EXAMPLE_ENVIRONMENT,
        });
        await p22Ratify(env.stack, {
          agreementId: agreement.agreementId,
          institutionId: source.id,
          projectId: source.project,
          ratifierPrincipalId: P22_RATIFIER_A,
          effectiveFrom: life.proposedAt,
          expiresAt: life.caseExpiresAt,
        });
        await p22Ratify(env.stack, {
          agreementId: agreement.agreementId,
          institutionId: target.id,
          projectId: target.project,
          ratifierPrincipalId: target.ratifier,
          effectiveFrom: life.proposedAt,
          expiresAt: life.caseExpiresAt,
        });
        await env.stack.federationService.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: P22_GOV_ADMIN,
        });
        return agreement;
      }

      const ab = await activatePair(
        { id: instA.institutionId, project: projectA },
        {
          id: instB.institutionId,
          project: projectB,
          ratifier: P22_RATIFIER_B,
        },
      );
      await activatePair(
        { id: instB.institutionId, project: projectB },
        {
          id: instC.institutionId,
          project: projectC,
          ratifier: P22_RATIFIER_C,
        },
      );

      await expect(
        env.stack.federationService.proposeWorkIntent({
          agreementId: ab.agreementId,
          sourceInstitutionId: instA.institutionId,
          sourceProjectId: projectA,
          targetInstitutionId: instC.institutionId,
          targetProjectId: projectC,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
          requestedOutcome: "transitive forbidden",
          acceptanceCriteria: ["no"],
          proposedByPrincipalId: P22_NEGOTIATOR_A,
          projectId: projectA,
          environment: EXAMPLE_ENVIRONMENT,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_TRANSITIVE_TRUST_DENIED" });
    } finally {
      await env.close();
    }
  });

  it("I/J. federated work lifecycle + no source requester impersonation", async () => {
    const env = await createP22Env("lifecycle");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ia");
      const projectB = uniquePostgresTestId("p22ib");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `IA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `IB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });

      const intent = await env.stack.federationService.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: instA.institutionId,
        sourceProjectId: projectA,
        targetInstitutionId: instB.institutionId,
        targetProjectId: projectB,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        requestedOutcome: "federated work",
        acceptanceCriteria: ["done"],
        constraints: [],
        nonGoals: [],
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });

      await p22Accept(env.stack, {
        intentId: intent.intentId,
        institutionId: instB.institutionId,
        projectId: projectB,
        acceptorPrincipalId: P22_ACCEPTOR_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });

      const runsAfterAccept = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM runs WHERE project_id = $1`,
        [projectB],
      );
      expect(runsAfterAccept.rows[0]!.c).toBe(0);
      // Canonical Phase 6/11 ApprovalRequest storage is json_documents.
      const approvals = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'approval_requests' AND project_id = $1`,
        [projectB],
      );
      expect(approvals.rows[0]!.c).toBe(0);
      const attempts = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'execution_attempts' AND project_id = $1`,
        [projectB],
      );
      expect(attempts.rows[0]!.c).toBe(0);
      const intentScopedAttempts = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'execution_attempts'
           AND payload->>'intentId' = $1`,
        [intent.intentId],
      );
      expect(intentScopedAttempts.rows[0]!.c).toBe(0);

      await expect(
        env.stack.federationService.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: "",
        }),
      ).rejects.toMatchObject({
        code: "FEDERATED_REQUESTER_AUTHORITY_REQUIRED",
      });

      const { materialization, admission } =
        await env.stack.federationService.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: P22_REQUESTER_B,
        });
      expect(admission.outcome).toBe("ADMITTED");
      expect(materialization.targetProjectId).toBe(projectB);
      expect(materialization.targetLocalRequesterId).toBe(P22_REQUESTER_B);

      const run = await env.db.query<{ project_id: string; state: string }>(
        `SELECT project_id, state FROM runs WHERE run_id = $1`,
        [materialization.runId],
      );
      expect(run.rows[0]?.project_id).toBe(projectB);
      expect(run.rows[0]?.state).toBe("ADMITTED");

      const envReload = await createP22ConcurrentStack(env.db, "i-reload");
      const mat = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federated_materializations
         WHERE intent_id = $1`,
        [intent.intentId],
      );
      expect(mat.rows[0]!.c).toBe(1);
      void envReload;
    } finally {
      await env.close();
    }
  });

  it("K. withdrawal blocks new work; history survives", async () => {
    const env = await createP22Env("withdraw");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ka");
      const projectB = uniquePostgresTestId("p22kb");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `KA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `KB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });
      const intent = await env.stack.federationService.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: instA.institutionId,
        sourceProjectId: projectA,
        targetInstitutionId: instB.institutionId,
        targetProjectId: projectB,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        requestedOutcome: "keep",
        acceptanceCriteria: ["ok"],
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Accept(env.stack, {
        intentId: intent.intentId,
        institutionId: instB.institutionId,
        projectId: projectB,
        acceptorPrincipalId: P22_ACCEPTOR_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      const { materialization } =
        await env.stack.federationService.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: P22_REQUESTER_B,
        });

      await p22Withdraw(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        actorPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });

      await expect(
        env.stack.federationService.proposeWorkIntent({
          agreementId: agreement.agreementId,
          sourceInstitutionId: instA.institutionId,
          sourceProjectId: projectA,
          targetInstitutionId: instB.institutionId,
          targetProjectId: projectB,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
          requestedOutcome: "blocked",
          acceptanceCriteria: ["no"],
          proposedByPrincipalId: P22_NEGOTIATOR_A,
          projectId: projectA,
          environment: EXAMPLE_ENVIRONMENT,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_SUSPENDED" });

      const run = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM runs WHERE run_id = $1`,
        [materialization.runId],
      );
      expect(run.rows[0]!.c).toBe(1);
      const agr = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM federation_agreements
         WHERE agreement_id = $1`,
        [agreement.agreementId],
      );
      expect(agr.rows[0]!.c).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("L. project/environment containment rejects out-of-scope intent", async () => {
    const env = await createP22Env("containment");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22la");
      const projectB = uniquePostgresTestId("p22lb");
      const projectB2 = uniquePostgresTestId("p22lb2");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      await seedP22Authority(env.db, projectB2);
      const instA = await env.stack.governanceService.createInstitution({
        name: `LA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `LB ${projectB}`,
        projectIds: [projectB, projectB2],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });

      await expect(
        env.stack.federationService.proposeWorkIntent({
          agreementId: agreement.agreementId,
          sourceInstitutionId: instA.institutionId,
          sourceProjectId: projectA,
          targetInstitutionId: instB.institutionId,
          targetProjectId: projectB2,
          requestedEnvironment: "production",
          requestedOutcome: "escape",
          acceptanceCriteria: ["no"],
          proposedByPrincipalId: P22_NEGOTIATOR_A,
          projectId: projectA,
          environment: EXAMPLE_ENVIRONMENT,
        }),
      ).rejects.toMatchObject({ code: "FEDERATED_TARGET_SCOPE_DENIED" });

      const runs = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM runs WHERE project_id = ANY($1::text[])`,
        [[projectB, projectB2]],
      );
      expect(runs.rows[0]!.c).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("M. external evidence remains untrusted", async () => {
    const env = await createP22Env("evidence");
    const life = p22LifecycleFromAnchor(ANCHOR);
    try {
      const projectA = uniquePostgresTestId("p22ma");
      const projectB = uniquePostgresTestId("p22mb");
      await seedP22Authority(env.db, projectA);
      await seedP22Authority(env.db, projectB);
      const instA = await env.stack.governanceService.createInstitution({
        name: `MA ${projectA}`,
        projectIds: [projectA],
      });
      const instB = await env.stack.governanceService.createInstitution({
        name: `MB ${projectB}`,
        projectIds: [projectB],
      });
      const agreement = await env.stack.federationService.proposeAgreement({
        participantInstitutionIds: [instA.institutionId, instB.institutionId],
        scope: p22BilateralScope({
          institutionA: instA.institutionId,
          institutionB: instB.institutionId,
          projectA,
          projectB,
          effectiveFrom: life.proposedAt,
          effectiveUntil: life.farFuture,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE", "SHARE_EVIDENCE"],
        proposingInstitutionId: instA.institutionId,
        proposedByPrincipalId: P22_NEGOTIATOR_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instA.institutionId,
        projectId: projectA,
        ratifierPrincipalId: P22_RATIFIER_A,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await p22Ratify(env.stack, {
        agreementId: agreement.agreementId,
        institutionId: instB.institutionId,
        projectId: projectB,
        ratifierPrincipalId: P22_RATIFIER_B,
        effectiveFrom: life.proposedAt,
        expiresAt: life.caseExpiresAt,
      });
      await env.stack.federationService.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: P22_GOV_ADMIN,
      });

      const envelope = await env.stack.federationService.shareEvidence({
        agreementId: agreement.agreementId,
        sourceInstitutionId: instA.institutionId,
        sourceProjectId: projectA,
        sourceEvidenceId: `ev_${projectA}`,
        contentHash: "deadbeef",
        destinationInstitutionId: instB.institutionId,
        destinationProjectId: projectB,
        dataClassification: "INTERNAL",
        provenance: "source-artifact",
        sharedByPrincipalId: P22_EVIDENCE_A,
        projectId: projectA,
        environment: EXAMPLE_ENVIRONMENT,
      });
      expect(envelope.receivingStatus).toBe("EXTERNAL_UNVERIFIED");

      // Canonical Phase 8/11 CompletionRecord storage is json_documents.
      const completions = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'completion_records' AND project_id = $1`,
        [projectB],
      );
      expect(completions.rows[0]!.c).toBe(0);
      const precedents = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'promoted_precedents' AND project_id = $1`,
        [projectB],
      );
      expect(precedents.rows[0]!.c).toBe(0);
      const verifications = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'outcome_verifications' AND project_id = $1`,
        [projectB],
      );
      expect(verifications.rows[0]!.c).toBe(0);
    } finally {
      await env.close();
    }
  });
});
