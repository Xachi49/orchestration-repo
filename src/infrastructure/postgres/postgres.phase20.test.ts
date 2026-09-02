import { describe, expect, it } from "vitest";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
} from "../../control-plane/fixtures.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import { EXPERIMENT_STATES } from "../../experiments/index.js";
import {
  CanonicalAuthorityGrantSchema,
  type CanonicalAuthorityGrant,
} from "../../governance/index.js";
import { isGovernanceError } from "../../governance/errors.js";

type TestEnv = Awaited<ReturnType<typeof createTestStack>>;
type Stack = TestEnv["stack"];

const GOV_ADMIN = "gov_admin_p20";
const HOLD_OP = "hold_op_p20";
const ALLOC_A = "alloc_a_p20";
const ALLOC_B = "alloc_b_p20";
const DELEGATE = "delegate_p20";

async function seedGovernanceAuthority(
  db: Stack["db"],
  projectId: string,
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  await authority.seed([
    {
      principalId: GOV_ADMIN,
      principalType: "GOVERNANCE_ADMIN",
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    },
    {
      principalId: HOLD_OP,
      principalType: "GOVERNANCE_HOLD_OPERATOR",
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    },
  ]);
}

async function seedAllocatorAuthority(
  db: Stack["db"],
  projectId: string,
): Promise<{
  parentGrantA: CanonicalAuthorityGrant;
  grantAId: string;
  grantBId: string;
}> {
  const authority = new PostgresAuthorityDirectory(db);
  await authority.seed([
    {
      principalId: ALLOC_A,
      principalType: "PORTFOLIO_ALLOCATOR",
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    },
    {
      principalId: ALLOC_B,
      principalType: "PORTFOLIO_ALLOCATOR",
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    },
  ]);
  const rows = await db.query<{
    grant_id: string;
    principal_id: string;
    principal_type: string;
    project_id: string;
    authorized_environments: string[];
    enabled: boolean;
  }>(
    `SELECT grant_id, principal_id, principal_type, project_id,
            authorized_environments, enabled
     FROM authority_grants
     WHERE project_id = $1 AND principal_type = 'PORTFOLIO_ALLOCATOR'
       AND principal_id = ANY($2::text[])`,
    [projectId, [ALLOC_A, ALLOC_B]],
  );
  const rowA = rows.rows.find((r) => r.principal_id === ALLOC_A);
  const rowB = rows.rows.find((r) => r.principal_id === ALLOC_B);
  if (!rowA || !rowB) {
    throw new Error("Failed to seed allocator authority_grants");
  }
  const parentGrantA = CanonicalAuthorityGrantSchema.parse({
    grantId: rowA.grant_id,
    principalId: rowA.principal_id,
    authorityRole: rowA.principal_type,
    projectId: rowA.project_id,
    environmentScope: rowA.authorized_environments,
    enabled: rowA.enabled,
  });
  return { parentGrantA, grantAId: rowA.grant_id, grantBId: rowB.grant_id };
}

async function countObjectivesForProject(
  db: Stack["db"],
  projectId: string,
): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM objectives WHERE project_id = $1`,
    [projectId],
  );
  return Number(rows.rows[0]?.c ?? 0);
}

async function countProgramsForProject(
  stack: Stack,
  projectId: string,
): Promise<number> {
  return (await stack.programs.listByProject(projectId)).length;
}

async function countExperimentsForProject(
  stack: Stack,
  projectId: string,
): Promise<number> {
  const all = await stack.experiments.listByStates([...EXPERIMENT_STATES]);
  return all.filter((e) => e.projectId === projectId).length;
}

describe("Phase 20 institutional governance (postgres)", () => {
  it("runs primary governance ladder with persistence, proof non-action, revoke, and hold", async () => {
    const env = await createTestStack(uniquePostgresTestId("p20-ladder"));
    const projectId = uniquePostgresTestId("proj_p20");
    try {
      await seedGovernanceAuthority(env.db, projectId);
      const { parentGrantA, grantAId, grantBId } = await seedAllocatorAuthority(
        env.db,
        projectId,
      );
      const service = env.stack.governanceService;
      const anchorMs = Date.parse(env.stack.clock.nowIso());
      const authorizationAt = new Date(anchorMs).toISOString();

      const institution = await service.createInstitution({
        name: `Institution ${projectId}`,
        projectIds: [projectId],
      });
      expect(institution.status).toBe("ACTIVE");

      const mandateEffectiveFrom = new Date(anchorMs - 3600_000).toISOString(); // anchor - 60m
      const mandateEffectiveUntil = new Date(
        anchorMs + 3600_000 * 24 * 90,
      ).toISOString(); // anchor + 90d

      const draft = await service.createMandate({
        institutionId: institution.institutionId,
        createdBy: GOV_ADMIN,
        subjectClasses: ["PORTFOLIO_PLAN"],
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        projectScope: [projectId],
        environmentScope: [EXAMPLE_ENVIRONMENT],
        effectiveFrom: mandateEffectiveFrom,
        effectiveUntil: mandateEffectiveUntil,
        quorumRequirement: {
          kind: "K_OF_N",
          k: 2,
          n: 3,
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: false,
        },
      });
      const mandate = await service.activateMandate({
        mandateId: draft.mandateId,
        actorPrincipalId: GOV_ADMIN,
      });
      expect(mandate.status).toBe("ACTIVE");

      expect(parentGrantA).toBeDefined();

      const delegationEffectiveFrom = parentGrantA.effectiveFrom
        ? parentGrantA.effectiveFrom
        : new Date(anchorMs - 60_000).toISOString(); // anchor - 1m
      const delegationEffectiveUntil = parentGrantA.effectiveUntil
        ? parentGrantA.effectiveUntil
        : new Date(anchorMs + 3600_000 * 24 * 30).toISOString(); // anchor + 30d
      const caseExpiresAt = new Date(
        anchorMs + 3600_000 * 24 * 20,
      ).toISOString(); // anchor + 20d

      // Explicit positive-path fixture containment assertions:
      // mandate.start < delegation.start <= authorizationAt < case expiry < delegation.end <= mandate.end
      expect(Date.parse(mandate.effectiveFrom)).toBeLessThan(
        Date.parse(delegationEffectiveFrom),
      );
      expect(Date.parse(delegationEffectiveFrom)).toBeLessThanOrEqual(
        Date.parse(authorizationAt),
      );
      expect(Date.parse(authorizationAt)).toBeLessThan(Date.parse(caseExpiresAt));
      expect(Date.parse(caseExpiresAt)).toBeLessThan(
        Date.parse(delegationEffectiveUntil),
      );
      if (mandate.effectiveUntil) {
        expect(Date.parse(delegationEffectiveUntil)).toBeLessThanOrEqual(
          Date.parse(mandate.effectiveUntil),
        );
      }

      if (parentGrantA.effectiveFrom) {
        expect(Date.parse(delegationEffectiveFrom)).toBeGreaterThanOrEqual(
          Date.parse(parentGrantA.effectiveFrom),
        );
      }
      if (parentGrantA.effectiveUntil) {
        expect(Date.parse(delegationEffectiveUntil)).toBeLessThanOrEqual(
          Date.parse(parentGrantA.effectiveUntil),
        );
      }

      const delegation = await service.createDelegation({
        delegatorPrincipalId: ALLOC_A,
        delegatePrincipalId: DELEGATE,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [projectId],
        environmentScope: [EXAMPLE_ENVIRONMENT],
        effectiveFrom: delegationEffectiveFrom,
        effectiveUntil: delegationEffectiveUntil,
        reason: "Attenuated handoff for phase20",
      });
      expect(delegation.status).toBe("ACTIVE");
      expect(delegation.projectScope).toEqual([projectId]);

      const delegated = await service.resolveAuthority({
        principalId: DELEGATE,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: authorizationAt,
      });
      expect(delegated.outcome).toBe("AUTHORIZED");

      const subjectId = `subj_${projectId}`;
      const subjectHash = `hash_${projectId}`;
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId,
        subjectHash,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [projectId],
        environmentScope: [EXAMPLE_ENVIRONMENT],
        mandateIds: [mandate.mandateId],
        expiresAt: caseExpiresAt,
      });
      expect(governanceCase.status).toBe("OPEN");

      const first = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: ALLOC_A,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: `nonce-a-${projectId}`,
      });
      expect(first.quorumOutcome).toBe("PENDING");
      expect(first.proof).toBeUndefined();

      const objectivesBefore = await countObjectivesForProject(env.db, projectId);
      const programsBefore = await countProgramsForProject(env.stack, projectId);
      const experimentsBefore = await countExperimentsForProject(
        env.stack,
        projectId,
      );

      const second = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: ALLOC_B,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: `nonce-b-${projectId}`,
      });
      expect(second.quorumOutcome).toBe("SATISFIED");
      expect(second.proof).toBeDefined();
      expect(second.proof!.status).toBe("ACTIVE");
      expect(second.proof!.subjectType).toBe(governanceCase.subjectType);
      expect(second.proof!.subjectId).toBe(governanceCase.subjectId);
      expect(second.proof!.subjectVersion).toBe(governanceCase.subjectVersion);
      expect(second.proof!.subjectHash).toBe(governanceCase.subjectHash);

      // Prove exact attestation and authority snapshot provenance bound in proof
      expect(second.proof!.attestationIds).toContain(
        first.attestation.attestationId,
      );
      const snapshotA = await service.getAuthoritySnapshot(
        first.attestation.authoritySnapshotId,
      );
      expect(snapshotA).not.toBeNull();
      expect(snapshotA!.directGrantIds).toContain(grantAId);
      const preRevSnapshotAFreshness =
        await service.validateAuthoritySnapshotFreshness({
          authoritySnapshotId: first.attestation.authoritySnapshotId,
          authoritySnapshotHash: first.attestation.authoritySnapshotHash,
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          atIso: authorizationAt,
        });
      expect(preRevSnapshotAFreshness.outcome).toBe("FRESH");

      expect(await countObjectivesForProject(env.db, projectId)).toBe(
        objectivesBefore,
      );
      expect(await countProgramsForProject(env.stack, projectId)).toBe(
        programsBefore,
      );
      expect(await countExperimentsForProject(env.stack, projectId)).toBe(
        experimentsBefore,
      );

      // Explicit positive-path assertions before validateProof:
      expect(Date.parse(authorizationAt)).toBeGreaterThanOrEqual(
        Date.parse(mandate.effectiveFrom),
      );
      if (mandate.effectiveUntil) {
        expect(Date.parse(authorizationAt)).toBeLessThanOrEqual(
          Date.parse(mandate.effectiveUntil),
        );
      }
      expect(Date.parse(authorizationAt)).toBeLessThanOrEqual(
        Date.parse(governanceCase.expiresAt),
      );
      if (delegation.effectiveFrom) {
        expect(Date.parse(authorizationAt)).toBeGreaterThanOrEqual(
          Date.parse(delegation.effectiveFrom),
        );
      }
      if (delegation.effectiveUntil) {
        expect(Date.parse(authorizationAt)).toBeLessThanOrEqual(
          Date.parse(delegation.effectiveUntil),
        );
      }

      const preRevAuthorityA = await service.resolveAuthority({
        principalId: ALLOC_A,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: authorizationAt,
      });
      expect(preRevAuthorityA.outcome).toBe("AUTHORIZED");

      await service.validateProof({
        proofId: second.proof!.institutionalAuthorizationProofId,
        subjectType: "PORTFOLIO_PLAN",
        subjectId,
        subjectHash,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: authorizationAt,
      });

      const revocation = await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grantAId,
        reason: "Source grant revoked",
        principalId: GOV_ADMIN,
      });

      // Confirm revocation was durably persisted before testing fresh-proof rejection
      const revRows = await env.db.query<{
        revocation_id: string;
        target_type: string;
        target_id: string;
        revocation_hash: string;
        effective_at: Date;
      }>(
        `SELECT revocation_id, target_type, target_id, revocation_hash, effective_at
         FROM authority_revocations
         WHERE target_type = $1 AND target_id = $2`,
        ["DIRECT_GRANT", grantAId],
      );
      expect(revRows.rows.length).toBeGreaterThanOrEqual(1);
      const reloadedRev = revRows.rows.find(
        (r) => r.revocation_id === revocation.revocationId,
      );
      expect(reloadedRev).toBeDefined();
      expect(reloadedRev!.target_type).toBe("DIRECT_GRANT");
      expect(reloadedRev!.target_id).toBe(grantAId);
      expect(reloadedRev!.revocation_hash).toBe(revocation.revocationHash);

      const persistedRevocationMs = reloadedRev!.effective_at.getTime();
      const postRevocationAt = reloadedRev!.effective_at.toISOString();

      expect(persistedRevocationMs).toBe(
        Date.parse(revocation.effectiveAt),
      );
      expect(persistedRevocationMs).toBeLessThanOrEqual(
        Date.parse(postRevocationAt),
      );
      expect(persistedRevocationMs).toBeGreaterThanOrEqual(
        Date.parse(authorizationAt),
      );

      const postRevAuthorityA = await service.resolveAuthority({
        principalId: ALLOC_A,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: postRevocationAt,
      });
      expect(postRevAuthorityA.outcome).toBe("DENIED");

      // Temporal boundary: future revocation on grantB
      const futureRevEffectiveAt = new Date(
        Date.parse(postRevocationAt) + 3600_000,
      ).toISOString();
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grantBId,
        effectiveAt: futureRevEffectiveAt,
        reason: "Scheduled grant B retirement",
        principalId: GOV_ADMIN,
      });
      const resBBeforeFuture = await service.resolveAuthority({
        principalId: ALLOC_B,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: authorizationAt,
      });
      expect(resBBeforeFuture.outcome).toBe("AUTHORIZED");
      const resBAtFuture = await service.resolveAuthority({
        principalId: ALLOC_B,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: futureRevEffectiveAt,
      });
      expect(resBAtFuture.outcome).toBe("DENIED");
      const resBAfterFuture = await service.resolveAuthority({
        principalId: ALLOC_B,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
        atIso: new Date(Date.parse(futureRevEffectiveAt) + 1).toISOString(),
      });
      expect(resBAfterFuture.outcome).toBe("DENIED");

      // Prove exact snapshot A freshness is now STALE because grantAId was revoked
      const postRevSnapshotAFreshness =
        await service.validateAuthoritySnapshotFreshness({
          authoritySnapshotId: first.attestation.authoritySnapshotId,
          authoritySnapshotHash: first.attestation.authoritySnapshotHash,
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          atIso: postRevocationAt,
        });
      expect(postRevSnapshotAFreshness.outcome).toBe("STALE");

      await expect(
        service.validateProof({
          proofId: second.proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId,
          subjectHash,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          atIso: postRevocationAt,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(isGovernanceError(err)).toBe(true);
        expect((err as { code: string }).code).toBe("GOVERNANCE_PROOF_STALE");
        return true;
      });

      const hold = await service.createHold({
        createdBy: HOLD_OP,
        institutionId: institution.institutionId,
        projectScope: [projectId],
        environmentScope: [EXAMPLE_ENVIRONMENT],
        effectiveUntil: new Date(
          Date.parse(postRevocationAt) + 3600_000 * 24 * 10,
        ).toISOString(),
        reason: "Incident freeze",
        effect: "BLOCK",
      });
      const holdEffectiveAt = hold.effectiveFrom;
      const holdValidationAt = hold.effectiveFrom;

      expect(Date.parse(holdEffectiveAt)).toBeLessThanOrEqual(
        Date.parse(holdValidationAt),
      );
      expect(Date.parse(holdValidationAt)).toBeGreaterThanOrEqual(
        Date.parse(postRevocationAt),
      );

      await expect(
        service.assertNoActiveHold({
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          atIso: holdValidationAt,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expect(isGovernanceError(err)).toBe(true);
        expect((err as { code: string }).code).toBe("GOVERNANCE_HOLD_ACTIVE");
        return true;
      });

      // Restart: second stack against same DB reloads durable governance state.
      const env2 = await createTestStack(uniquePostgresTestId("p20-ladder-r"));
      try {
        const reloadedInstitution =
          await env2.stack.governanceInstitutions.getById(
            institution.institutionId,
          );
        expect(reloadedInstitution).not.toBeNull();
        expect(reloadedInstitution!.name).toBe(institution.name);

        const reloadedMandate = await env2.stack.governanceMandates.getById(
          mandate.mandateId,
        );
        expect(reloadedMandate?.status).toBe("ACTIVE");

        const reloadedProof = await env2.stack.governanceProofs.getById(
          second.proof!.institutionalAuthorizationProofId,
        );
        expect(reloadedProof).not.toBeNull();
        expect(reloadedProof!.subjectType).toBe(governanceCase.subjectType);
        expect(reloadedProof!.subjectId).toBe(governanceCase.subjectId);
        expect(reloadedProof!.subjectVersion).toBe(governanceCase.subjectVersion);
        expect(reloadedProof!.subjectHash).toBe(governanceCase.subjectHash);

        const reloadedHolds =
          await env2.stack.governanceHolds.listActiveByProject(projectId);
        expect(reloadedHolds.length).toBeGreaterThanOrEqual(1);

        // Snapshot freshness across restart boundary:
        const reloadedSnapshotAFreshness =
          await env2.stack.governanceService.validateAuthoritySnapshotFreshness({
            authoritySnapshotId: first.attestation.authoritySnapshotId,
            authoritySnapshotHash: first.attestation.authoritySnapshotHash,
            projectId,
            environment: EXAMPLE_ENVIRONMENT,
            requiredRole: "PORTFOLIO_ALLOCATOR",
            atIso: postRevocationAt,
          });
        expect(reloadedSnapshotAFreshness.outcome).toBe("STALE");

        // Negative assertion across Postgres restart boundary:
        // Proof must remain rejected on fresh stack because source grant revocation is durable
        await expect(
          env2.stack.governanceService.validateProof({
            proofId: second.proof!.institutionalAuthorizationProofId,
            subjectType: "PORTFOLIO_PLAN",
            subjectId,
            subjectHash,
            requiredRole: "PORTFOLIO_ALLOCATOR",
            projectId,
            environment: EXAMPLE_ENVIRONMENT,
            atIso: postRevocationAt,
          }),
        ).rejects.toSatisfy((err: unknown) => {
          expect(isGovernanceError(err)).toBe(true);
          expect((err as { code: string }).code).toBe("GOVERNANCE_PROOF_STALE");
          return true;
        });
      } finally {
        await env2.close();
      }
    } finally {
      await env.close();
    }
  });
});
