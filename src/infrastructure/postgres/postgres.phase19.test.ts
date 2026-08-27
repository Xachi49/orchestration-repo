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
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import { EXPERIMENT_STATES } from "../../experiments/index.js";
import type { DecisionPolicyOrchestrationService } from "../../decision-policies/service.js";
import type { DecisionStateVariable } from "../../decision-policies/variables-actions.js";
import type { DecisionActionDefinition } from "../../decision-policies/variables-actions.js";

type TestEnv = Awaited<ReturnType<typeof createTestStack>>;
type Stack = TestEnv["stack"];

const POLICY_APPROVER_ONLY = "decision_policy_approver_only_p19";
const POLICY_ACTIVATOR_ONLY = "decision_policy_activator_only_p19";
const OPERATIONAL_APPROVER = "approver_bootstrap";

const SAMPLE_STATE_VARIABLE: DecisionStateVariable = {
  variableId: "var_conversion_rate",
  name: "Conversion rate",
  description: "Observed conversion metric",
  unit: "PERCENT",
  sourceClass: "OBSERVATIONAL_DATA",
  sourceRef: "metrics/conversion",
  measurementDefinition: "7d rolling conversion",
  freshnessRequirementMs: 86_400_000,
  qualityRequirement: "PARTIAL",
  missingValuePolicy: "FAIL_CLOSED",
};

function sampleAction(projectId: string): DecisionActionDefinition {
  return {
    actionId: "action_create_objective",
    name: "Create objective",
    description: "Propose bounded objective from policy",
    actionClass: "CREATE_OBJECTIVE",
    requiredCapabilities: [],
    projectScope: [projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    estimatedResources: {},
    reversibility: "REVERSIBLE",
    riskClass: "LOW",
    executionPath: "OBJECTIVE",
    authorityRequirements: ["APPROVER"],
  };
}

async function seedDecisionPolicyAuthority(
  db: Stack["db"],
  projectId: string,
  grants: {
    approverId?: string;
    activatorId?: string;
  },
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  const seeds = [];
  if (grants.approverId) {
    seeds.push({
      principalId: grants.approverId,
      principalType: "DECISION_POLICY_APPROVER" as const,
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    });
  }
  if (grants.activatorId) {
    seeds.push({
      principalId: grants.activatorId,
      principalType: "DECISION_POLICY_ACTIVATOR" as const,
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    });
  }
  if (seeds.length > 0) {
    await authority.seed(seeds);
  }
}

/** Project-scoped objectives — canonical `objectives` table (Phase 1/11). */
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

/** Project-scoped Programs via canonical Phase 14 repository. */
async function countProgramsForProject(
  stack: Stack,
  projectId: string,
): Promise<number> {
  return (await stack.programs.listByProject(projectId)).length;
}

/** Project-scoped Portfolios via canonical Phase 15 repository. */
async function countPortfoliosForProject(
  stack: Stack,
  projectId: string,
): Promise<number> {
  return (await stack.portfolios.listByProject(projectId)).length;
}

/**
 * Project-scoped GovernedExperiments via canonical Phase 17 repository
 * (`governed_experiments` — not a fictional `experiments` table).
 */
async function countExperimentsForProject(
  stack: Stack,
  projectId: string,
): Promise<number> {
  const all = await stack.experiments.listByStates([...EXPERIMENT_STATES]);
  return all.filter((e) => e.projectId === projectId).length;
}

/**
 * ExecutionAttempts attributable to this project (json_documents collection,
 * joined through runs — attempts are not a standalone `execution_attempts` table).
 */
async function countExecutionAttemptsForProject(
  db: Stack["db"],
  projectId: string,
): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
     FROM json_documents d
     INNER JOIN runs r ON r.run_id = d.run_id
     WHERE d.collection = 'execution_attempts' AND r.project_id = $1`,
    [projectId],
  );
  return Number(rows.rows[0]?.c ?? 0);
}

async function snapshotDownstreamCounts(
  env: TestEnv,
  projectId: string,
): Promise<{
  objectives: number;
  programs: number;
  portfolios: number;
  experiments: number;
  executionAttempts: number;
}> {
  return {
    objectives: await countObjectivesForProject(env.db, projectId),
    programs: await countProgramsForProject(env.stack, projectId),
    portfolios: await countPortfoliosForProject(env.stack, projectId),
    experiments: await countExperimentsForProject(env.stack, projectId),
    executionAttempts: await countExecutionAttemptsForProject(
      env.db,
      projectId,
    ),
  };
}

function expectNoDownstreamGrowth(
  before: Awaited<ReturnType<typeof snapshotDownstreamCounts>>,
  after: Awaited<ReturnType<typeof snapshotDownstreamCounts>>,
): void {
  expect(after.objectives).toBe(before.objectives);
  expect(after.programs).toBe(before.programs);
  expect(after.portfolios).toBe(before.portfolios);
  expect(after.experiments).toBe(before.experiments);
  expect(after.executionAttempts).toBe(before.executionAttempts);
}

async function ladderThroughShadowApproval(
  env: TestEnv,
  service: DecisionPolicyOrchestrationService,
  projectId: string,
  approverId: string,
  nowIso: string,
) {
  env.seedDecisionStateDefault({
    variableId: SAMPLE_STATE_VARIABLE.variableId,
    value: 2.0,
    unit: "PERCENT",
    projectId,
    environment: EXAMPLE_ENVIRONMENT,
    observedAt: nowIso,
    sourceClass: "OBSERVATIONAL_DATA",
    quality: "PARTIAL",
    sourceHash: "hash_conv_p19",
  });
  const admitted = await service.admitContext({
    projectIds: [projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    stateVariables: [SAMPLE_STATE_VARIABLE],
    eligibleActions: [sampleAction(projectId)],
    optimizationObjectives: [
      {
        objectiveId: "obj_conversion",
        name: "Maximize conversion",
        direction: "MAXIMIZE",
        unit: "PERCENT",
        weight: 1,
      },
    ],
    riskTolerance: "MEDIUM",
    materialityThreshold: 1.0,
    timeHorizon: "14d",
    createdBy: EXAMPLE_REQUESTER_ID,
  });
  const synthesized = await service.synthesizePolicy({
    decisionContextId: admitted.context.decisionContextId,
    createdBy: EXAMPLE_REQUESTER_ID,
  });
  const policyId = synthesized.policy.decisionPolicyId;
  await service.validatePolicy(policyId);
  await service.evaluateOffline(policyId, [
    {
      caseId: "case_p19_1",
      stateValues: { [SAMPLE_STATE_VARIABLE.variableId]: 2.0 },
    },
  ]);
  const routed = await service.routeApproval(policyId);
  const approved = await service.decideApproval({
    decisionPolicyApprovalRequestId:
      routed.request.decisionPolicyApprovalRequestId,
    approverId,
    decision: "APPROVE_SHADOW",
    decisionNonce: routed.decisionNonce,
    submittedAt: routed.request.createdAt,
  });
  const shadow = await service.runShadowDecision({
    decisionPolicyId: policyId,
    environment: EXAMPLE_ENVIRONMENT,
  });
  const shadowEval = await service.evaluateShadow(policyId);
  return {
    admitted,
    synthesized,
    approved,
    shadow,
    shadowEval,
    policyId,
  };
}

describe("postgres phase19 decision policy optimization", () => {
  it("seeds DECISION_POLICY_APPROVER and ACTIVATOR via buildAuthoritySeeds", async () => {
    const env = await createTestStack(uniquePostgresTestId("p19-seed"));
    try {
      const projectId = `proj_p19_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isDecisionPolicyApproverEnabled(
          OPERATIONAL_APPROVER,
          projectId,
        ),
      ).toBe(true);
      expect(
        await authority.isDecisionPolicyActivatorEnabled(
          OPERATIONAL_APPROVER,
          projectId,
        ),
      ).toBe(true);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("primary ladder: shadow approval through recommendation creates zero downstream execution artifacts", async () => {
    const env = await createTestStack(uniquePostgresTestId("p19-ladder"));
    try {
      const projectId = `p19_ladder_${uniquePostgresTestId("p")}`;
      await seedDecisionPolicyAuthority(env.db, projectId, {
        approverId: POLICY_APPROVER_ONLY,
        activatorId: POLICY_ACTIVATOR_ONLY,
      });
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isDecisionPolicyApproverEnabled(
          POLICY_APPROVER_ONLY,
          projectId,
        ),
      ).toBe(true);
      expect(
        await authority.isDecisionPolicyActivatorEnabled(
          POLICY_ACTIVATOR_ONLY,
          projectId,
        ),
      ).toBe(true);
      expect(
        await authority.isDecisionPolicyActivatorEnabled(
          POLICY_APPROVER_ONLY,
          projectId,
        ),
      ).toBe(false);

      const before = await snapshotDownstreamCounts(env, projectId);

      const service = env.stack.decisionPolicyService;
      const nowIso = env.stack.clock.nowIso();
      const ladder = await ladderThroughShadowApproval(
        env,
        service,
        projectId,
        POLICY_APPROVER_ONLY,
        nowIso,
      );
      expect(ladder.approved.policy.status).toBe("APPROVED_FOR_SHADOW");
      expect(ladder.shadowEval.policy.status).toBe("AWAITING_ACTIVATION");

      // SHADOW mode: zero new Objectives / Programs / Portfolios / Experiments / attempts
      expectNoDownstreamGrowth(
        before,
        await snapshotDownstreamCounts(env, projectId),
      );

      const activationRouted = await service.routeActivation(ladder.policyId);
      const activated = await service.decideActivation({
        decisionPolicyActivationRequestId:
          activationRouted.request.decisionPolicyActivationRequestId,
        activatorId: POLICY_ACTIVATOR_ONLY,
        decision: "ACTIVATE",
        decisionNonce: activationRouted.decisionNonce,
        submittedAt: activationRouted.request.createdAt,
      });
      expect(activated.policy.status).toBe("ACTIVE");
      expect(activated.activation?.status).toBe("ACTIVE");

      const recommended = await service.recommend({
        decisionPolicyId: ladder.policyId,
        environment: EXAMPLE_ENVIRONMENT,
        hints: { [SAMPLE_STATE_VARIABLE.variableId]: 999 },
      });
      expect(recommended.recommendation.attribution.recommendedByPolicy).toBe(
        true,
      );
      expect(recommended.recommendation.attribution.executed).toBe(false);
      expect(recommended.materialization.kind).toBe("PERSISTED_ONLY");

      // ACTIVE recommendation before explicit materialize: still zero downstream side effects
      expectNoDownstreamGrowth(
        before,
        await snapshotDownstreamCounts(env, projectId),
      );
    } finally {
      await env.close();
    }
  }, 120_000);

  it("rejects live recommendation when policy is not ACTIVE", async () => {
    const env = await createTestStack(uniquePostgresTestId("p19-not-active"));
    try {
      const projectId = `p19_na_${uniquePostgresTestId("p")}`;
      await seedDecisionPolicyAuthority(env.db, projectId, {
        approverId: POLICY_APPROVER_ONLY,
      });
      const service = env.stack.decisionPolicyService;
      const nowIso = env.stack.clock.nowIso();
      const ladder = await ladderThroughShadowApproval(
        env,
        service,
        projectId,
        POLICY_APPROVER_ONLY,
        nowIso,
      );
      expect(ladder.approved.policy.status).toBe("APPROVED_FOR_SHADOW");

      await expect(
        service.recommend({
          decisionPolicyId: ladder.policyId,
          environment: EXAMPLE_ENVIRONMENT,
        }),
      ).rejects.toMatchObject({ code: "DECISION_POLICY_NOT_ACTIVE" });
    } finally {
      await env.close();
    }
  }, 120_000);

  it("rejects activation from DECISION_POLICY_APPROVER-only principal", async () => {
    const env = await createTestStack(uniquePostgresTestId("p19-auth"));
    try {
      const projectId = `p19_auth_${uniquePostgresTestId("p")}`;
      await seedDecisionPolicyAuthority(env.db, projectId, {
        approverId: POLICY_APPROVER_ONLY,
      });
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isDecisionPolicyApproverEnabled(
          POLICY_APPROVER_ONLY,
          projectId,
        ),
      ).toBe(true);
      expect(
        await authority.isDecisionPolicyActivatorEnabled(
          POLICY_APPROVER_ONLY,
          projectId,
        ),
      ).toBe(false);
      const service = env.stack.decisionPolicyService;
      const nowIso = env.stack.clock.nowIso();
      const ladder = await ladderThroughShadowApproval(
        env,
        service,
        projectId,
        POLICY_APPROVER_ONLY,
        nowIso,
      );
      const activationRouted = await service.routeActivation(ladder.policyId);
      await expect(
        service.decideActivation({
          decisionPolicyActivationRequestId:
            activationRouted.request.decisionPolicyActivationRequestId,
          activatorId: POLICY_APPROVER_ONLY,
          decision: "ACTIVATE",
          decisionNonce: activationRouted.decisionNonce,
          submittedAt: activationRouted.request.createdAt,
        }),
      ).rejects.toMatchObject({
        code: "DECISION_POLICY_ACTIVATOR_SCOPE_INSUFFICIENT",
      });
    } finally {
      await env.close();
    }
  }, 120_000);
});
