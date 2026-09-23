/**
 * PostgreSQL operator control-plane provision/inspect tests.
 * Accumulated-DB safe — unique project ids per run; no truncate/drop.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withRevocationHash, mintRevocationId } from "../../governance/revocation-hold.js";
import { PostgresAuthorityRevocationRepository } from "./repositories/governance.js";
import { ControlPlaneOpsService } from "./control-plane-ops.js";
import {
  createTestDatabase,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { parseControlPlaneProvisionManifest } from "../../control-plane/provisioning/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PILOT_TEMPLATE = JSON.parse(
  readFileSync(
    join(
      HERE,
      "../../../manifests/control-plane/continuum-revenue-recovery-pilot.json",
    ),
    "utf8",
  ),
) as Record<string, unknown>;

function pilotManifestFor(projectId: string) {
  const policyBundleId = `pol_${projectId}_v1`;
  const budgetProfileId = `budget_${projectId}`;
  const capabilityId = `SEND_RECOVERY_EMAIL_${projectId}`;
  const base = structuredClone(PILOT_TEMPLATE) as {
    project: Record<string, unknown>;
    policyBundle: Record<string, unknown>;
    budgetProfile: Record<string, unknown>;
    capabilities: Record<string, unknown>[];
    requesterGrants: Record<string, unknown>[];
    approverGrants: Record<string, unknown>[];
  };
  base.project.projectId = projectId;
  base.project.projectName = `Pilot ${projectId}`;
  base.project.activePolicyBundleId = policyBundleId;
  base.project.resourceBudgetProfileId = budgetProfileId;
  base.project.workspaceRoot = `/workspace/${projectId}`;
  base.policyBundle.policyBundleId = policyBundleId;
  base.policyBundle.applicableProjectIds = [projectId];
  base.budgetProfile.budgetProfileId = budgetProfileId;
  base.capabilities[0]!.capabilityId = capabilityId;
  base.requesterGrants[0]!.projectId = projectId;
  base.approverGrants[0]!.projectId = projectId;
  return parseControlPlaneProvisionManifest(base);
}

describe("postgres control-plane operator provisioning", () => {
  it("inspect is read-only; dry-run mutates nothing; apply is idempotent and fail-closed", async () => {
    const projectId = uniquePostgresTestId("cp_ops");
    const db = await createTestDatabase(uniquePostgresTestId("cp_ops_db"));
    const ops = new ControlPlaneOpsService(db);
    const manifest = pilotManifestFor(projectId);

    const before = await ops.inspect(projectId);
    expect(before.projectMissing).toBe(true);
    expect(before.activePolicyBundleMissing).toBe(true);
    expect(before.resourceBudgetProfileMissing).toBe(true);
    expect(before.requesterGrants).toEqual([]);
    expect(before.approverGrants).toEqual([]);

    const dry = await ops.provision({ manifest, mode: "dry-run" });
    expect(dry.applied).toBe(false);
    expect(dry.conflicts).toEqual([]);
    expect(dry.plan.some((p) => p.outcome === "CREATE")).toBe(true);
    const afterDry = await ops.inspect(projectId);
    expect(afterDry.projectMissing).toBe(true);

    const first = await ops.provision({
      manifest,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(first.applied).toBe(true);
    expect(first.conflicts).toEqual([]);
    expect(first.provisioningOperationId).toMatch(/^cpprov_/);
    expect(first.operatorId).toBe("operator_railway_pilot");
    expect(first.verified?.projectMissing).toBe(false);
    expect(first.verified?.activePolicyBundleMissing).toBe(false);
    expect(first.verified?.resourceBudgetProfileMissing).toBe(false);
    expect(first.verified?.requesterGrants).toHaveLength(1);
    expect(first.verified?.approverGrants).toHaveLength(1);
    expect(
      (first.verified?.project as { executionMode: string }).executionMode,
    ).toBe("SUPERVISED");
    expect(first.plan.some((p) => p.outcome === "CREATE")).toBe(true);

    const auditsAfterFirst = await ops.listProvisioningAudits(projectId);
    expect(auditsAfterFirst).toHaveLength(1);
    expect(auditsAfterFirst[0]?.outcome).toBe("SUCCEEDED");
    expect(auditsAfterFirst[0]?.operatorId).toBe("operator_railway_pilot");

    const grantsAfterFirst = first.verified!.requesterGrants.length;
    const replay = await ops.provision({
      manifest,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(replay.applied).toBe(true);
    expect(replay.conflicts).toEqual([]);
    expect(replay.plan.every((p) => p.outcome === "UNCHANGED")).toBe(true);
    expect(replay.verified?.requesterGrants).toHaveLength(grantsAfterFirst);
    // Replay writes a second SUCCEEDED audit (operation provenance), not a
    // duplicate control-plane identity.
    const auditsAfterReplay = await ops.listProvisioningAudits(projectId);
    expect(auditsAfterReplay).toHaveLength(2);
    expect(auditsAfterReplay[0]!.provisioningOperationId).not.toBe(
      auditsAfterReplay[1]!.provisioningOperationId,
    );

    const approvals = await db.query(
      `SELECT 1 FROM json_documents
       WHERE collection = 'approval_requests' AND project_id = $1
       LIMIT 1`,
      [projectId],
    );
    expect(approvals.rows).toHaveLength(0);
    const authRecords = await db.query(
      `SELECT 1 FROM json_documents
       WHERE collection = 'authorization_records' AND project_id = $1
       LIMIT 1`,
      [projectId],
    );
    expect(authRecords.rows).toHaveLength(0);
    const attempts = await db.query(
      `SELECT 1 FROM json_documents
       WHERE collection = 'execution_attempts' AND project_id = $1
       LIMIT 1`,
      [projectId],
    );
    expect(attempts.rows).toHaveLength(0);

    await db.close();
  }, 120_000);

  it("conflicting project/policy/budget fail closed with zero partial writes", async () => {
    const projectId = uniquePostgresTestId("cp_conflict");
    const db = await createTestDatabase(uniquePostgresTestId("cp_conflict_db"));
    const ops = new ControlPlaneOpsService(db);
    const manifest = pilotManifestFor(projectId);
    await ops.provision({
      manifest,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });

    const conflictProject = structuredClone(manifest);
    conflictProject.project.projectName = "Different Name";
    const projectConflict = await ops.provision({
      manifest: conflictProject,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(projectConflict.applied).toBe(false);
    expect(
      projectConflict.conflicts.some((c) => c.reasonCode === "PROJECT_CONTENT_CONFLICT"),
    ).toBe(true);

    const conflictPolicy = structuredClone(manifest);
    conflictPolicy.policyBundle.semanticVersion = "9.9.9";
    const policyConflict = await ops.provision({
      manifest: conflictPolicy,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(policyConflict.applied).toBe(false);
    expect(
      policyConflict.conflicts.some((c) => c.reasonCode === "POLICY_CONTENT_CONFLICT"),
    ).toBe(true);

    const conflictBudget = structuredClone(manifest);
    conflictBudget.budgetProfile.maximumLlmCalls = 999;
    const budgetConflict = await ops.provision({
      manifest: conflictBudget,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(budgetConflict.applied).toBe(false);
    expect(
      budgetConflict.conflicts.some((c) => c.reasonCode === "BUDGET_CONTENT_CONFLICT"),
    ).toBe(true);

    await db.close();
  }, 120_000);

  it("does not resurrect revoked grants; malformed manifest fails before mutation", async () => {
    const projectId = uniquePostgresTestId("cp_revoke");
    const db = await createTestDatabase(uniquePostgresTestId("cp_revoke_db"));
    const ops = new ControlPlaneOpsService(db);
    const manifest = pilotManifestFor(projectId);
    const applied = await ops.provision({
      manifest,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(applied.applied).toBe(true);
    const grantId = (applied.verified?.requesterGrants[0] as { grantId: string })
      .grantId;

    const now = "2026-09-22T18:00:00.000Z";
    const revocations = new PostgresAuthorityRevocationRepository(db);
    await revocations.save(
      withRevocationHash({
        revocationId: mintRevocationId({
          targetType: "DIRECT_GRANT",
          targetId: grantId,
          effectiveAt: now,
        }),
        targetType: "DIRECT_GRANT",
        targetId: grantId,
        reason: "test revoke requester",
        effectiveAt: now,
        principalId: "approver_rr_pilot",
        createdAt: now,
      }),
    );

    const resurrect = await ops.provision({
      manifest,
      mode: "apply",
      operatorId: "operator_railway_pilot",
    });
    expect(resurrect.applied).toBe(false);
    expect(
      resurrect.conflicts.some(
        (c) => c.reasonCode === "REVOKED_GRANT_BLOCKS_RESURRECTION",
      ),
    ).toBe(true);

    const after = await ops.inspect(projectId);
    expect(after.requesterGrants).toHaveLength(0);

    await expect(
      ops.provision({
        manifest: { ...manifest, unexpected: true },
        mode: "apply",
        operatorId: "operator_railway_pilot",
      }),
    ).rejects.toBeTruthy();

    await expect(
      ops.provision({
        manifest,
        mode: "apply",
      }),
    ).rejects.toMatchObject({ code: "OPERATOR_ID_REQUIRED" });

    await db.close();
  }, 120_000);
});
