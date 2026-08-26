import { describe, expect, it } from "vitest";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import {
  defaultPortfolioEnvelope,
  FakePortfolioStrategyModel,
  emptyBudgetEstimate,
  type PortfolioGoal,
} from "../../portfolio/index.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";

type Stack = Awaited<ReturnType<typeof createTestStack>>["stack"];

function strategicGoals(count: number): PortfolioGoal[] {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return Array.from({ length: count }, (_, i) => ({
    goalId: `goal_${i + 1}`,
    description: `Strategic goal ${i + 1}`,
    successCriteria: [`Criterion ${letters[i]}`],
    weight: 1 / count,
    classification: "REQUIRED" as const,
    dependencies: [] as string[],
    evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
    status: "OPEN" as const,
  }));
}

async function admitPortfolio(
  stack: Stack,
  projectId: string,
  goals: PortfolioGoal[],
  portfolioId?: string,
  envelopeOverrides?: Partial<
    ReturnType<typeof defaultPortfolioEnvelope>
  >,
) {
  return stack.portfolioService.admit({
    portfolioId: portfolioId ?? uniquePostgresTestId("pfo"),
    primaryProjectId: projectId,
    requesterId: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    intent: {
      portfolioName: "Postgres acceptance portfolio",
      strategicOutcome: goals.map((g) => g.description).join(" / "),
      strategicGoals: goals.map((g) => g.goalId),
      constraints: ["no production deployment"],
      nonGoals: [],
      priorityPrinciples: [],
      timeHorizon: "90 days",
      requestedEnvironmentScopes: [EXAMPLE_ENVIRONMENT],
      allowedProjectScopes: [
        ...(envelopeOverrides?.allowedProjectIds ?? [projectId]),
      ],
      riskToleranceProfile: "MEDIUM",
      capitalAllocationPrinciples: [],
      successCriteria: goals.map((g) => g.successCriteria[0]!),
    },
    goals,
    authorizationEnvelope: {
      ...defaultPortfolioEnvelope({
        projectId,
        environment: EXAMPLE_ENVIRONMENT,
      }),
      ...envelopeOverrides,
      allowedProjectIds:
        envelopeOverrides?.allowedProjectIds ?? [projectId],
    },
    submittedAt: new Date().toISOString(),
  });
}

/** Single-program plans need an explicit 100% concentration ceiling. */
function allowFullConcentration(): Partial<
  ReturnType<typeof defaultPortfolioEnvelope>
> {
  return { allocationConcentrationCeiling: 1 };
}

async function authorizePortfolio(stack: Stack, portfolioId: string) {
  const routed =
    await stack.portfolioService.routeAuthorization(portfolioId);
  await stack.portfolioService.decideAuthorization({
    authorizationId: routed.request.authorizationId,
    allocatorId: "approver_bootstrap",
    decision: "APPROVE",
    decisionNonce: routed.decisionNonce,
    submittedAt: new Date().toISOString(),
  });
}

async function authorizeProgramMaterialization(stack: Stack, programId: string) {
  const routed =
    await stack.programService.routeMaterializationApproval(programId);
  await stack.programService.decideMaterialization({
    approvalId: routed.approval.approvalId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    decisionNonce: routed.decisionNonce,
    submittedAt: new Date().toISOString(),
  });
}

async function injectProgramSuccessEvidence(
  stack: Stack,
  projectId: string,
  programId: string,
  criterionText: string,
) {
  const plan = (await stack.programPlans.getLatest(programId))!;
  const node = plan.nodes[0]!;
  const runId = uniquePostgresTestId("run");
  const now = new Date().toISOString();
  await stack.runs.create({
    runId,
    projectId,
    objectiveId: uniquePostgresTestId("obj"),
    objectiveVersion: 1,
    idempotencyKey: uniquePostgresTestId("ik"),
    requesterId: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    state: "COMPLETED",
    recordRevision: 1,
    createdAt: now,
    updatedAt: now,
    correlationId: "c",
    traceId: "t",
  });
  const ovId = uniquePostgresTestId("ov");
  await stack.outcomeVerifications.append({
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
        criterionText,
        verdict: "SATISFIED",
        evidenceRefs: [`ev_${criterionText}`],
        stepRefs: [],
        findingRefs: [],
        conciseRationale: "ok",
        verificationMethod: "deterministic",
      },
    ],
    postconditionResults: [],
    findings: [],
    evidenceRefs: [`ev_${criterionText}`],
    createdAt: now,
  });
  await stack.runCompletions.append({
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
  await stack.programLineage.save({
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
  const prog = (await stack.programs.getById(programId))!;
  if (prog.status !== "ACTIVE" && prog.status !== "VERIFYING") {
    await stack.programs.transition(
      programId,
      prog.status,
      prog.recordRevision,
      "ACTIVE",
      now,
    );
  }
}

describe("Phase 15 portfolios (postgres)", () => {
  it("primary ladder: admit through portfolio completion with authority gates", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-ladder"));
    try {
      const projectId = `p15_ladder_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const goals = strategicGoals(3);
      const admitted = await admitPortfolio(env.stack, projectId, goals);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;

      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      const validated =
        await env.stack.portfolioService.validate(portfolioId);
      expect(validated.portfolio.status).toBe("AWAITING_AUTHORIZATION");
      expect(validated.result.outcome).toBe("HUMAN_APPROVAL_REQUIRED");

      await authorizePortfolio(env.stack, portfolioId);
      const materialized =
        await env.stack.portfolioService.materializePrograms(portfolioId);
      expect(materialized.portfolio.status).toBe("ACTIVE");
      expect(materialized.materialized).toHaveLength(3);

      const plan = (await env.stack.portfolioPlans.getLatest(portfolioId))!;
      for (const link of materialized.materialized) {
        expect(link.materializationStatus).toBe("ADMITTED");
        const program = await env.stack.programs.getById(link.programId);
        expect(program?.status).toBe("ADMITTED");
        const approvals = await env.stack.db.query<{ status: string }>(
          `SELECT payload->>'status' AS status FROM program_materialization_approvals
           WHERE payload->>'programId' = $1`,
          [link.programId],
        );
        expect(
          approvals.rows.every((r) => r.status !== "APPROVED"),
        ).toBe(true);

        await env.stack.programService.decompose(link.programId);
        await env.stack.programService.validate(link.programId);
        await authorizeProgramMaterialization(env.stack, link.programId);
        await env.stack.programService.materializeNext(link.programId);

        const kids = await env.stack.programLineage.listByPlan(
          link.programId,
          (await env.stack.programPlans.getLatest(link.programId))!
            .programPlanVersion,
        );
        expect(kids.length).toBeGreaterThan(0);
        for (const kid of kids) {
          expect(kid.childRunId).toBeTruthy();
          const run = await env.stack.runs.getById(kid.childRunId!);
          expect(run?.state).not.toBe("APPROVED");
          expect(
            await env.stack.authorizationRecords.getLatestByRun(
              kid.childRunId!,
            ),
          ).toBeNull();
          expect(
            await env.stack.execution.getLatestAttempt(kid.childRunId!),
          ).toBeNull();
        }

        const binding = plan.goalBindings.find(
          (b) => b.programProposalId === link.proposalId,
        );
        const criterion = binding?.programCriterionId ?? goals[0]!.successCriteria[0]!;
        await injectProgramSuccessEvidence(
          env.stack,
          projectId,
          link.programId,
          criterion,
        );
        const programDone = await env.stack.programService.verify(link.programId);
        expect(programDone.outcome).toBe("VERIFIED_SUCCESS");
        expect(programDone.program.status).toBe("COMPLETED");
      }

      const portfolioDone =
        await env.stack.portfolioService.verify(portfolioId);
      expect(portfolioDone.outcome).toBe("VERIFIED_SUCCESS");
      expect(portfolioDone.portfolio.status).toBe("COMPLETED");
      expect(portfolioDone.completion).toBeTruthy();

      const portfolioCompletions = await env.stack.db.query(
        `SELECT 1 FROM portfolio_completion_records WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(portfolioCompletions.rows.length).toBe(1);

      const reservations = await env.stack.db.query<{ proposal_id: string }>(
        `SELECT proposal_id FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(reservations.rows.length).toBe(plan.programProposals.length);
      expect(
        new Set(reservations.rows.map((r) => r.proposal_id)).size,
      ).toBe(reservations.rows.length);
    } finally {
      await env.close();
    }
  }, 240_000);

  it("crash-safe portfolio materialization resumes without duplicate lineage or reservations", async () => {
    let crashAfterThree = true;
    const env = await createTestStack(uniquePostgresTestId("p15-crash"), {
      portfolioMaterializationFailpoint: {
        async hit(newlyAdmittedCount: number) {
          if (crashAfterThree && newlyAdmittedCount >= 3) {
            throw new Error("simulated portfolio worker crash after 3 programs");
          }
        },
      },
    });
    try {
      const projectId = `p15_cr_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const goals = strategicGoals(5);
      const admitted = await admitPortfolio(env.stack, projectId, goals);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;

      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      await env.stack.portfolioService.validate(portfolioId);
      await authorizePortfolio(env.stack, portfolioId);

      await expect(
        env.stack.portfolioService.materializePrograms(portfolioId),
      ).rejects.toThrow(/simulated portfolio worker crash/);

      const plan = (await env.stack.portfolioPlans.getLatest(portfolioId))!;
      const lineageAfterCrash = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM portfolio_program_lineage WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(Number(lineageAfterCrash.rows[0]?.c)).toBe(3);

      const reservationsBefore = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(Number(reservationsBefore.rows[0]?.c)).toBe(3);

      crashAfterThree = false;
      const env2 = await createTestStack(uniquePostgresTestId("p15-crash2"));
      try {
        await env2.stack.portfolioService.materializePrograms(portfolioId);
        const lineageFinal = await env.stack.db.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM portfolio_program_lineage WHERE portfolio_id = $1`,
          [portfolioId],
        );
        expect(Number(lineageFinal.rows[0]?.c)).toBe(5);
        const reservationsFinal = await env.stack.db.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
          [portfolioId],
        );
        expect(Number(reservationsFinal.rows[0]?.c)).toBe(5);

        const dupLineage = await env.stack.db.query<{ c: number }>(
          `SELECT proposal_id, COUNT(*)::int AS c FROM portfolio_program_lineage
           WHERE portfolio_id = $1 GROUP BY proposal_id HAVING COUNT(*) > 1`,
          [portfolioId],
        );
        expect(dupLineage.rows.length).toBe(0);
        expect(plan.portfolioPlanHash).toBe(
          (await env2.stack.portfolioPlans.getLatest(portfolioId))!
            .portfolioPlanHash,
        );
      } finally {
        await env2.close();
      }
    } finally {
      await env.close();
    }
  }, 180_000);

  it("concurrent portfolio verify yields one completion authority", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-conc-verify"));
    try {
      const projectId = `p15_cv_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const goals = strategicGoals(1);
      const admitted = await admitPortfolio(
        env.stack,
        projectId,
        goals,
        undefined,
        allowFullConcentration(),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;

      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      await env.stack.portfolioService.validate(portfolioId);
      await authorizePortfolio(env.stack, portfolioId);
      const { materialized } =
        await env.stack.portfolioService.materializePrograms(portfolioId);
      const link = materialized[0]!;
      await env.stack.programService.decompose(link.programId);
      await env.stack.programService.validate(link.programId);
      await authorizeProgramMaterialization(env.stack, link.programId);
      await env.stack.programService.materializeNext(link.programId);
      await injectProgramSuccessEvidence(
        env.stack,
        projectId,
        link.programId,
        goals[0]!.successCriteria[0]!,
      );
      await env.stack.programService.verify(link.programId);

      const results = await Promise.allSettled([
        env.stack.portfolioService.verify(portfolioId),
        env.stack.portfolioService.verify(portfolioId),
      ]);
      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<{
          outcome: string;
          portfolio: { status: string };
        }> => r.status === "fulfilled",
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const r of fulfilled) {
        expect(r.value.outcome).toBe("VERIFIED_SUCCESS");
      }
      const comps = await env.stack.db.query(
        `SELECT 1 FROM portfolio_completion_records WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(comps.rows.length).toBe(1);
      const final = await env.stack.portfolios.getById(portfolioId);
      expect(final?.status).toBe("COMPLETED");
    } finally {
      await env.close();
    }
  }, 180_000);

  it("rebalance requires new authorization; allocation cannot silently mutate", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-rebalance"));
    try {
      const projectId = `p15_rb_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const goals = strategicGoals(2);
      const admitted = await admitPortfolio(env.stack, projectId, goals);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;

      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      await env.stack.portfolioService.validate(portfolioId);
      const routedV1 =
        await env.stack.portfolioService.routeAuthorization(portfolioId);
      await authorizePortfolio(env.stack, portfolioId);
      await env.stack.portfolioService.materializePrograms(portfolioId);
      const planV1 = (await env.stack.portfolioPlans.getLatest(portfolioId))!;
      const reservationsBefore = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
        [portfolioId],
      );

      const rebalanced = await env.stack.portfolioService.proposeRebalance(
        portfolioId,
        "BUDGET_EXHAUSTION",
      );
      expect(rebalanced.portfolio.status).toBe("REBALANCE_REQUIRED");

      await expect(
        env.stack.portfolioService.materializePrograms(portfolioId),
      ).rejects.toMatchObject({ code: "INVALID_PORTFOLIO_TRANSITION" });

      await env.stack.portfolioService.plan(portfolioId);
      await env.stack.portfolioService.validate(portfolioId);
      const planV2 = (await env.stack.portfolioPlans.getLatest(portfolioId))!;
      expect(planV2.portfolioPlanVersion).toBe(planV1.portfolioPlanVersion + 1);
      expect(planV2.portfolioPlanHash).not.toBe(planV1.portfolioPlanHash);

      await expect(
        env.stack.portfolioService.decideAuthorization({
          authorizationId: routedV1.request.authorizationId,
          allocatorId: "approver_bootstrap",
          decision: "APPROVE",
          decisionNonce: routedV1.decisionNonce,
          submittedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ code: "PORTFOLIO_AUTHORIZATION_INVALID" });

      const reservationsAfter = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(Number(reservationsAfter.rows[0]?.c)).toBe(
        Number(reservationsBefore.rows[0]?.c),
      );
    } finally {
      await env.close();
    }
  }, 180_000);

  it("two discovery workers reuse one PLAN_PORTFOLIO work identity", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-dup"));
    try {
      const projectId = `p15_dup_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitPortfolio(
        env.stack,
        projectId,
        strategicGoals(1),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;

      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 8,
        weight: 1,
      });

      const a =
        await env.stack.portfolioWorkMaterializer.discoverForPortfolio(
          portfolioId,
        );
      const b =
        await env.stack.portfolioWorkMaterializer.discoverForPortfolio(
          portfolioId,
        );
      expect(a.created.length + a.reused.length).toBeGreaterThan(0);
      expect(b.reused.length).toBeGreaterThan(0);

      const items =
        await env.stack.schedulerWorkItems.listByRun(portfolioId);
      const planItems = items.filter((i) => i.workKind === "PLAN_PORTFOLIO");
      expect(planItems.length).toBe(1);

      const ownerA = `${env.stack.instanceId}-worker_a`;
      const claimA = await env.stack.scheduler.selectAndClaimWork({
        ownerId: ownerA,
        workerCapabilities: ["PORTFOLIO_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      const claimB = await env.stack.scheduler.selectAndClaimWork({
        ownerId: `${env.stack.instanceId}-worker_b`,
        workerCapabilities: ["PORTFOLIO_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      expect(claimA.claimed).not.toBeNull();
      expect(claimA.lease).not.toBeNull();
      if (claimA.claimed) {
        expect(claimA.claimed.workKind).toBe("PLAN_PORTFOLIO");
        expect(claimA.claimed.runId).toBe(portfolioId);
      }
      expect(claimB.claimed).toBeNull();

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
    } finally {
      await env.close();
    }
  }, 60_000);

  it("rejects portfolio authorization from principals lacking PORTFOLIO_ALLOCATOR", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-role"));
    try {
      const projectId = `p15_role_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.stack.db);
      await authority.seed([
        {
          principalId: "approver_only",
          principalType: "APPROVER",
          projectId,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "materializer_only",
          principalType: "PROGRAM_MATERIALIZER",
          projectId,
          environments: [EXAMPLE_ENVIRONMENT],
        },
      ]);

      const admitted = await admitPortfolio(
        env.stack,
        projectId,
        strategicGoals(1),
        undefined,
        allowFullConcentration(),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;
      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      await env.stack.portfolioService.validate(portfolioId);
      const routed =
        await env.stack.portfolioService.routeAuthorization(portfolioId);

      for (const allocatorId of ["approver_only", "materializer_only"]) {
        await expect(
          env.stack.portfolioService.decideAuthorization({
            authorizationId: routed.request.authorizationId,
            allocatorId,
            decision: "APPROVE",
            decisionNonce: routed.decisionNonce,
            submittedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ code: "PORTFOLIO_AUTHORIZATION_INVALID" });
      }

      // APPROVER / MATERIALIZER over the project still cannot allocate.
      const beforeRes = await env.stack.db.query(
        `SELECT 1 FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(beforeRes.rows.length).toBe(0);
      const beforeLin = await env.stack.db.query(
        `SELECT 1 FROM portfolio_program_lineage WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(beforeLin.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("cross-project PORTFOLIO_ALLOCATOR requires grants for every envelope project", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-xproj"));
    try {
      const projectA = `p15_xa_${uniquePostgresTestId("p")}`;
      const projectB = `p15_xb_${uniquePostgresTestId("p")}`;
      const projectC = `p15_xc_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await seedDedicatedPostgresTestProject(env.stack.db, projectC);
      const authority = new PostgresAuthorityDirectory(env.stack.db);

      // Partial allocator: A+B only
      await authority.seed([
        {
          principalId: "alloc_ab",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId: projectA,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "alloc_ab",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId: projectB,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "alloc_a",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId: projectA,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "approver_all",
          principalType: "APPROVER",
          projectId: projectA,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "approver_all",
          principalType: "APPROVER",
          projectId: projectB,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "approver_all",
          principalType: "APPROVER",
          projectId: projectC,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "materializer_all",
          principalType: "PROGRAM_MATERIALIZER",
          projectId: projectA,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "materializer_all",
          principalType: "PROGRAM_MATERIALIZER",
          projectId: projectB,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "materializer_all",
          principalType: "PROGRAM_MATERIALIZER",
          projectId: projectC,
          environments: [EXAMPLE_ENVIRONMENT],
        },
      ]);

      const admitted = await admitPortfolio(
        env.stack,
        projectA,
        strategicGoals(2),
        undefined,
        {
          allowedProjectIds: [projectA, projectB, projectC],
          crossProjectDelegationAllowed: true,
          maximumCrossProjectPrograms: 3,
        },
      );
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;
      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      const validated = await env.stack.portfolioService.validate(portfolioId);
      expect(validated.result.outcome).toBe("HUMAN_APPROVAL_REQUIRED");
      const routed =
        await env.stack.portfolioService.routeAuthorization(portfolioId);

      for (const allocatorId of [
        "alloc_a",
        "alloc_ab",
        "approver_all",
        "materializer_all",
      ]) {
        await expect(
          env.stack.portfolioService.decideAuthorization({
            authorizationId: routed.request.authorizationId,
            allocatorId,
            decision: "APPROVE",
            decisionNonce: routed.decisionNonce,
            submittedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ code: "PORTFOLIO_AUTHORIZATION_INVALID" });
      }

      expect(
        (
          await env.stack.db.query(
            `SELECT 1 FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
            [portfolioId],
          )
        ).rows.length,
      ).toBe(0);
      expect(
        (
          await env.stack.db.query(
            `SELECT 1 FROM portfolio_program_lineage WHERE portfolio_id = $1`,
            [portfolioId],
          )
        ).rows.length,
      ).toBe(0);

      // Full A+B+C grant succeeds
      await authority.seed([
        {
          principalId: "alloc_abc",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId: projectA,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "alloc_abc",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId: projectB,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "alloc_abc",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId: projectC,
          environments: [EXAMPLE_ENVIRONMENT],
        },
      ]);
      const decided = await env.stack.portfolioService.decideAuthorization({
        authorizationId: routed.request.authorizationId,
        allocatorId: "alloc_abc",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: new Date().toISOString(),
      });
      expect(decided.portfolio.status).toBe("AUTHORIZED");
    } finally {
      await env.close();
    }
  }, 180_000);

  it("concentration ceiling blocks single-program 100% when ceiling is 60%", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-conc"));
    try {
      const projectId = `p15_conc_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitPortfolio(
        env.stack,
        projectId,
        strategicGoals(1),
        undefined,
        { allocationConcentrationCeiling: 0.6 },
      );
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;
      await env.stack.portfolioService.analyze(portfolioId);
      await env.stack.portfolioService.plan(portfolioId);
      const validated = await env.stack.portfolioService.validate(portfolioId);
      expect(validated.result.outcome).toBe("BLOCK");
      expect(
        validated.result.findings.some((f) => f.code === "CONCENTRATION_LIMIT"),
      ).toBe(true);
      expect(validated.portfolio.status).not.toBe("AWAITING_AUTHORIZATION");
    } finally {
      await env.close();
    }
  }, 60_000);

  it("multi-portfolio distributed claim: A/B/C, two schedulers, claim lifecycle closed", async () => {
    const envA = await createTestStack(uniquePostgresTestId("p15-dist-a"));
    const envB = await createTestStack(uniquePostgresTestId("p15-dist-b"));
    try {
      const projectA = `p15_da_${uniquePostgresTestId("p")}`;
      const projectB = `p15_db_${uniquePostgresTestId("p")}`;
      const projectC = `p15_dc_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(envA.stack.db, projectA);
      await seedDedicatedPostgresTestProject(envA.stack.db, projectB);
      await seedDedicatedPostgresTestProject(envA.stack.db, projectC);

      for (const projectId of [projectA, projectB, projectC]) {
        await envA.stack.scheduler.upsertProjectConfig({
          projectId,
          maxConcurrency: 2,
          weight: 1,
        });
      }

      const portfolios: { id: string; projectId: string }[] = [];
      for (const [label, projectId] of [
        ["A", projectA],
        ["B", projectB],
        ["C", projectC],
      ] as const) {
        const admitted = await admitPortfolio(
          envA.stack,
          projectId,
          strategicGoals(2),
          uniquePostgresTestId(`pfo_${label}`),
        );
        expect(admitted.outcome).toBe("ADMITTED");
        if (admitted.outcome !== "ADMITTED") return;
        portfolios.push({
          id: admitted.portfolio.portfolioId,
          projectId,
        });
        await envA.stack.portfolioService.analyze(admitted.portfolio.portfolioId);
      }

      // Two discovery workers see the same portfolios → one work identity each
      for (const p of portfolios) {
        const d1 = await envA.stack.portfolioWorkMaterializer.discoverForPortfolio(
          p.id,
        );
        const d2 = await envB.stack.portfolioWorkMaterializer.discoverForPortfolio(
          p.id,
        );
        expect(d1.created.length + d1.reused.length).toBeGreaterThan(0);
        expect(d2.reused.length + d2.created.length).toBeGreaterThan(0);
        const items = await envA.stack.schedulerWorkItems.listByRun(p.id);
        const planItems = items.filter((i) => i.workKind === "PLAN_PORTFOLIO");
        expect(planItems.length).toBe(1);
      }

      const ownerA = `${envA.stack.instanceId}-sched_a`;
      const ownerB = `${envB.stack.instanceId}-sched_b`;
      const claimA = await envA.stack.scheduler.selectAndClaimWork({
        ownerId: ownerA,
        workerCapabilities: ["PORTFOLIO_ORCHESTRATION", "ALL"],
        projectIds: [projectA, projectB, projectC],
      });
      const claimB = await envB.stack.scheduler.selectAndClaimWork({
        ownerId: ownerB,
        workerCapabilities: ["PORTFOLIO_ORCHESTRATION", "ALL"],
        projectIds: [projectA, projectB, projectC],
      });
      expect(claimA.claimed).not.toBeNull();
      // Contending scheduler may claim a different portfolio's work, but not
      // the same work item.
      if (claimB.claimed && claimA.claimed) {
        expect(claimB.claimed.workItemId).not.toBe(claimA.claimed.workItemId);
      }

      // Advance one portfolio through human gate; prove Program gates remain.
      const focus = portfolios[0]!;
      await envA.stack.portfolioService.plan(focus.id);
      await envA.stack.portfolioService.validate(focus.id);
      let portfolio = await envA.stack.portfolios.getById(focus.id);
      expect(portfolio?.status).toBe("AWAITING_AUTHORIZATION");
      await authorizePortfolio(envA.stack, focus.id);
      const mat = await envA.stack.portfolioService.materializePrograms(focus.id);
      expect(mat.materialized.length).toBe(2);
      for (const link of mat.materialized) {
        const program = await envA.stack.programs.getById(link.programId);
        expect(program?.status).toBe("ADMITTED");
      }

      // Budget isolation: reservations belong only to focus portfolio
      const resFocus = await envA.stack.db.query<{ portfolio_id: string }>(
        `SELECT portfolio_id FROM portfolio_budget_reservations
         WHERE portfolio_id = ANY($1::text[])`,
        [portfolios.map((p) => p.id)],
      );
      expect(
        resFocus.rows.every((r) => r.portfolio_id === focus.id),
      ).toBe(true);

      // Settle all claims from this test
      for (const [stack, owner, claim] of [
        [envA.stack, ownerA, claimA] as const,
        [envB.stack, ownerB, claimB] as const,
      ]) {
        if (claim.claimed && claim.lease) {
          await stack.scheduler.markSucceeded(
            claim.claimed,
            "p15-dist-settle",
          );
          await stack.leases.release({
            coordinationKey: `scheduler:work:${claim.claimed.workItemId}`,
            ownerId: owner,
            fenceToken: claim.lease.fenceToken,
          });
        }
      }

      // Drain any remaining eligible claims we may have left for A/B/C
      for (const projectId of [projectA, projectB, projectC]) {
        for (let i = 0; i < 8; i++) {
          const claim = await envA.stack.scheduler.selectAndClaimWork({
            ownerId: `${envA.stack.instanceId}-drain`,
            workerCapabilities: ["PORTFOLIO_ORCHESTRATION", "ALL"],
            projectIds: [projectId],
          });
          if (!claim.claimed || !claim.lease) break;
          await envA.stack.scheduler.markSucceeded(
            claim.claimed,
            "p15-dist-drain",
          );
          await envA.stack.leases.release({
            coordinationKey: `scheduler:work:${claim.claimed.workItemId}`,
            ownerId: `${envA.stack.instanceId}-drain`,
            fenceToken: claim.lease.fenceToken,
          });
        }
        expect(
          await envA.stack.schedulerWorkItems.countActiveByProject(projectId),
        ).toBe(0);
      }

      // Restart reconstructs from PostgreSQL
      const envRestart = await createTestStack(
        uniquePostgresTestId("p15-dist-r"),
      );
      try {
        const reloaded = await envRestart.stack.portfolios.getById(focus.id);
        expect(reloaded?.status).toBe("ACTIVE");
        const lineage = await envRestart.stack.db.query(
          `SELECT 1 FROM portfolio_program_lineage WHERE portfolio_id = $1`,
          [focus.id],
        );
        expect(lineage.rows.length).toBe(2);
      } finally {
        await envRestart.close();
      }
    } finally {
      await envB.close();
      await envA.close();
    }
  }, 240_000);

  it("custom strategy with five CREATE proposals is honored by FakePortfolioStrategyModel", async () => {
    const env = await createTestStack(uniquePostgresTestId("p15-five"), {
      portfolioStrategyModel: new FakePortfolioStrategyModel(({ portfolio }) =>
        strategicGoals(5).map((goal, index) => ({
          proposalId: `prop_${goal.goalId}`,
          title: `Program for ${goal.goalId}`,
          requestedOutcome: goal.description,
          projectId: portfolio.primaryProjectId,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
          repositoryScope: [
            ...portfolio.authorizationEnvelope.allowedRepositoryIdentities,
          ],
          proposedProgramRootIntent: {
            requestedOutcome: goal.description,
            acceptanceCriteria: [...goal.successCriteria],
            nonGoals: [...portfolio.intent.nonGoals],
            constraints: [...portfolio.intent.constraints],
            priority: "HIGH" as const,
          },
          requestedAllocation: {
            ...emptyBudgetEstimate(),
            llmCalls: 5,
            totalTokens: 10_000,
            apiCalls: 5,
            executionMinutes: 10,
            estimatedCost: 2,
            humanReviewMinutes: 5,
            planSteps: 5,
            parallelWorkstreams: 1,
            revisionAttempts: 1,
          },
          goalContributionBindings: [
            {
              bindingId: `bind_${goal.goalId}`,
              portfolioGoalId: goal.goalId,
              programProposalId: `prop_${goal.goalId}`,
              programCriterionId: goal.successCriteria[0]!,
              requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
              contributionType: "PRIMARY" as const,
              contributionScore: 1,
            },
          ],
          programDependencies: [],
          priorityRecommendation: 50 + index,
          riskClassification: "MEDIUM" as const,
          disposition: "CREATE_PROGRAM" as const,
        })),
      ),
    });
    try {
      const projectId = `p15_five_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitPortfolio(
        env.stack,
        projectId,
        strategicGoals(5),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const portfolioId = admitted.portfolio.portfolioId;
      await env.stack.portfolioService.analyze(portfolioId);
      const { plan } = await env.stack.portfolioService.plan(portfolioId);
      expect(plan.programProposals).toHaveLength(5);
    } finally {
      await env.close();
    }
  }, 60_000);
});
