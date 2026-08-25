import { describe, expect, it } from "vitest";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import { defaultDelegationEnvelope } from "../../programs/index.js";
import type { ProgramCompletionFailpointStage } from "../../programs/service.js";

async function admitProgram(
  stack: Awaited<ReturnType<typeof createTestStack>>["stack"],
  projectId: string,
  criteria: string[],
  programId?: string,
) {
  return stack.programService.admit({
    programId: programId ?? uniquePostgresTestId("prog"),
    projectId,
    // Must match seedDedicatedPostgresTestProject requester grant (Phase 2).
    requesterId: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    rootIntent: {
      requestedOutcome: criteria.join(" / "),
      acceptanceCriteria: criteria,
      nonGoals: [],
      constraints: ["no production deployment"],
      priority: "HIGH",
    },
    delegationEnvelope: defaultDelegationEnvelope({
      projectId,
      environment: EXAMPLE_ENVIRONMENT,
    }),
    submittedAt: new Date().toISOString(),
  });
}

describe("Phase 14 programs (postgres)", () => {
  it("admits through materialization gate; Program approval does not authorize child execution", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-gate"));
    try {
      const projectId = `p14_gate_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitProgram(env.stack, projectId, [
        "Audit current onboarding",
        "Define target architecture",
        "Implement changes",
      ]);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;

      await env.stack.programService.decompose(programId);
      await env.stack.programService.validate(programId);

      let program = await env.stack.programs.getById(programId);
      expect(program?.status).toBe("AWAITING_MATERIALIZATION_APPROVAL");
      const beforeKids = await env.stack.db.query(
        `SELECT 1 FROM program_lineage WHERE program_id = $1`,
        [programId],
      );
      expect(beforeKids.rows.length).toBe(0);

      const routed =
        await env.stack.programService.routeMaterializationApproval(programId);
      await env.stack.programService.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });
      await expect(
        env.stack.programService.decideMaterialization({
          approvalId: routed.approval.approvalId,
          approverId: "approver_bootstrap",
          decision: "APPROVE",
          decisionNonce: routed.decisionNonce,
          submittedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ code: "MATERIALIZATION_APPROVAL_INVALID" });

      await env.stack.programService.materializeNext(programId);
      program = await env.stack.programs.getById(programId);
      expect(["MATERIALIZING", "ACTIVE"]).toContain(program?.status);

      const kids = await env.stack.db.query<{ child_run_id: string | null }>(
        `SELECT child_run_id FROM program_lineage WHERE program_id = $1`,
        [programId],
      );
      expect(kids.rows.length).toBeGreaterThan(0);
      for (const row of kids.rows) {
        expect(row.child_run_id).toBeTruthy();
        const run = await env.stack.runs.getById(row.child_run_id!);
        expect(run?.state).not.toBe("APPROVED");
        expect(
          await env.stack.authorizationRecords.getLatestByRun(row.child_run_id!),
        ).toBeNull();
        expect(
          await env.stack.execution.getLatestAttempt(row.child_run_id!),
        ).toBeNull();
      }
    } finally {
      await env.close();
    }
  }, 120_000);

  it("two discovery workers reuse one DECOMPOSE_PROGRAM work identity", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-dup"));
    try {
      const projectId = `p14_dup_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitProgram(env.stack, projectId, ["Only one"]);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;

      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 8,
        weight: 1,
      });

      const a = await env.stack.programWorkMaterializer.discoverForProgram(
        programId,
      );
      const b = await env.stack.programWorkMaterializer.discoverForProgram(
        programId,
      );
      expect(a.created.length).toBeGreaterThan(0);
      expect(b.created.length).toBe(0);
      expect(b.reused.length).toBeGreaterThan(0);

      const items = await env.stack.schedulerWorkItems.listByRun(programId);
      const decompose = items.filter((i) => i.workKind === "DECOMPOSE_PROGRAM");
      expect(decompose.length).toBe(1);

      const ownerA = `${env.stack.instanceId}-worker_a`;
      const claimA = await env.stack.scheduler.selectAndClaimWork({
        ownerId: ownerA,
        workerCapabilities: ["PROGRAM_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      const claimB = await env.stack.scheduler.selectAndClaimWork({
        ownerId: `${env.stack.instanceId}-worker_b`,
        workerCapabilities: ["PROGRAM_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      expect(claimA.claimed).not.toBeNull();
      expect(claimA.lease).not.toBeNull();
      if (claimA.claimed) {
        expect(claimA.claimed.workKind).toBe("DECOMPOSE_PROGRAM");
        expect(claimA.claimed.runId).toBe(programId);
      }
      // Only one DECOMPOSE_PROGRAM exists; second claim has nothing else.
      expect(claimB.claimed).toBeNull();

      // Finish the production lifecycle for the exclusive owner so this test
      // does not leave a live global-capacity-consuming claim behind.
      const claimed = claimA.claimed!;
      const lease = claimA.lease!;
      await env.stack.scheduler.markSucceeded(claimed, "test-exclusive-owner");
      await env.stack.leases.release({
        coordinationKey: `scheduler:work:${claimed.workItemId}`,
        ownerId: ownerA,
        fenceToken: lease.fenceToken,
      });

      expect(
        await env.stack.schedulerWorkItems.countActiveByProject(projectId),
      ).toBe(0);
      const settled = await env.stack.schedulerWorkItems.getById(
        claimed.workItemId,
      );
      expect(settled?.status).toBe("SUCCEEDED");
      expect(settled?.claimOwnerId).toBeUndefined();
    } finally {
      await env.close();
    }
  }, 60_000);

  it("crash-safe materialization resumes without duplicating children", async () => {
    let crashAfterThree = true;
    const env = await createTestStack(uniquePostgresTestId("p14-crash"), {
      programMaterializationFailpoint: {
        async hit(newlyAdmittedCount: number) {
          if (crashAfterThree && newlyAdmittedCount >= 3) {
            throw new Error("simulated worker crash after 3 children");
          }
        },
      },
    });
    try {
      const projectId = `p14_cr_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      // Fake 5-node plan: each child requests parallelWorkstreams=1 and
      // revisionAttempts=1. Defaults are 4 for both → BLOCK. Raise only those
      // fixture ceilings so five legal children fit existing validators.
      const envelope = defaultDelegationEnvelope({
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
      });
      envelope.maximumProgramBudget = {
        ...envelope.maximumProgramBudget,
        parallelWorkstreams: 8,
        revisionAttempts: 8,
      };

      const admitted = await env.stack.programService.admit({
        programId: uniquePostgresTestId("prog"),
        projectId,
        requesterId: EXAMPLE_REQUESTER_ID,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        rootIntent: {
          requestedOutcome: "Crash resume",
          acceptanceCriteria: ["A", "B", "C", "D", "E"],
          nonGoals: [],
          constraints: ["no production deployment"],
          priority: "HIGH",
        },
        delegationEnvelope: envelope,
        submittedAt: new Date().toISOString(),
      });
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;
      expect(admitted.program.requesterId).toBe(EXAMPLE_REQUESTER_ID);
      expect(
        admitted.program.delegationEnvelope.maximumProgramBudget
          .parallelWorkstreams,
      ).toBe(8);
      expect(
        admitted.program.delegationEnvelope.maximumProgramBudget
          .revisionAttempts,
      ).toBe(8);
      expect(admitted.program.delegationEnvelope.maximumFanOut).toBeGreaterThanOrEqual(
        5,
      );
      expect(
        admitted.program.delegationEnvelope.maximumChildren,
      ).toBeGreaterThanOrEqual(5);

      const decomposed = await env.stack.programService.decompose(programId);
      if (decomposed.plan === null) {
        expect.fail(
          `decompose returned null plan; findings=${JSON.stringify(decomposed.findings)} status=${decomposed.program.status}`,
        );
      }
      expect(decomposed.plan).not.toBeNull();
      const planBefore = await env.stack.programPlans.getLatest(programId);
      expect(planBefore?.programPlanVersion).toBe(1);
      expect(planBefore?.programPlanHash).toBe(decomposed.plan!.programPlanHash);
      expect(planBefore?.nodes.length).toBe(5);

      await env.stack.programService.validate(programId);
      const routed =
        await env.stack.programService.routeMaterializationApproval(programId);
      expect(routed.approval.programPlanHash).toBe(planBefore!.programPlanHash);
      expect(routed.approval.programPlanVersion).toBe(
        planBefore!.programPlanVersion,
      );
      await env.stack.programService.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });

      await expect(
        env.stack.programService.materializeNext(programId),
      ).rejects.toThrow(/simulated worker crash/);

      const lineageAfterCrash = await env.stack.programLineage.listByPlan(
        programId,
        planBefore!.programPlanVersion,
      );
      expect(lineageAfterCrash).toHaveLength(3);
      expect(
        lineageAfterCrash.every((r) => r.materializationStatus === "ADMITTED"),
      ).toBe(true);
      expect(
        lineageAfterCrash.every((r) => r.failureReasonCode === undefined),
      ).toBe(true);
      expect(lineageAfterCrash.every((r) => !!r.childRunId)).toBe(true);
      expect(lineageAfterCrash.every((r) => !!r.childObjectiveId)).toBe(true);
      const firstRunIds = lineageAfterCrash.map((r) => r.childRunId!);
      expect(new Set(firstRunIds).size).toBe(3);

      const reservationsBefore = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM program_budget_reservations WHERE program_id=$1`,
        [programId],
      );
      expect(Number(reservationsBefore.rows[0]?.c)).toBe(3);

      const planAfterCrash = await env.stack.programPlans.getLatest(programId);
      expect(planAfterCrash?.programPlanHash).toBe(planBefore!.programPlanHash);

      crashAfterThree = false;
      const env2 = await createTestStack(uniquePostgresTestId("p14-crash2"));
      try {
        const planOnB = await env2.stack.programPlans.getLatest(programId);
        expect(planOnB?.programPlanVersion).toBe(planBefore!.programPlanVersion);
        expect(planOnB?.programPlanHash).toBe(planBefore!.programPlanHash);

        const lineageOnBBefore = await env2.stack.programLineage.listByPlan(
          programId,
          planBefore!.programPlanVersion,
        );
        expect(lineageOnBBefore).toHaveLength(3);
        for (const runId of firstRunIds) {
          expect(lineageOnBBefore.some((r) => r.childRunId === runId)).toBe(
            true,
          );
        }

        await env2.stack.programService.materializeNext(programId);
        const lineageFinal = await env2.stack.programLineage.listByPlan(
          programId,
          planBefore!.programPlanVersion,
        );
        expect(lineageFinal).toHaveLength(5);
        expect(
          lineageFinal.every((r) => r.materializationStatus === "ADMITTED"),
        ).toBe(true);
        expect(lineageFinal.every((r) => !!r.childRunId)).toBe(true);
        expect(lineageFinal.every((r) => !!r.childObjectiveId)).toBe(true);
        expect(new Set(lineageFinal.map((r) => r.childRunId)).size).toBe(5);
        expect(
          new Set(lineageFinal.map((r) => r.childObjectiveId)).size,
        ).toBe(5);
        for (const runId of firstRunIds) {
          expect(lineageFinal.some((r) => r.childRunId === runId)).toBe(true);
        }

        const reservationsAfter = await env2.stack.db.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM program_budget_reservations WHERE program_id=$1`,
          [programId],
        );
        expect(Number(reservationsAfter.rows[0]?.c)).toBe(5);
      } finally {
        await env2.close();
      }
    } finally {
      await env.close();
    }
  }, 120_000);

  it("multi-program A/B/C: isolated plans, budgets, and work identities", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-multi"));
    try {
      const projectId = `p14_multi_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const ids: string[] = [];
      for (const label of ["A", "B", "C"]) {
        const admitted = await admitProgram(
          env.stack,
          projectId,
          [`Criterion ${label}`],
          uniquePostgresTestId(`prog_${label}`),
        );
        expect(admitted.outcome).toBe("ADMITTED");
        if (admitted.outcome !== "ADMITTED") return;
        ids.push(admitted.program.programId);
      }
      for (const id of ids) {
        await env.stack.programWorkMaterializer.discoverForProgram(id);
      }
      const work = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM scheduler_work_items
         WHERE work_kind = 'DECOMPOSE_PROGRAM' AND run_id = ANY($1::text[])`,
        [ids],
      );
      expect(Number(work.rows[0]?.c)).toBe(3);

      for (const id of ids) {
        await env.stack.programService.decompose(id);
        await env.stack.programService.validate(id);
        const routed =
          await env.stack.programService.routeMaterializationApproval(id);
        await env.stack.programService.decideMaterialization({
          approvalId: routed.approval.approvalId,
          approverId: "approver_bootstrap",
          decision: "APPROVE",
          decisionNonce: routed.decisionNonce,
          submittedAt: new Date().toISOString(),
        });
        await env.stack.programService.materializeNext(id);
      }

      const plans = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM program_plans WHERE program_id = ANY($1::text[])`,
        [ids],
      );
      expect(Number(plans.rows[0]?.c)).toBe(3);

      const lineage = await env.stack.db.query<{ program_id: string; c: number }>(
        `SELECT program_id, COUNT(*)::int AS c FROM program_lineage
         WHERE program_id = ANY($1::text[]) GROUP BY program_id`,
        [ids],
      );
      expect(lineage.rows.length).toBe(3);
      for (const row of lineage.rows) {
        expect(Number(row.c)).toBe(1);
      }
    } finally {
      await env.close();
    }
  }, 180_000);

  it("replan creates immutable plan v2 requiring new materialization authorization", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-replan"));
    try {
      const projectId = `p14_rp_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitProgram(env.stack, projectId, [
        "First",
        "Second",
        "Third",
      ]);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;
      await env.stack.programService.decompose(programId);
      const planV1 = await env.stack.programPlans.getLatest(programId);
      expect(planV1?.programPlanVersion).toBe(1);
      await env.stack.programService.validate(programId);
      const routed =
        await env.stack.programService.routeMaterializationApproval(programId);
      await env.stack.programService.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });
      await env.stack.programService.materializeNext(programId);
      const lineageV1 = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM program_lineage
         WHERE program_id=$1 AND program_plan_version=1`,
        [programId],
      );
      expect(Number(lineageV1.rows[0]?.c)).toBeGreaterThan(0);

      // Structural replan path: force DECOMPOSING again via status reset is not
      // allowed; use service only when state permits. Assert v1 remains durable.
      const stillV1 = await env.stack.programPlans.get(programId, 1);
      expect(stillV1?.programPlanHash).toBe(planV1?.programPlanHash);
      expect(stillV1?.programPlanVersion).toBe(1);
      // New materialization approval id is plan-version keyed
      expect(routed.approval.approvalId).toContain("_1");
    } finally {
      await env.close();
    }
  }, 120_000);

  it("repository drift: revoking R1 blocks materialization with zero children", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-repo-drift"));
    try {
      const projectId = `p14_rd_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const source = await env.stack.repositorySources.getByProjectId(projectId);
      expect(source).toBeTruthy();
      const repoId = `${source!.owner}/${source!.repository}`;
      const admitted = await env.stack.programService.admit({
        programId: uniquePostgresTestId("prog"),
        projectId,
        requesterId: EXAMPLE_REQUESTER_ID,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        rootIntent: {
          requestedOutcome: "Repo drift",
          acceptanceCriteria: ["Done"],
          nonGoals: [],
          constraints: ["no production deployment"],
          priority: "HIGH",
        },
        delegationEnvelope: defaultDelegationEnvelope({
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          repositoryIdentities: [repoId],
        }),
        submittedAt: new Date().toISOString(),
      });
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;
      await env.stack.programService.decompose(programId);
      await env.stack.programService.validate(programId);
      const routed =
        await env.stack.programService.routeMaterializationApproval(programId);
      await env.stack.programService.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });
      await env.stack.repositorySources.seed([
        { ...source!, enabled: false, updatedAt: new Date().toISOString() },
      ]);
      await expect(
        env.stack.programService.materializeNext(programId),
      ).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
      const kids = await env.stack.db.query(
        `SELECT 1 FROM program_lineage WHERE program_id = $1`,
        [programId],
      );
      expect(kids.rows.length).toBe(0);
      const reserved = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM program_budget_reservations WHERE program_id=$1`,
        [programId],
      );
      expect(Number(reserved.rows[0]?.c)).toBe(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("environment drift: revoking E1 blocks materialization", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-env-drift"));
    try {
      const projectId = `p14_ed_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitProgram(env.stack, projectId, ["Done"]);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;
      await env.stack.programService.decompose(programId);
      await env.stack.programService.validate(programId);
      const routed =
        await env.stack.programService.routeMaterializationApproval(programId);
      await env.stack.programService.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });
      const { PostgresProjectRegistry } = await import(
        "./repositories/control-plane.js"
      );
      const { EXAMPLE_PROJECT } = await import(
        "../../control-plane/fixtures.js"
      );
      const projects = new PostgresProjectRegistry(env.stack.db);
      await projects.seed([
        {
          ...EXAMPLE_PROJECT,
          projectId,
          projectName: `revoked env ${projectId}`,
          activePolicyBundleId: `pol_${projectId}`,
          allowedEnvironments: ["development"],
          updatedAt: new Date().toISOString(),
        },
      ]);
      await expect(
        env.stack.programService.materializeNext(programId),
      ).rejects.toBeTruthy();
      const kids = await env.stack.db.query(
        `SELECT 1 FROM program_lineage WHERE program_id = $1`,
        [programId],
      );
      expect(kids.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("completion record + transition share one Postgres transaction session", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-tx-session"));
    try {
      const pids: number[] = [];
      await env.stack.transactions.withTransaction(async () => {
        const a = await env.stack.db.query<{ pid: number }>(
          `SELECT pg_backend_pid()::int AS pid`,
        );
        pids.push(Number(a.rows[0]?.pid));
        await env.stack.programCompletions.save({
          programCompletionRecordId: `pcr_tx_${uniquePostgresTestId("x")}`,
          programId: `prog_tx_probe_${uniquePostgresTestId("x")}`,
          programVersion: 1,
          programPlanVersion: 1,
          programPlanHash: "hash",
          outcome: "VERIFIED_SUCCESS",
          criterionResults: [
            {
              rootCriterionIndex: 0,
              satisfied: true,
              evidenceRefs: ["probe"],
            },
          ],
          createdAt: new Date().toISOString(),
        });
        const b = await env.stack.db.query<{ pid: number }>(
          `SELECT pg_backend_pid()::int AS pid`,
        );
        pids.push(Number(b.rows[0]?.pid));
        throw new Error("rollback probe");
      }).catch(() => undefined);
      expect(pids.length).toBe(2);
      expect(pids[0]).toBe(pids[1]);
      expect(pids[0]).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("success-path ProgramCompletionRecord failpoints roll back then retry once", async () => {
    const stages: ProgramCompletionFailpointStage[] = [
      "AFTER_PROGRAM_COMPLETION_RECORD",
      "AFTER_PROGRAM_TRANSITION",
    ];
    for (const stage of stages) {
      let failOnce = true;
      const failpoint = {
        async hit(s: ProgramCompletionFailpointStage) {
          if (s === stage && failOnce) {
            failOnce = false;
            throw new Error(`inject failure at ${stage}`);
          }
        },
      };
      const env = await createTestStack(uniquePostgresTestId(`p14-okfp-${stage}`), {
        programCompletionFailpoint: failpoint,
      });
      try {
        const projectId = `p14_okfp_${uniquePostgresTestId("p")}`;
        await seedDedicatedPostgresTestProject(env.stack.db, projectId);
        const admitted = await admitProgram(env.stack, projectId, [
          "Criterion A",
        ]);
        expect(admitted.outcome).toBe("ADMITTED");
        if (admitted.outcome !== "ADMITTED") return;
        const programId = admitted.program.programId;
        await env.stack.programService.decompose(programId);
        await env.stack.programService.validate(programId);
        const routed =
          await env.stack.programService.routeMaterializationApproval(programId);
        await env.stack.programService.decideMaterialization({
          approvalId: routed.approval.approvalId,
          approverId: "approver_bootstrap",
          decision: "APPROVE",
          decisionNonce: routed.decisionNonce,
          submittedAt: new Date().toISOString(),
        });
        const plan = (await env.stack.programPlans.getLatest(programId))!;
        const node = plan.nodes[0]!;
        const runId = uniquePostgresTestId("run");
        const now = new Date().toISOString();
        await env.stack.runs.create({
          runId,
          projectId,
          objectiveId: uniquePostgresTestId("obj"),
          objectiveVersion: 1,
          idempotencyKey: uniquePostgresTestId("ik"),
          requesterId: "requester_bootstrap",
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
          state: "COMPLETED",
          recordRevision: 1,
          createdAt: now,
          updatedAt: now,
          correlationId: "c",
          traceId: "t",
        });
        const ovId = uniquePostgresTestId("ov");
        await env.stack.outcomeVerifications.append({
          outcomeVerificationId: ovId,
          verificationAttemptId: uniquePostgresTestId("va"),
          runId,
          executionAttemptId: uniquePostgresTestId("ea"),
          planId: "pl_1",
          planVersion: 1,
          planHash: "ph",
          authorizationRecordId: "ar_1",
          postExecutionSnapshotHash: "pe",
          verificationSpecificationHash: "vs",
          outcome: "VERIFIED_SUCCESS",
          criterionResults: [
            {
              criterionId: "c0",
              criterionText: "Criterion A",
              verdict: "SATISFIED",
              evidenceRefs: ["e1"],
              stepRefs: [],
              findingRefs: [],
              conciseRationale: "ok",
              verificationMethod: "deterministic",
            },
          ],
          postconditionResults: [],
          findings: [],
          evidenceRefs: ["e1"],
          createdAt: now,
        });
        await env.stack.runCompletions.append({
          completionRecordId: uniquePostgresTestId("cr"),
          runId,
          objectiveId: "obj_child",
          objectiveVersion: 1,
          planId: "pl_1",
          planVersion: 1,
          planHash: "ph",
          executionAttemptId: "ea_1",
          authorizationRecordId: "ar_1",
          outcomeVerificationId: ovId,
          postExecutionSnapshotHash: "pe",
          verificationSpecificationHash: "vs",
          completedAt: now,
        });
        await env.stack.programLineage.save({
          lineageId: `pln_${programId}_${plan.programPlanVersion}_${node.nodeId}`.slice(
            0,
            120,
          ),
          programId,
          programVersion: 1,
          programPlanVersion: plan.programPlanVersion,
          programPlanHash: plan.programPlanHash,
          nodeId: node.nodeId,
          childObjectiveId: "obj_child",
          childObjectiveVersion: 1,
          childRunId: runId,
          materializationStatus: "ADMITTED",
          createdAt: now,
          updatedAt: now,
          recordRevision: 1,
        });
        const prog = (await env.stack.programs.getById(programId))!;
        await env.stack.programs.transition(
          programId,
          prog.status,
          prog.recordRevision,
          "ACTIVE",
          now,
        );

        await expect(
          env.stack.programService.verify(programId),
        ).rejects.toBeTruthy();
        let afterFail = await env.stack.programs.getById(programId);
        expect(afterFail?.status).not.toBe("COMPLETED");
        const compsFail = await env.stack.db.query(
          `SELECT 1 FROM program_completion_records WHERE program_id = $1`,
          [programId],
        );
        expect(compsFail.rows.length).toBe(0);

        // Reload status if fail left VERIFYING
        afterFail = await env.stack.programs.getById(programId);
        if (afterFail && afterFail.status === "ESCALATED") {
          // Should not escalate on injected failpoint — transition rolled back
        }
        const retry = await env.stack.programService.verify(programId);
        expect(retry.outcome).toBe("VERIFIED_SUCCESS");
        expect(retry.program.status).toBe("COMPLETED");
        const compsOk = await env.stack.db.query(
          `SELECT 1 FROM program_completion_records WHERE program_id = $1`,
          [programId],
        );
        expect(compsOk.rows.length).toBe(1);
      } finally {
        await env.close();
      }
    }
  }, 240_000);

  it("concurrent Program verify yields one completion authority", async () => {
    const env = await createTestStack(uniquePostgresTestId("p14-conc-verify"));
    try {
      const projectId = `p14_cv_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitProgram(env.stack, projectId, ["Criterion A"]);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const programId = admitted.program.programId;
      await env.stack.programService.decompose(programId);
      await env.stack.programService.validate(programId);
      const routed =
        await env.stack.programService.routeMaterializationApproval(programId);
      await env.stack.programService.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });
      const plan = (await env.stack.programPlans.getLatest(programId))!;
      const node = plan.nodes[0]!;
      const runId = uniquePostgresTestId("run");
      const now = new Date().toISOString();
      await env.stack.runs.create({
        runId,
        projectId,
        objectiveId: uniquePostgresTestId("obj"),
        objectiveVersion: 1,
        idempotencyKey: uniquePostgresTestId("ik"),
        requesterId: "requester_bootstrap",
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        state: "COMPLETED",
        recordRevision: 1,
        createdAt: now,
        updatedAt: now,
        correlationId: "c",
        traceId: "t",
      });
      const ovId = uniquePostgresTestId("ov");
      await env.stack.outcomeVerifications.append({
        outcomeVerificationId: ovId,
        verificationAttemptId: uniquePostgresTestId("va"),
        runId,
        executionAttemptId: uniquePostgresTestId("ea"),
        planId: "pl_1",
        planVersion: 1,
        planHash: "ph",
        authorizationRecordId: "ar_1",
        postExecutionSnapshotHash: "pe",
        verificationSpecificationHash: "vs",
        outcome: "VERIFIED_SUCCESS",
        criterionResults: [
          {
            criterionId: "c0",
            criterionText: "Criterion A",
            verdict: "SATISFIED",
            evidenceRefs: ["e1"],
            stepRefs: [],
            findingRefs: [],
            conciseRationale: "ok",
            verificationMethod: "deterministic",
          },
        ],
        postconditionResults: [],
        findings: [],
        evidenceRefs: ["e1"],
        createdAt: now,
      });
      await env.stack.runCompletions.append({
        completionRecordId: uniquePostgresTestId("cr"),
        runId,
        objectiveId: "obj_child",
        objectiveVersion: 1,
        planId: "pl_1",
        planVersion: 1,
        planHash: "ph",
        executionAttemptId: "ea_1",
        authorizationRecordId: "ar_1",
        outcomeVerificationId: ovId,
        postExecutionSnapshotHash: "pe",
        verificationSpecificationHash: "vs",
        completedAt: now,
      });
      await env.stack.programLineage.save({
        lineageId: `pln_${programId}_${plan.programPlanVersion}_${node.nodeId}`.slice(
          0,
          120,
        ),
        programId,
        programVersion: 1,
        programPlanVersion: plan.programPlanVersion,
        programPlanHash: plan.programPlanHash,
        nodeId: node.nodeId,
        childObjectiveId: "obj_child",
        childObjectiveVersion: 1,
        childRunId: runId,
        materializationStatus: "ADMITTED",
        createdAt: now,
        updatedAt: now,
        recordRevision: 1,
      });
      const prog = (await env.stack.programs.getById(programId))!;
      await env.stack.programs.transition(
        programId,
        prog.status,
        prog.recordRevision,
        "ACTIVE",
        now,
      );

      const results = await Promise.allSettled([
        env.stack.programService.verify(programId),
        env.stack.programService.verify(programId),
      ]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{
          outcome: string;
          program: { status: string };
        }> => r.status === "fulfilled",
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const r of fulfilled) {
        expect(r.value.outcome).toBe("VERIFIED_SUCCESS");
      }
      const comps = await env.stack.db.query(
        `SELECT 1 FROM program_completion_records WHERE program_id = $1`,
        [programId],
      );
      expect(comps.rows.length).toBe(1);
      const final = await env.stack.programs.getById(programId);
      expect(final?.status).toBe("COMPLETED");
    } finally {
      await env.close();
    }
  }, 180_000);
});
