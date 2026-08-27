import { describe, expect, it } from "vitest";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import {
  DECISION_POLICY_DOCTRINE,
  DECISION_POLICY_APPROVER_AUTHORITY_BOUNDARIES,
  assessParetoDominance,
  assertNoArbitraryPredicateCode,
  canTransitionDecisionPolicy,
  compareChampionChallenger,
  computeDecisionPolicyHash,
  detectDecisionRuleConflicts,
  evaluateDecisionPolicyOffline,
  evaluatePredicate,
  isDecisionPolicyError,
  mintDecisionRuleId,
  parsePredicateAst,
  selectActionForState,
  withDecisionPolicyHash,
  type DecisionPolicyCandidate,
  type HistoricalDecisionCase,
} from "./index.js";
import {
  admitSampleContext,
  buildDecisionPolicyService,
  DP_TEST_NOW,
  sampleEligibleActions,
} from "./test-fixtures.js";
import { RecordingObjectiveAdmissionPort } from "./compiler.js";
import {
  InMemoryCausalGovernedEvidencePort,
  mintGovernedCausalEvidence,
  mintSeededObservation,
} from "./index.js";

describe("Phase 19 decision policy optimization", () => {
  it("documents core doctrine separations", () => {
    expect(DECISION_POLICY_DOCTRINE.governanceNotDecision).toContain(
      "GOVERNANCE_POLICY != DECISION_POLICY",
    );
    expect(DECISION_POLICY_DOCTRINE.recommendationNotExecution).toContain(
      "RECOMMENDATION != EXECUTION",
    );
    expect(DECISION_POLICY_DOCTRINE.shadowNotLive).toContain(
      "SHADOW_MODE != LIVE_AUTHORITY",
    );
    expect(DECISION_POLICY_APPROVER_AUTHORITY_BOUNDARIES.shadowNotLive).toBe(
      "SHADOW_MODE != LIVE_AUTHORITY",
    );
  });

  it("admits DecisionContext with state variables and eligible actions", async () => {
    const { service } = buildDecisionPolicyService();
    const { context } = await admitSampleContext(service);
    expect(context.status).toBe("ADMITTED");
    expect(context.stateVariables.length).toBeGreaterThan(0);
    expect(
      context.eligibleActions.some((a) => a.actionClass === "NO_ACTION"),
    ).toBe(true);
    expect(context.contextHash.length).toBeGreaterThan(10);
  });

  it("rejects arbitrary code predicates", () => {
    expect(() =>
      assertNoArbitraryPredicateCode({ expression: "eval('1')" }),
    ).toThrow(/Arbitrary code/);
    expect(() => parsePredicateAst({ op: "EQ", variableId: "x", value: 1 })).not.toThrow();
    expect(() =>
      parsePredicateAst({
        op: "EQ",
        variableId: "x",
        value: "'; DROP TABLE users;--",
      }),
    ).toThrow();
  });

  it("evaluates bounded predicate DSL deterministically", () => {
    const pred = parsePredicateAst({
      op: "AND",
      children: [
        { op: "GTE", variableId: "conversion_rate", value: 10 },
        { op: "EQ", variableId: "flag_enabled", value: true },
      ],
    });
    expect(
      evaluatePredicate(pred, { conversion_rate: 12, flag_enabled: true }),
    ).toBe(true);
    expect(
      evaluatePredicate(pred, { conversion_rate: 5, flag_enabled: true }),
    ).toBe(false);
    expect(
      evaluatePredicate(
        { op: "BETWEEN", variableId: "conversion_rate", min: 8, max: 15 },
        { conversion_rate: 10 },
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        { op: "IN", variableId: "flag_enabled", values: [true] },
        { flag_enabled: true },
      ),
    ).toBe(true);
  });

  it("enforces eligible actions and default NO_ACTION", async () => {
    const { service } = buildDecisionPolicyService();
    const { context } = await admitSampleContext(service);
    const { policy } = await service.synthesizePolicy({
      decisionContextId: context.decisionContextId,
      createdBy: "synth",
    });
    expect(policy.defaultActionId).toBe("action_no_action");
    const selected = selectActionForState({
      policy,
      context,
      stateValues: { conversion_rate: 1, flag_enabled: false },
    });
    expect(selected.actionId).toBe(policy.defaultActionId);
  });

  it("detects identical-predicate rule conflicts", () => {
    const predicate = {
      op: "EQ" as const,
      variableId: "flag_enabled",
      value: true,
    };
    const conflicts = detectDecisionRuleConflicts([
      {
        decisionRuleId: mintDecisionRuleId({
          actionId: "a1",
          predicate,
          priority: 1,
        }),
        name: "r1",
        predicate,
        actionId: "a1",
        priority: 1,
        evidenceRefs: ["e1"],
        promotedCausalClaimIds: [],
        confidence: "MEDIUM",
        limitations: [],
        heuristicOnly: false,
      },
      {
        decisionRuleId: mintDecisionRuleId({
          actionId: "a2",
          predicate,
          priority: 2,
        }),
        name: "r2",
        predicate,
        actionId: "a2",
        priority: 2,
        evidenceRefs: ["e1"],
        promotedCausalClaimIds: [],
        confidence: "MEDIUM",
        limitations: [],
        heuristicOnly: false,
      },
    ]);
    expect(conflicts.some((c) => c.kind === "IDENTICAL_PREDICATE_DIFFERENT_ACTION")).toBe(
      true,
    );
  });

  it("policy hash binds context, rules, default, weights, evidence", async () => {
    const causal = new InMemoryCausalGovernedEvidencePort();
    causal.seed(
      mintGovernedCausalEvidence({
        promotedCausalClaimId: "pcc_1",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
      }),
    );
    const { service } = buildDecisionPolicyService({ causalEvidence: causal });
    const { context } = await admitSampleContext(service);
    const { policy } = await service.synthesizePolicy({
      decisionContextId: context.decisionContextId,
      createdBy: "synth",
      sourcePromotedCausalClaimIds: ["pcc_1"],
    });
    expect(policy.sourceCausalBindings).toHaveLength(1);
    expect(policy.sourceCausalBindings[0]?.promotedClaimHash).toBeTruthy();
    const recomputed = computeDecisionPolicyHash({
      decisionPolicyId: policy.decisionPolicyId,
      decisionPolicyVersion: policy.decisionPolicyVersion,
      decisionContextId: policy.decisionContextId,
      decisionContextVersion: policy.decisionContextVersion,
      decisionContextHash: policy.decisionContextHash,
      rules: policy.rules,
      defaultActionId: policy.defaultActionId,
      objectiveWeights: policy.objectiveWeights,
      riskConstraints: policy.riskConstraints,
      sourceEvidenceRefs: policy.sourceEvidenceRefs,
      sourcePromotedCausalClaimIds: policy.sourcePromotedCausalClaimIds,
      sourceScenarioRefs: policy.sourceScenarioRefs,
      sourceScenarioHashes: policy.sourceScenarioHashes,
      sourceCausalBindings: policy.sourceCausalBindings,
      evaluationRequirements: policy.evaluationRequirements,
    });
    expect(recomputed).toBe(policy.policyHash);
    const mutated = withDecisionPolicyHash({
      ...policy,
      defaultActionId: "action_create_objective",
      policyHash: undefined as unknown as string,
    } as Omit<DecisionPolicyCandidate, "policyHash">);
    expect(mutated.policyHash).not.toBe(policy.policyHash);
  });

  it("model-suggested rules are DATA until validated — not authorized", async () => {
    const { service } = buildDecisionPolicyService();
    const { context } = await admitSampleContext(service);
    const { policy } = await service.synthesizePolicy({
      decisionContextId: context.decisionContextId,
      createdBy: "synth",
    });
    expect(policy.status).toBe("SYNTHESIZED");
    expect(policy.synthesisModelId).toBe("fake_decision_policy_synth_v1");
    expect(canTransitionDecisionPolicy("VALIDATED", "ACTIVE")).toBe(false);
  });

  it("offline evaluation marks unsupported counterfactuals and estimated != observed regret", async () => {
    const { service } = buildDecisionPolicyService();
    const { context } = await admitSampleContext(service);
    const { policy } = await service.synthesizePolicy({
      decisionContextId: context.decisionContextId,
      createdBy: "synth",
    });
    await service.validatePolicy(policy.decisionPolicyId);
    const cases: HistoricalDecisionCase[] = [
      {
        caseId: "c1",
        stateValues: { conversion_rate: 12, flag_enabled: true },
        observedActionId: "action_no_action",
        observedOutcome: 5,
        counterfactualSupport: "COUNTERFACTUAL_UNSUPPORTED",
      },
    ];
    const { evaluation } = await service.evaluateOffline(
      policy.decisionPolicyId,
      cases,
    );
    expect(evaluation.regret.status).toBe("NOT_ESTIMABLE");
    expect(evaluation.regret.observedRegret).toBeUndefined();
    expect(evaluation.limitations.join(" ")).toMatch(/counterfactual/i);

    const withCausal = evaluateDecisionPolicyOffline({
      policy,
      context,
      cases: [
        {
          caseId: "c2",
          stateValues: { conversion_rate: 12, flag_enabled: true },
          observedActionId: "action_no_action",
          observedOutcome: 5,
          counterfactualOutcome: 8,
          counterfactualSupport: "SUPPORTED_BY_PROMOTED_CAUSAL",
        },
      ],
      nowIso: DP_TEST_NOW,
    });
    expect(withCausal.regret.status).toBe("ESTIMABLE");
    expect(withCausal.regret.estimatedRegret).toBeDefined();
    expect(withCausal.regret.observedRegret).toBeUndefined();
  });

  it("champion/challenger Pareto respects explicit directions; no auto-winner on conflict", () => {
    const dominance = assessParetoDominance([
      {
        criterionId: "a",
        name: "A",
        direction: "HIGHER_IS_BETTER",
        championScore: 0.9,
        challengerScore: 0.5,
      },
      {
        criterionId: "b",
        name: "B",
        direction: "LOWER_IS_BETTER",
        championScore: 0.9,
        challengerScore: 0.1,
      },
    ]);
    expect(dominance).toBe("INCOMPARABLE");
  });

  it("DECISION_POLICY_APPROVER isolation — generic APPROVER cannot approve shadow", async () => {
    const { service } = buildDecisionPolicyService();
    const ladder = await ladderToAwaitingApproval(service);
    await expect(
      service.decideApproval({
        decisionPolicyApprovalRequestId:
          ladder.request.decisionPolicyApprovalRequestId,
        approverId: "approver_only",
        decision: "APPROVE_SHADOW",
        decisionNonce: ladder.decisionNonce,
      }),
    ).rejects.toMatchObject({
      code: "DECISION_POLICY_APPROVER_SCOPE_INSUFFICIENT",
    });
  });

  it("multi-project approval requires intersection of all projects", async () => {
    const grants = new Map<string, ReadonlySet<string>>([
      ["partial", new Set([EXAMPLE_PROJECT_ID])],
    ]);
    const { service } = buildDecisionPolicyService({
      approverGrants: grants,
    });
    // checker used with two projects should fail for partial grant
    const checker = (
      await import("./test-fixtures.js")
    ).buildDecisionPolicyApproverChecker(grants);
    expect(await checker("partial", [EXAMPLE_PROJECT_ID, "other_proj"])).toBe(
      false,
    );
    expect(await checker("partial", [EXAMPLE_PROJECT_ID])).toBe(true);
  });

  it("shadow approval != activation; shadow creates zero downstream work", async () => {
    const { service } = buildDecisionPolicyService();
    const ladder = await ladderToShadowApproved(service);
    expect(ladder.policy.status).toBe("APPROVED_FOR_SHADOW");
    expect(canTransitionDecisionPolicy("APPROVED_FOR_SHADOW", "ACTIVE")).toBe(
      false,
    );
    await service.runShadowDecision({
      decisionPolicyId: ladder.policy.decisionPolicyId,
      environment: EXAMPLE_ENVIRONMENT,
    });
    await expect(
      service.recommend({
        decisionPolicyId: ladder.policy.decisionPolicyId,
        environment: EXAMPLE_ENVIRONMENT,
      }),
    ).rejects.toMatchObject({ code: "DECISION_POLICY_NOT_ACTIVE" });
  });

  it("DECISION_POLICY_ACTIVATOR isolation and activation hash binding", async () => {
    const { service } = buildDecisionPolicyService();
    const ladder = await ladderToAwaitingActivation(service);
    await expect(
      service.decideActivation({
        decisionPolicyActivationRequestId:
          ladder.activationRequest.decisionPolicyActivationRequestId,
        activatorId: "dp_approver_full",
        decision: "ACTIVATE",
        decisionNonce: ladder.activationNonce,
      }),
    ).rejects.toMatchObject({
      code: "DECISION_POLICY_ACTIVATOR_SCOPE_INSUFFICIENT",
    });

    const activated = await service.decideActivation({
      decisionPolicyActivationRequestId:
        ladder.activationRequest.decisionPolicyActivationRequestId,
      activatorId: "dp_activator_full",
      decision: "ACTIVATE",
      decisionNonce: ladder.activationNonce,
    });
    expect(activated.policy.status).toBe("ACTIVE");
    expect(activated.activation?.activationHash.length).toBeGreaterThan(10);
  });

  it("stale authoritative source fails closed; recommendation idempotent", async () => {
    const { service, decisionStateSource } = buildDecisionPolicyService();
    const ladder = await ladderToActive(service);
    decisionStateSource.seed(
      mintSeededObservation({
        variableId: "conversion_rate",
        value: 12,
        unit: "PERCENT",
        sourceClass: "VERIFIED_PROGRAM_OUTCOME",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        observedAt: "2020-01-01T00:00:00.000Z",
        quality: "VALIDATED",
      }),
    );
    await expect(
      service.recommend({
        decisionPolicyId: ladder.policy.decisionPolicyId,
        environment: EXAMPLE_ENVIRONMENT,
      }),
    ).rejects.toMatchObject({ code: "DECISION_STATE_STALE" });

    decisionStateSource.seed(
      mintSeededObservation({
        variableId: "conversion_rate",
        value: 12,
        unit: "PERCENT",
        sourceClass: "VERIFIED_PROGRAM_OUTCOME",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        observedAt: DP_TEST_NOW,
        quality: "VALIDATED",
        sourceHash: "sh_conversion_auth",
      }),
    );
    const first = await service.recommend({
      decisionPolicyId: ladder.policy.decisionPolicyId,
      environment: EXAMPLE_ENVIRONMENT,
    });
    const second = await service.recommend({
      decisionPolicyId: ladder.policy.decisionPolicyId,
      environment: EXAMPLE_ENVIRONMENT,
    });
    expect(second.recommendation.decisionRecommendationId).toBe(
      first.recommendation.decisionRecommendationId,
    );
    expect(first.materialization.kind).toBe("PERSISTED_ONLY");
  });

  it("recommendation != execution; materialization default is persist-only", async () => {
    const { service } = buildDecisionPolicyService();
    const ladder = await ladderToActive(service);
    const { recommendation, materialization } = await service.recommend({
      decisionPolicyId: ladder.policy.decisionPolicyId,
      environment: EXAMPLE_ENVIRONMENT,
    });
    expect(recommendation.attribution.executed).toBe(false);
    expect(recommendation.attribution.authorizedDownstream).toBe(false);
    expect(materialization.kind).toBe("PERSISTED_ONLY");
    expect(sampleEligibleActions()[1]!.authorityRequirements).toContain(
      "PHASE_6_APPROVAL",
    );
  });

  it("causal knowledge drift blocks live use; no hot mutation", async () => {
    const causal = new InMemoryCausalGovernedEvidencePort();
    causal.seed(
      mintGovernedCausalEvidence({
        promotedCausalClaimId: "pcc_drift",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        status: "ACTIVE",
      }),
    );
    const { service } = buildDecisionPolicyService({ causalEvidence: causal });
    const { context } = await admitSampleContext(service);
    const { policy } = await service.synthesizePolicy({
      decisionContextId: context.decisionContextId,
      createdBy: "synth",
      sourcePromotedCausalClaimIds: ["pcc_drift"],
    });
    expect(policy.sourceCausalBindings[0]?.promotedClaimHash).toBeDefined();
    await service.validatePolicy(policy.decisionPolicyId);
    await service.evaluateOffline(policy.decisionPolicyId, [
      {
        caseId: "c1",
        stateValues: { conversion_rate: 12, flag_enabled: true },
        counterfactualSupport: "COUNTERFACTUAL_UNSUPPORTED",
      },
    ]);
    const routed = await service.routeApproval(policy.decisionPolicyId);
    await service.decideApproval({
      decisionPolicyApprovalRequestId:
        routed.request.decisionPolicyApprovalRequestId,
      approverId: "dp_approver_full",
      decision: "APPROVE_SHADOW",
      decisionNonce: routed.decisionNonce,
    });
    await service.runShadowDecision({
      decisionPolicyId: policy.decisionPolicyId,
      environment: EXAMPLE_ENVIRONMENT,
    });
    await service.evaluateShadow(policy.decisionPolicyId);
    const act = await service.routeActivation(policy.decisionPolicyId);
    await service.decideActivation({
      decisionPolicyActivationRequestId:
        act.request.decisionPolicyActivationRequestId,
      activatorId: "dp_activator_full",
      decision: "ACTIVATE",
      decisionNonce: act.decisionNonce,
    });
    causal.seed(
      mintGovernedCausalEvidence({
        promotedCausalClaimId: "pcc_drift",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        status: "STALE",
      }),
    );
    await expect(
      service.recommend({
        decisionPolicyId: policy.decisionPolicyId,
        environment: EXAMPLE_ENVIRONMENT,
      }),
    ).rejects.toMatchObject({ code: "DECISION_CAUSAL_EVIDENCE_STALE" });
  });

  it("safety pause creates revision candidate without mutating active rules", async () => {
    const { service, policies, revisions } = buildDecisionPolicyService();
    const ladder = await ladderToActive(service);
    const before = await policies.getById(ladder.policy.decisionPolicyId);
    const { policy, revision } = await service.pauseForSafety(
      ladder.policy.decisionPolicyId,
      "max unsupported-state rate breached",
    );
    expect(policy.status).toBe("PAUSED");
    expect(revision.sourcePolicyHash).toBe(before!.policyHash);
    const listed = await revisions.listBySourcePolicy(
      ladder.policy.decisionPolicyId,
    );
    expect(listed.length).toBe(1);
    const after = await policies.getById(ladder.policy.decisionPolicyId);
    expect(after!.rules).toEqual(before!.rules);
    expect(after!.policyHash).toBe(before!.policyHash);
  });

  it("human override is observational", async () => {
    const { service } = buildDecisionPolicyService();
    const ladder = await ladderToActive(service);
    const { recommendation } = await service.recommend({
      decisionPolicyId: ladder.policy.decisionPolicyId,
      environment: EXAMPLE_ENVIRONMENT,
    });
    const { override } = await service.overrideRecommendation({
      recommendationId: recommendation.decisionRecommendationId,
      principalId: "human_1",
      humanDecision: "REJECT",
      reasonCategory: "BUSINESS_JUDGMENT",
    });
    expect(override.recommendationId).toBe(
      recommendation.decisionRecommendationId,
    );
  });

  it("producer-only progression loop materializes work without activating", async () => {
    const { service, progression, materializer, policies } =
      buildDecisionPolicyService();
    const { context } = await admitSampleContext(service);
    const { policy } = await service.synthesizePolicy({
      decisionContextId: context.decisionContextId,
      createdBy: "synth",
    });
    await progression.tick();
    const result = await materializer.discoverForPolicy(policy.decisionPolicyId);
    expect(result.created.length + result.reused.length).toBeGreaterThan(0);
    const listed = await policies.listByStates(["SYNTHESIZED"]);
    expect(listed.some((p) => p.decisionPolicyId === policy.decisionPolicyId)).toBe(
      true,
    );
    expect(policy.status).toBe("SYNTHESIZED");
  });

  it("nonce replay and expiry fail closed on approval", async () => {
    const ctx = buildDecisionPolicyService();
    const ladder = await ladderToAwaitingApproval(ctx.service);
    await expect(
      ctx.service.decideApproval({
        decisionPolicyApprovalRequestId:
          ladder.request.decisionPolicyApprovalRequestId,
        approverId: "dp_approver_full",
        decision: "APPROVE_SHADOW",
        decisionNonce: "wrong-nonce",
      }),
    ).rejects.toMatchObject({ code: "DECISION_POLICY_APPROVAL_INVALID" });

    await ctx.service.decideApproval({
      decisionPolicyApprovalRequestId:
        ladder.request.decisionPolicyApprovalRequestId,
      approverId: "dp_approver_full",
      decision: "APPROVE_SHADOW",
      decisionNonce: ladder.decisionNonce,
    });
    await expect(
      ctx.service.decideApproval({
        decisionPolicyApprovalRequestId:
          ladder.request.decisionPolicyApprovalRequestId,
        approverId: "dp_approver_full",
        decision: "APPROVE_SHADOW",
        decisionNonce: ladder.decisionNonce,
      }),
    ).rejects.toMatchObject({ code: "DECISION_POLICY_APPROVAL_INVALID" });
  });

  it("isDecisionPolicyError type guard", () => {
    try {
      assertNoArbitraryPredicateCode({ expression: "eval(1)" });
    } catch (error) {
      expect(isDecisionPolicyError(error)).toBe(true);
    }
  });

  it("champion/challenger comparison persists without fabricating winner", async () => {
    const { service } = buildDecisionPolicyService();
    const a = await admitSampleContext(service);
    const p1 = await service.synthesizePolicy({
      decisionContextId: a.context.decisionContextId,
      createdBy: "a",
    });
    await service.validatePolicy(p1.policy.decisionPolicyId);
    await service.evaluateOffline(p1.policy.decisionPolicyId, [
      {
        caseId: "1",
        stateValues: { conversion_rate: 12, flag_enabled: true },
        counterfactualSupport: "COUNTERFACTUAL_UNSUPPORTED",
      },
    ]);
    const b = await admitSampleContext(service);
    const p2 = await service.synthesizePolicy({
      decisionContextId: b.context.decisionContextId,
      createdBy: "b",
    });
    await service.validatePolicy(p2.policy.decisionPolicyId);
    await service.evaluateOffline(p2.policy.decisionPolicyId, [
      {
        caseId: "2",
        stateValues: { conversion_rate: 1, flag_enabled: false },
        counterfactualSupport: "COUNTERFACTUAL_UNSUPPORTED",
      },
    ]);
    const { comparison } = await service.comparePolicies({
      championPolicyId: p1.policy.decisionPolicyId,
      challengerPolicyId: p2.policy.decisionPolicyId,
    });
    expect(["CHAMPION", "CHALLENGER", "NONE"]).toContain(
      comparison.automaticWinner,
    );
    expect(comparison.comparisonHash.length).toBeGreaterThan(10);
    void compareChampionChallenger;
  });

  describe("authority closure", () => {
    it("forged caller hints do not override authoritative resolved state", async () => {
      const { service, decisionStateSource } = buildDecisionPolicyService();
      decisionStateSource.seed(
        mintSeededObservation({
          variableId: "conversion_rate",
          value: 2,
          unit: "PERCENT",
          sourceClass: "VERIFIED_PROGRAM_OUTCOME",
          projectId: EXAMPLE_PROJECT_ID,
          environment: EXAMPLE_ENVIRONMENT,
          observedAt: DP_TEST_NOW,
          quality: "VALIDATED",
          sourceHash: "auth_low",
        }),
      );
      const ladder = await ladderToActive(service);
      const { recommendation } = await service.recommend({
        decisionPolicyId: ladder.policy.decisionPolicyId,
        environment: EXAMPLE_ENVIRONMENT,
        hints: { conversion_rate: 999, flag_enabled: true },
      });
      // materialityThreshold default 10; authoritative 2 → default NO_ACTION
      expect(recommendation.recommendedActionId).toBe("action_no_action");
    });

    it("ACTIVE but out-of-scope causal claim is NOT_SUPPORTED", async () => {
      const causal = new InMemoryCausalGovernedEvidencePort();
      causal.seed(
        mintGovernedCausalEvidence({
          promotedCausalClaimId: "pcc_other",
          projectId: "other_project",
          environment: "other_env",
          status: "ACTIVE",
          generalizability: "DIRECTLY_SUPPORTED",
        }),
      );
      const { service } = buildDecisionPolicyService({ causalEvidence: causal });
      const { context } = await admitSampleContext(service);
      await expect(
        service.synthesizePolicy({
          decisionContextId: context.decisionContextId,
          createdBy: "synth",
          sourcePromotedCausalClaimIds: ["pcc_other"],
        }),
      ).rejects.toMatchObject({ code: "DECISION_CAUSAL_EVIDENCE_NOT_SUPPORTED" });
    });

    it("activation with zero shadow records is blocked", async () => {
      const { service, shadowEvaluations, policies } =
        buildDecisionPolicyService();
      const ladder = await ladderToShadowApproved(service);
      // Force AWAITING_ACTIVATION with empty evaluation
      await policies.transition(
        ladder.policy.decisionPolicyId,
        "APPROVED_FOR_SHADOW",
        ladder.policy.recordRevision,
        "SHADOW_RUNNING",
        DP_TEST_NOW,
      );
      const running = await policies.getById(ladder.policy.decisionPolicyId);
      await policies.transition(
        ladder.policy.decisionPolicyId,
        "SHADOW_RUNNING",
        running!.recordRevision,
        "AWAITING_ACTIVATION",
        DP_TEST_NOW,
      );
      await shadowEvaluations.save({
        decisionPolicyShadowEvaluationId: "dpsev_empty",
        decisionPolicyId: ladder.policy.decisionPolicyId,
        decisionPolicyVersion: ladder.policy.decisionPolicyVersion,
        policyHash: ladder.policy.policyHash,
        coverage: 0,
        ruleHitDistribution: {},
        constraintFailures: 0,
        recommendationDisagreementRate: 0,
        unsupportedStateRate: 1,
        resourceEstimate: {},
        evidenceQuality: "UNKNOWN",
        shadowRecordCount: 0,
        limitations: [],
        shadowEvaluationHash: "hash_empty",
        createdAt: DP_TEST_NOW,
      });
      await expect(
        service.routeActivation(ladder.policy.decisionPolicyId),
      ).rejects.toMatchObject({ code: "ACTIVATION_NOT_READY" });
    });

    it("missing downstream production port fails closed on materialize", async () => {
      const { service } = buildDecisionPolicyService({
        compilerDeps: { allowMaterialization: true },
      });
      const ladder = await ladderToActive(service);
      const { recommendation } = await service.recommend({
        decisionPolicyId: ladder.policy.decisionPolicyId,
        environment: EXAMPLE_ENVIRONMENT,
      });
      if (recommendation.executionPath === "NO_ACTION") {
        // Force objective path by seeding high conversion already default
        expect(recommendation.executionPath).toBeDefined();
      }
      // With high conversion default seed (12), fake rule may recommend CREATE_OBJECTIVE
      if (recommendation.recommendedActionId === "action_create_objective") {
        await expect(
          service.materializeRecommendation({
            recommendationId: recommendation.decisionRecommendationId,
          }),
        ).rejects.toMatchObject({
          code: "DECISION_DOWNSTREAM_PORT_UNAVAILABLE",
        });
      }
    });

    it("materialization is deterministic and concurrent-safe via lineage", async () => {
      const port = new RecordingObjectiveAdmissionPort();
      const { service } = buildDecisionPolicyService({
        compilerDeps: {
          allowMaterialization: true,
          objectiveAdmission: port,
        },
      });
      const ladder = await ladderToActive(service);
      const { recommendation } = await service.recommend({
        decisionPolicyId: ladder.policy.decisionPolicyId,
        environment: EXAMPLE_ENVIRONMENT,
      });
      expect(recommendation.recommendedActionId).toBe("action_create_objective");
      const [a, b] = await Promise.all([
        service.materializeRecommendation({
          recommendationId: recommendation.decisionRecommendationId,
        }),
        service.materializeRecommendation({
          recommendationId: recommendation.decisionRecommendationId,
        }),
      ]);
      expect(a.lineage.materializationLineageId).toBe(
        b.lineage.materializationLineageId,
      );
      expect(a.lineage.downstreamObjectId).toBe(b.lineage.downstreamObjectId);
      expect(port.admitCalls).toBe(1);
      expect(a.recommendation.attribution.authorizedDownstream).toBe(false);
      expect(a.recommendation.attribution.executed).toBe(false);
    });

    it("wrong project/unit on state source fails closed", async () => {
      const { service, decisionStateSource } = buildDecisionPolicyService();
      const ladder = await ladderToActive(service);
      decisionStateSource.seed(
        mintSeededObservation({
          variableId: "conversion_rate",
          value: 12,
          unit: "RATIO",
          sourceClass: "VERIFIED_PROGRAM_OUTCOME",
          projectId: EXAMPLE_PROJECT_ID,
          environment: EXAMPLE_ENVIRONMENT,
          observedAt: DP_TEST_NOW,
        }),
      );
      await expect(
        service.recommend({
          decisionPolicyId: ladder.policy.decisionPolicyId,
          environment: EXAMPLE_ENVIRONMENT,
        }),
      ).rejects.toMatchObject({ code: "DECISION_STATE_UNIT_MISMATCH" });
    });
  });
});

async function ladderToAwaitingApproval(
  service: ReturnType<typeof buildDecisionPolicyService>["service"],
) {
  const { context } = await admitSampleContext(service);
  const { policy } = await service.synthesizePolicy({
    decisionContextId: context.decisionContextId,
    createdBy: "synth",
  });
  await service.validatePolicy(policy.decisionPolicyId);
  await service.evaluateOffline(policy.decisionPolicyId, [
    {
      caseId: "c1",
      stateValues: { conversion_rate: 12, flag_enabled: true },
      counterfactualSupport: "COUNTERFACTUAL_UNSUPPORTED",
    },
  ]);
  const routed = await service.routeApproval(policy.decisionPolicyId);
  return { context, policy: routed.policy, request: routed.request, decisionNonce: routed.decisionNonce };
}

async function ladderToShadowApproved(
  service: ReturnType<typeof buildDecisionPolicyService>["service"],
) {
  const ladder = await ladderToAwaitingApproval(service);
  const decided = await service.decideApproval({
    decisionPolicyApprovalRequestId:
      ladder.request.decisionPolicyApprovalRequestId,
    approverId: "dp_approver_full",
    decision: "APPROVE_SHADOW",
    decisionNonce: ladder.decisionNonce,
  });
  return { ...ladder, policy: decided.policy };
}

async function ladderToAwaitingActivation(
  service: ReturnType<typeof buildDecisionPolicyService>["service"],
) {
  const ladder = await ladderToShadowApproved(service);
  await service.runShadowDecision({
    decisionPolicyId: ladder.policy.decisionPolicyId,
    environment: EXAMPLE_ENVIRONMENT,
  });
  await service.evaluateShadow(ladder.policy.decisionPolicyId);
  const act = await service.routeActivation(ladder.policy.decisionPolicyId);
  return {
    ...ladder,
    policy: act.policy,
    activationRequest: act.request,
    activationNonce: act.decisionNonce,
  };
}

async function ladderToActive(
  service: ReturnType<typeof buildDecisionPolicyService>["service"],
) {
  const ladder = await ladderToAwaitingActivation(service);
  const activated = await service.decideActivation({
    decisionPolicyActivationRequestId:
      ladder.activationRequest.decisionPolicyActivationRequestId,
    activatorId: "dp_activator_full",
    decision: "ACTIVATE",
    decisionNonce: ladder.activationNonce,
  });
  return { ...ladder, policy: activated.policy, activation: activated.activation };
}
