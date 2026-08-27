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
import {
  assumptionSetHash,
  withAssumptionSetHash,
  type ScenarioAssumption,
} from "../../scenarios/assumptions.js";
import {
  mintEvidenceRefId,
  mintSeededRandomizedEvidence,
  type CausalAdmissionRequest,
  type CausalEvidenceReference,
  type CausalOrchestrationService,
} from "../../causal/index.js";

type TestEnv = Awaited<ReturnType<typeof createTestStack>>;
type Stack = TestEnv["stack"];

const CAUSAL_REVIEWER_ONLY = "causal_reviewer_only_p18";
const OPERATIONAL_APPROVER = "approver_bootstrap";

const DEFAULT_BUDGET = {
  maximumGraphModelCalls: 10,
  maximumModelTokens: 10_000,
  maximumEstimators: 5,
  maximumSynthesisOperations: 5,
} as const;

const SAMPLE_ASSUMPTIONS: ScenarioAssumption[] = [
  {
    assumptionId: "asm_p18_conversion",
    name: "Conversion prior",
    description: "Baseline conversion effect prior",
    value: 1,
    unit: "RATIO",
    sourceClass: "ASSUMPTION",
    confidenceClassification: "MEDIUM",
    sensitivityEligible: true,
    materiality: "HIGH",
  },
];

async function seedCausalReviewerAuthority(
  db: Parameters<typeof seedDedicatedPostgresTestProject>[0],
  projectId: string,
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  await authority.seed([
    {
      principalId: CAUSAL_REVIEWER_ONLY,
      principalType: "CAUSAL_REVIEWER",
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    },
  ]);
}

function sampleAdmission(
  projectId: string,
  overrides?: Partial<CausalAdmissionRequest>,
): CausalAdmissionRequest {
  return {
    projectIds: [projectId],
    intervention: "enable_feature_flag_x",
    outcome: "conversion_rate",
    interventionUnit: "DIMENSIONLESS",
    outcomeUnit: "PERCENT",
    targetPopulation: "users_us_west",
    targetEnvironment: EXAMPLE_ENVIRONMENT,
    timeHorizon: "14d",
    candidateConfounders: ["prior_engagement"],
    businessDecisionContext: "Decide whether to expand flag rollout",
    materialityThreshold: 1.0,
    budgetEnvelope: { ...DEFAULT_BUDGET },
    createdBy: EXAMPLE_REQUESTER_ID,
    ...overrides,
  };
}

function observationalEvidence(
  projectId: string,
  createdAt: string,
): CausalEvidenceReference {
  const evidenceHash = "eh_p18_observational";
  const sourceId = "obs_metric_p18";
  return {
    evidenceRefId: mintEvidenceRefId({
      sourceClass: "OBSERVATIONAL_METRIC",
      sourceId,
      evidenceHash,
    }),
    sourceClass: "OBSERVATIONAL_METRIC",
    sourceId,
    sourceVersion: "1",
    evidenceHash,
    projectId,
    populationScope: "users_us_west",
    environmentScope: EXAMPLE_ENVIRONMENT,
    timeRange: "30d",
    quality: "PARTIAL",
    evidenceDesign: "OBSERVATIONAL",
    verificationRefs: [],
    createdAt,
  };
}

async function countPolicyBundles(db: Stack["db"]): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM policy_bundles`,
  );
  return Number(rows.rows[0]?.c ?? 0);
}

async function ladderToPromoted(
  env: TestEnv,
  projectId: string,
  reviewerId: string,
) {
  const experimentId = `exp_p18_${projectId}`;
  env.seedCausalAuthoritativeEvidence(
    mintSeededRandomizedEvidence({
      experimentId,
      projectId,
      environment: EXAMPLE_ENVIRONMENT,
      outcomeUnit: "PERCENT",
    }),
  );
  const service: CausalOrchestrationService = env.stack.causalService;
  const admitted = await service.admit(
    sampleAdmission(projectId, { sourceExperimentIds: [experimentId] }),
  );
  const id = admitted.question.causalQuestionId;
  await service.proposeGraph(id);
  await service.identify(id);
  await service.estimate(id);
  await service.synthesize(id);
  await service.validate(id);
  const routed = await service.routeReview(id);
  const decided = await service.decideReview({
    reviewRequestId: routed.request.reviewRequestId,
    reviewerId,
    decision: "PROMOTE",
    decisionNonce: routed.decisionNonce,
    submittedAt: routed.request.createdAt,
  });
  const calibration = await service.createCalibrationCandidate({
    promotedCausalClaimId: decided.promoted!.promotedCausalClaimId,
  });
  return { id, admitted, decided, routed, calibration };
}

describe("postgres phase18 causal intelligence", () => {
  it("admits a causal question and grants CAUSAL_REVIEWER via seed", async () => {
    const env = await createTestStack(uniquePostgresTestId("p18"));
    try {
      const projectId = `proj_p18_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isCausalReviewerEnabled(
          "approver_bootstrap",
          projectId,
        ),
      ).toBe(true);

      const admitted = await env.stack.causalService.admit(
        sampleAdmission(projectId),
      );
      expect(admitted.question.status).toBe("ADMITTED");
      expect(admitted.question.projectIds).toEqual([projectId]);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("primary ladder: causal review promotion leaves AssumptionSet and policy unchanged", async () => {
    const env = await createTestStack(uniquePostgresTestId("p18-ladder"));
    try {
      const projectId = `p18_ladder_${uniquePostgresTestId("p")}`;
      await seedCausalReviewerAuthority(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isCausalReviewerEnabled(CAUSAL_REVIEWER_ONLY, projectId),
      ).toBe(true);
      expect(
        await authority.isApproverEnabled(CAUSAL_REVIEWER_ONLY, projectId),
      ).toBe(false);
      expect(
        await authority.isApproverEnabled(OPERATIONAL_APPROVER, projectId),
      ).toBe(true);

      const asmSet = withAssumptionSetHash(SAMPLE_ASSUMPTIONS);
      const assumptionHashBefore = assumptionSetHash(SAMPLE_ASSUMPTIONS);
      expect(asmSet.assumptionSetHash).toBe(assumptionHashBefore);

      const policyBefore = (
        await env.stack.controlPlane.resolve(projectId, EXAMPLE_ENVIRONMENT)
      ).activePolicyBundle.policyHash;
      const policyCountBefore = await countPolicyBundles(env.db);

      const { decided, calibration } = await ladderToPromoted(
        env,
        projectId,
        CAUSAL_REVIEWER_ONLY,
      );
      expect(decided.question.status).toBe("PROMOTED");
      expect(decided.promoted?.promotedBy).toBe(CAUSAL_REVIEWER_ONLY);
      expect(decided.promoted?.status).toBe("ACTIVE");
      expect(calibration.requiresPhase16Reanalysis).toBe(true);
      expect(calibration.promotedCausalClaimId).toBe(
        decided.promoted!.promotedCausalClaimId,
      );

      expect(assumptionSetHash(SAMPLE_ASSUMPTIONS)).toBe(assumptionHashBefore);
      expect(asmSet.assumptionSetHash).toBe(assumptionHashBefore);

      const policyAfter = (
        await env.stack.controlPlane.resolve(projectId, EXAMPLE_ENVIRONMENT)
      ).activePolicyBundle.policyHash;
      expect(policyAfter).toBe(policyBefore);
      const policyCountAfter = await countPolicyBundles(env.db);
      expect(policyCountAfter - policyCountBefore).toBe(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("accepts non-identification with OBSERVATIONAL evidence", async () => {
    const env = await createTestStack(uniquePostgresTestId("p18-obs"));
    try {
      const projectId = `p18_obs_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);
      const nowIso = env.stack.clock.nowIso();
      const service = env.stack.causalService;

      const admitted = await service.admit(
        sampleAdmission(projectId, {
          intervention: "obs_only_flag",
          outcome: "obs_metric",
        }),
      );
      const id = admitted.question.causalQuestionId;
      await service.proposeGraph(id);
      await service.attachEvidence(id, [
        observationalEvidence(projectId, nowIso),
      ]);
      const identified = await service.identify(id);
      expect(identified.analysis.status).toBe("NOT_IDENTIFIED");
      expect(identified.question.status).toBe("INCONCLUSIVE");
      expect(identified.evidenceGap?.mayFeedPhase17ActiveLearning).toBe(true);
      expect(identified.evidenceGap?.doesNotAuthorizeExperiment).toBe(true);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("rejects promote from APPROVER-only principal", async () => {
    const env = await createTestStack(uniquePostgresTestId("p18-auth"));
    try {
      const projectId = `p18_auth_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      await authority.seed([
        {
          principalId: "approver_only",
          principalType: "APPROVER",
          projectId,
          environments: [EXAMPLE_ENVIRONMENT],
        },
      ]);
      expect(
        await authority.isCausalReviewerEnabled("approver_only", projectId),
      ).toBe(false);
      expect(await authority.isApproverEnabled("approver_only", projectId)).toBe(
        true,
      );

      const experimentId = `exp_auth_${projectId}`;
      env.seedCausalAuthoritativeEvidence(
        mintSeededRandomizedEvidence({
          experimentId,
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
        }),
      );
      const service = env.stack.causalService;
      const admitted = await service.admit(
        sampleAdmission(projectId, {
          intervention: "auth_isolation_flag",
          outcome: "auth_metric",
          sourceExperimentIds: [experimentId],
        }),
      );
      const id = admitted.question.causalQuestionId;
      await service.proposeGraph(id);
      await service.identify(id);
      await service.estimate(id);
      await service.synthesize(id);
      await service.validate(id);
      const routed = await service.routeReview(id);

      await expect(
        service.decideReview({
          reviewRequestId: routed.request.reviewRequestId,
          reviewerId: "approver_only",
          decision: "PROMOTE",
          decisionNonce: routed.decisionNonce,
          submittedAt: routed.request.createdAt,
        }),
      ).rejects.toMatchObject({ code: "CAUSAL_REVIEWER_SCOPE_INSUFFICIENT" });
    } finally {
      await env.close();
    }
  }, 60_000);
});
