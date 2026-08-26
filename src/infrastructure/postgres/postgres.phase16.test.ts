import { describe, expect, it } from "vitest";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import type { DecisionCriterion } from "../../scenarios/decision-problem.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import { PostgresPolicyRegistry } from "./repositories/control-plane.js";
import { PostgresProjectRegistry } from "./repositories/control-plane.js";
import { SystemClock } from "../clock.js";
import { EXAMPLE_POLICY_BUNDLE } from "../../control-plane/fixtures.js";
import { FakeScenarioGenerationModel } from "../../scenarios/generation-model.js";

type Stack = Awaited<ReturnType<typeof createTestStack>>["stack"];

function decisionCriteria(count = 3): DecisionCriterion[] {
  const kinds = [
    "EXPECTED_VALUE",
    "GOAL_COVERAGE",
    "RISK",
  ] as const satisfies readonly DecisionCriterion["kind"][];
  return Array.from({ length: count }, (_, i) => ({
    criterionId: `crit_${i + 1}`,
    name: `Criterion ${i + 1}`,
    kind: kinds[i % kinds.length]!,
    weight: 1 / count,
    higherIsBetter: kinds[i % kinds.length] !== "RISK",
  }));
}

async function admitDecisionProblem(
  stack: Stack,
  projectId: string,
  decisionProblemId?: string,
) {
  return stack.scenarioService.admit({
    decisionProblemId,
    primaryProjectId: projectId,
    question: "Which strategic path should we take next quarter?",
    strategicObjective: "Improve durable goal coverage under budget",
    decisionCriteria: decisionCriteria(3),
    timeHorizon: "90 days",
    constraints: ["no production deployment"],
    nonGoals: ["Autonomous capital allocation"],
    allowedProjectIds: [projectId],
    allowedEnvironments: [EXAMPLE_ENVIRONMENT],
    riskTolerance: "MEDIUM",
    createdBy: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    submittedAt: new Date().toISOString(),
  });
}

async function ladderToAwaitingSelection(stack: Stack, projectId: string) {
  const admitted = await admitDecisionProblem(stack, projectId);
  expect(admitted.outcome).toBe("ADMITTED");
  if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
  const id = admitted.problem.decisionProblemId;
  await stack.scenarioService.ground(id);
  await stack.scenarioService.generateScenarios(id);
  await stack.scenarioService.simulateAll(id, "postgres-ladder-seed");
  await stack.scenarioService.analyze(id);
  const validated = await stack.scenarioService.validatePackage(id);
  expect(validated.problem.status).toBe("AWAITING_SELECTION");
  return { id, pkg: validated.pkg, problem: validated.problem };
}

async function decideSelection(
  stack: Stack,
  decisionProblemId: string,
  selectedScenarioId: string,
) {
  const routed = await stack.scenarioService.routeSelection(decisionProblemId);
  return stack.scenarioService.decideSelection({
    selectionId: routed.request.selectionId,
    selectorId: "approver_bootstrap",
    decision: "SELECT_SCENARIO",
    selectedScenarioId,
    decisionNonce: routed.decisionNonce,
    submittedAt: new Date().toISOString(),
  });
}

async function driftProjectPolicy(
  stack: Stack,
  projectId: string,
): Promise<void> {
  const clock = new SystemClock();
  const projects = new PostgresProjectRegistry(stack.db);
  const policies = new PostgresPolicyRegistry(stack.db, clock);
  const project = (await projects.getById(projectId))!;
  const previousPolicyId = project.activePolicyBundleId;
  const previous = await policies.getBundleById(previousPolicyId);
  if (!previous) {
    throw new Error(`Missing prior policy bundle ${previousPolicyId}`);
  }

  const driftPolicyId = `pol_drift_${projectId}`;
  // Valid A → B: exactly one ACTIVE bundle for the project after transition.
  // Leaving A ACTIVE alongside B causes POLICY_CONFLICT (not PACKAGE_STALE).
  await policies.seed([
    {
      ...previous,
      status: "SUPERSEDED",
    },
    {
      ...EXAMPLE_POLICY_BUNDLE,
      policyBundleId: driftPolicyId,
      semanticVersion: "2.0.0",
      policyHash: `sha256:drifted-policy-${projectId}-${Date.now()}`,
      applicableProjectIds: [projectId],
      applicableEnvironments: [...previous.applicableEnvironments],
      status: "ACTIVE",
      supersedes: previousPolicyId,
      effectiveAt: previous.effectiveAt,
      createdAt: previous.createdAt,
    },
  ]);
  await projects.seed([
    {
      ...project,
      activePolicyBundleId: driftPolicyId,
      updatedAt: new Date().toISOString(),
    },
  ]);
}

describe("Phase 16 scenario intelligence (postgres)", () => {
  it("primary ladder: admit through proposal without portfolio authorization", async () => {
    const env = await createTestStack(uniquePostgresTestId("p16-ladder"));
    try {
      const projectId = `p16_ladder_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const { id, pkg } = await ladderToAwaitingSelection(env.stack, projectId);

      const routed = await env.stack.scenarioService.routeSelection(id);
      expect(routed.request.status).toBe("PENDING");

      const selectedScenarioId = pkg.recommendedScenarioIds[0]!;
      const decided = await decideSelection(env.stack, id, selectedScenarioId);
      expect(decided.problem.status).toBe("SELECTED");
      expect(decided.record?.decision).toBe("SELECT_SCENARIO");

      const materialized =
        await env.stack.scenarioService.materializePortfolioProposal(id);
      expect(materialized.problem.status).toBe("MATERIALIZED_AS_PROPOSAL");
      expect(materialized.lineage.portfolioAdmissionOutcome).toBe("ADMITTED");
      expect(materialized.lineage.portfolioId).toBeTruthy();

      const portfolioId = materialized.lineage.portfolioId!;
      const portfolio = await env.stack.portfolios.getById(portfolioId);
      expect(portfolio?.status).toBe("ADMITTED");
      expect(["AUTHORIZED", "ACTIVE"]).not.toContain(portfolio?.status);

      const portfolioAuths = await env.stack.db.query<{ status: string }>(
        `SELECT payload->>'status' AS status
         FROM portfolio_authorization_records
         WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(portfolioAuths.rows.length).toBe(0);

      const reservations = await env.stack.db.query(
        `SELECT 1 FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(reservations.rows.length).toBe(0);

      const budget = await env.stack.db.query<{ reserved: unknown }>(
        `SELECT payload->'reserved' AS reserved
         FROM portfolio_budget_ledgers WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(budget.rows.length).toBe(1);
      const reserved = budget.rows[0]!.reserved as Record<string, number>;
      expect(Object.values(reserved).every((v) => v === 0)).toBe(true);

      const programLineage = await env.stack.db.query(
        `SELECT 1 FROM portfolio_program_lineage WHERE portfolio_id = $1`,
        [portfolioId],
      );
      expect(programLineage.rows.length).toBe(0);

      const lineage = await env.stack.db.query(
        `SELECT 1 FROM scenario_portfolio_lineage WHERE decision_problem_id = $1`,
        [id],
      );
      expect(lineage.rows.length).toBe(1);
    } finally {
      await env.close();
    }
  }, 240_000);

  it("truth drift after package blocks selection with PACKAGE_STALE", async () => {
    const env = await createTestStack(uniquePostgresTestId("p16-drift"));
    try {
      const projectId = `p16_drift_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const { id, pkg } = await ladderToAwaitingSelection(env.stack, projectId);

      // Prove package is fresh before intentional drift.
      const routedFresh = await env.stack.scenarioService.routeSelection(id);
      expect(routedFresh.request.status).toBe("PENDING");

      await driftProjectPolicy(env.stack, projectId);

      await expect(
        env.stack.scenarioService.decideSelection({
          selectionId: routedFresh.request.selectionId,
          selectorId: "approver_bootstrap",
          decision: "SELECT_SCENARIO",
          selectedScenarioId: pkg.recommendedScenarioIds[0]!,
          decisionNonce: routedFresh.decisionNonce,
          submittedAt: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ code: "PACKAGE_STALE" });

      const stale = await env.stack.decisionProblems.getById(id);
      expect(stale?.status).toBe("STALE");
      expect(stale?.failureReasonCode).toBe("TRUTH_DRIFT");

      const selections = await env.stack.db.query(
        `SELECT 1 FROM strategy_selection_records WHERE decision_problem_id = $1`,
        [id],
      );
      expect(selections.rows.length).toBe(0);
      const lineage = await env.stack.db.query(
        `SELECT 1 FROM scenario_portfolio_lineage WHERE decision_problem_id = $1`,
        [id],
      );
      expect(lineage.rows.length).toBe(0);
      const portfolios = await env.stack.db.query(
        `SELECT 1 FROM portfolios WHERE payload->>'primaryProjectId' = $1`,
        [projectId],
      );
      expect(portfolios.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  }, 180_000);

  it("truth drift blocks materializePortfolioProposal after selection", async () => {
    const env = await createTestStack(uniquePostgresTestId("p16-drift-mat"));
    try {
      const projectId = `p16_driftm_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const { id, pkg } = await ladderToAwaitingSelection(env.stack, projectId);
      const decided = await decideSelection(
        env.stack,
        id,
        pkg.recommendedScenarioIds[0]!,
      );
      expect(decided.problem.status).toBe("SELECTED");
      expect(decided.record?.decision).toBe("SELECT_SCENARIO");

      await driftProjectPolicy(env.stack, projectId);

      await expect(
        env.stack.scenarioService.materializePortfolioProposal(id),
      ).rejects.toMatchObject({ code: "PACKAGE_STALE" });

      const stale = await env.stack.decisionProblems.getById(id);
      expect(stale?.status).toBe("STALE");

      const lineage = await env.stack.db.query(
        `SELECT 1 FROM scenario_portfolio_lineage WHERE decision_problem_id = $1`,
        [id],
      );
      expect(lineage.rows.length).toBe(0);
      const portfolios = await env.stack.db.query(
        `SELECT 1 FROM portfolios WHERE payload->>'primaryProjectId' = $1`,
        [projectId],
      );
      expect(portfolios.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  }, 180_000);

  it("crash-safe simulation resume reuses first persisted results", async () => {
    let crashOnce = true;
    const env = await createTestStack(uniquePostgresTestId("p16-crash"), {
      scenarioGenerationModel: new FakeScenarioGenerationModel({
        extraScenarioCount: 2,
      }),
      scenarioSimulationFailpoint: {
        async hit(newResultCount: number) {
          if (crashOnce && newResultCount >= 3) {
            throw new Error("simulated scenario worker crash after 3 simulations");
          }
        },
      },
    });
    try {
      const projectId = `p16_crash_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitDecisionProblem(env.stack, projectId);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const id = admitted.problem.decisionProblemId;
      await env.stack.scenarioService.ground(id);
      const { scenarioSet } =
        await env.stack.scenarioService.generateScenarios(id);
      expect(scenarioSet.scenarios.length).toBe(5);

      await expect(
        env.stack.scenarioService.simulateAll(id, "postgres-crash-seed"),
      ).rejects.toThrow(/simulated scenario worker crash/);

      const saved = await env.stack.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM scenario_simulation_results
         WHERE decision_problem_id = $1`,
        [id],
      );
      expect(Number(saved.rows[0]?.c)).toBe(3);

      const usageMid = await env.stack.db.query<{ sim: number }>(
        `SELECT (payload->>'simRuns')::int AS sim
         FROM simulation_usage_ledgers WHERE decision_problem_id = $1`,
        [id],
      );
      expect(Number(usageMid.rows[0]?.sim)).toBe(3);

      const env2 = await createTestStack(uniquePostgresTestId("p16-crash2"));
      try {
        crashOnce = false;
        const resumed = await env2.stack.scenarioService.simulateAll(
          id,
          "postgres-crash-seed",
        );
        expect(resumed.results.length).toBe(5);
        expect(resumed.problem.status).toBe("ANALYZING");

        const finalCount = await env.stack.db.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM scenario_simulation_results
           WHERE scenario_set_id = $1 AND scenario_set_version = $2`,
          [scenarioSet.scenarioSetId, scenarioSet.scenarioSetVersion],
        );
        expect(Number(finalCount.rows[0]?.c)).toBe(5);

        const usageFinal = await env.stack.db.query<{ sim: number }>(
          `SELECT (payload->>'simRuns')::int AS sim
           FROM simulation_usage_ledgers WHERE decision_problem_id = $1`,
          [id],
        );
        expect(Number(usageFinal.rows[0]?.sim)).toBe(5);

        const dupInputs = await env.stack.db.query<{ c: number }>(
          `SELECT input_fingerprint, COUNT(*)::int AS c
           FROM scenario_simulation_results
           WHERE scenario_set_id = $1
           GROUP BY input_fingerprint HAVING COUNT(*) > 1`,
          [scenarioSet.scenarioSetId],
        );
        expect(dupInputs.rows.length).toBe(0);
      } finally {
        await env2.close();
      }
    } finally {
      await env.close();
    }
  }, 180_000);

  it("two discovery workers reuse one GROUND_DECISION_PROBLEM work identity", async () => {
    const env = await createTestStack(uniquePostgresTestId("p16-dup"));
    try {
      const projectId = `p16_dup_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const admitted = await admitDecisionProblem(env.stack, projectId);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const id = admitted.problem.decisionProblemId;

      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 8,
        weight: 1,
      });

      const a =
        await env.stack.scenarioWorkMaterializer.discoverForDecisionProblem(id);
      const b =
        await env.stack.scenarioWorkMaterializer.discoverForDecisionProblem(id);
      expect(a.created.length + a.reused.length).toBeGreaterThan(0);
      expect(b.reused.length).toBeGreaterThan(0);

      const items = await env.stack.schedulerWorkItems.listByRun(id);
      const groundItems = items.filter(
        (i) => i.workKind === "GROUND_DECISION_PROBLEM",
      );
      expect(groundItems.length).toBe(1);

      const ownerA = `${env.stack.instanceId}-worker_a`;
      const claimA = await env.stack.scheduler.selectAndClaimWork({
        ownerId: ownerA,
        workerCapabilities: ["SCENARIO_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      const claimB = await env.stack.scheduler.selectAndClaimWork({
        ownerId: `${env.stack.instanceId}-worker_b`,
        workerCapabilities: ["SCENARIO_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      expect(claimA.claimed).not.toBeNull();
      expect(claimA.lease).not.toBeNull();
      if (claimA.claimed) {
        expect(claimA.claimed.workKind).toBe("GROUND_DECISION_PROBLEM");
        expect(claimA.claimed.runId).toBe(id);
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

  it("rejects strategy selection from principals lacking STRATEGY_SELECTOR", async () => {
    const env = await createTestStack(uniquePostgresTestId("p16-role"));
    try {
      const projectId = `p16_role_${uniquePostgresTestId("p")}`;
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
          principalId: "allocator_only",
          principalType: "PORTFOLIO_ALLOCATOR",
          projectId,
          environments: [EXAMPLE_ENVIRONMENT],
        },
      ]);

      const { id, pkg } = await ladderToAwaitingSelection(env.stack, projectId);
      const routed = await env.stack.scenarioService.routeSelection(id);
      const selectedScenarioId = pkg.recommendedScenarioIds[0]!;

      for (const selectorId of ["approver_only", "allocator_only"]) {
        await expect(
          env.stack.scenarioService.decideSelection({
            selectionId: routed.request.selectionId,
            selectorId,
            decision: "SELECT_SCENARIO",
            selectedScenarioId,
            decisionNonce: routed.decisionNonce,
            submittedAt: new Date().toISOString(),
          }),
        ).rejects.toMatchObject({ code: "STRATEGY_SELECTOR_SCOPE_INSUFFICIENT" });
      }

      const selections = await env.stack.db.query(
        `SELECT 1 FROM strategy_selection_records WHERE decision_problem_id = $1`,
        [id],
      );
      expect(selections.rows.length).toBe(0);
      const lineage = await env.stack.db.query(
        `SELECT 1 FROM scenario_portfolio_lineage WHERE decision_problem_id = $1`,
        [id],
      );
      expect(lineage.rows.length).toBe(0);
      const portfolios = await env.stack.db.query(
        `SELECT 1 FROM portfolios WHERE payload->>'primaryProjectId' = $1`,
        [projectId],
      );
      expect(portfolios.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("distributed schedulers contend on claim; claim lifecycle settles", async () => {
    const envA = await createTestStack(uniquePostgresTestId("p16-dist-a"));
    const envB = await createTestStack(uniquePostgresTestId("p16-dist-b"));
    try {
      const projectId = `p16_dist_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(envA.stack.db, projectId);

      const admitted = await admitDecisionProblem(envA.stack, projectId);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const id = admitted.problem.decisionProblemId;

      await envA.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 2,
        weight: 1,
      });

      const d1 =
        await envA.stack.scenarioWorkMaterializer.discoverForDecisionProblem(id);
      const d2 =
        await envB.stack.scenarioWorkMaterializer.discoverForDecisionProblem(id);
      expect(d1.created.length + d1.reused.length).toBeGreaterThan(0);
      expect(d2.reused.length + d2.created.length).toBeGreaterThan(0);

      const items = await envA.stack.schedulerWorkItems.listByRun(id);
      const groundItems = items.filter(
        (i) => i.workKind === "GROUND_DECISION_PROBLEM",
      );
      expect(groundItems.length).toBe(1);

      const ownerA = `${envA.stack.instanceId}-sched_a`;
      const ownerB = `${envB.stack.instanceId}-sched_b`;
      const claimA = await envA.stack.scheduler.selectAndClaimWork({
        ownerId: ownerA,
        workerCapabilities: ["SCENARIO_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      const claimB = await envB.stack.scheduler.selectAndClaimWork({
        ownerId: ownerB,
        workerCapabilities: ["SCENARIO_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      expect(claimA.claimed).not.toBeNull();
      expect(claimB.claimed).toBeNull();

      const claimed = claimA.claimed!;
      const lease = claimA.lease!;
      await envA.stack.scheduler.markSucceeded(claimed, "distributed-owner");
      await envA.stack.leases.release({
        coordinationKey: `scheduler:work:${claimed.workItemId}`,
        ownerId: ownerA,
        fenceToken: lease.fenceToken,
      });
      expect(
        await envA.stack.schedulerWorkItems.countActiveByProject(projectId),
      ).toBe(0);
    } finally {
      await envA.close();
      await envB.close();
    }
  }, 120_000);
});
