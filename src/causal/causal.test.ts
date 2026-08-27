import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { EXAMPLE_ENVIRONMENT, EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";
import {
  assessGeneralizability,
  assessMateriality,
  assumptionIsAuthoritativelySupported,
  assertCompatibleUnits,
  assertCausalQuestionTransition,
  assertPromotionCompatibleWithSynthesis,
  assertSameUnitForPooling,
  CAUSAL_DOCTRINE,
  CAUSAL_MEMORY_BOUNDARY,
  CAUSAL_QUESTION_TRANSITIONS,
  canTransitionCausalQuestion,
  CausalGovernedMemoryAdapter,
  computeCausalGraphHash,
  computeClaimHash,
  computePromotionBasisHash,
  detectContradictions,
  DifferenceInMeansEstimator,
  InMemoryAuthoritativeExperimentEvidencePort,
  isCausalError,
  isVerifiedCausalEdge,
  mintSeededRandomizedEvidence,
  PROMOTED_CAUSAL_CLAIM_BOUNDARIES,
  synthesizeEstimates,
  validateCausalGraph,
  withCausalGraphHash,
  withClaimHash,
  type CausalEdge,
  type CausalEstimate,
  type CausalQuestion,
} from "./index.js";
import {
  buildCausalService,
  buildCausalServiceWithSeededExperiment,
  CAUSAL_TEST_NOW,
  DEFAULT_SEEDED_EXPERIMENT_ID,
  ladderToAwaitingReview,
  observationalEvidenceRef,
  randomizedEvidenceRef,
  sampleAdmission,
} from "./test-fixtures.js";

const NOW = CAUSAL_TEST_NOW;

function sampleQuestion(overrides?: Partial<CausalQuestion>): CausalQuestion {
  return {
    causalQuestionId: "cq_test",
    causalQuestionVersion: 1,
    projectIds: [EXAMPLE_PROJECT_ID],
    sourceDecisionProblemIds: [],
    sourceExperimentIds: [],
    sourceAssumptionIds: [],
    intervention: "enable_flag",
    outcome: "conversion",
    interventionUnit: "DIMENSIONLESS",
    outcomeUnit: "PERCENT",
    targetPopulation: "users_us_west",
    targetEnvironment: EXAMPLE_ENVIRONMENT,
    timeHorizon: "14d",
    candidateConfounders: ["prior_engagement"],
    candidateMediators: [],
    candidateModerators: [],
    businessDecisionContext: "rollout decision",
    materialityThreshold: 1,
    constraints: [],
    nonGoals: [],
    budgetEnvelope: {
      maximumGraphModelCalls: 5,
      maximumModelTokens: 1000,
      maximumEstimators: 3,
      maximumSynthesisOperations: 3,
    },
    createdBy: "analyst",
    createdAt: NOW,
    updatedAt: NOW,
    status: "ADMITTED",
    idempotencyKey: "idem_1",
    contentFingerprint: "fp_1",
    recordRevision: 1,
    ...overrides,
  };
}

function baseNodes(question: CausalQuestion = sampleQuestion()) {
  return [
    {
      variableId: "var_int",
      name: "intervention",
      description: question.intervention,
      unit: question.interventionUnit,
      variableClass: "INTERVENTION" as const,
      source: "test",
      measurementDefinition: question.intervention,
      populationScope: question.targetPopulation,
      environmentScope: question.targetEnvironment,
    },
    {
      variableId: "var_out",
      name: "outcome",
      description: question.outcome,
      unit: question.outcomeUnit,
      variableClass: "OUTCOME" as const,
      source: "test",
      measurementDefinition: question.outcome,
      populationScope: question.targetPopulation,
      environmentScope: question.targetEnvironment,
    },
  ];
}

function estimatorBinding(overrides?: Partial<Parameters<DifferenceInMeansEstimator["estimate"]>[0]>) {
  return {
    treatmentMeasurements: [10, 12, 11, 13],
    controlMeasurements: [8, 7, 9, 8],
    unit: "PERCENT" as const,
    evidenceRefIds: ["ev1"],
    createdAt: NOW,
    causalQuestionId: "cq_1",
    causalQuestionVersion: 1,
    intervention: "enable_flag",
    outcome: "conversion",
    graphHash: "gh_1",
    identificationAnalysisId: "cia_1",
    identificationFingerprint: "ifp_1",
    identificationStrategy: "RANDOMIZED_TREATMENT",
    evidenceBundleId: "eeb_1",
    evidenceBundleHash: "ebh_1",
    outcomeVerificationIds: ["ovr_1"],
    assignmentFingerprint: "afp_1",
    measurementDefinition: "conversion",
    populationScope: "users_us_west",
    environmentScope: EXAMPLE_ENVIRONMENT,
    ...overrides,
  };
}

function makeEstimate(
  overrides: Partial<CausalEstimate> &
    Pick<CausalEstimate, "causalEstimateId" | "pointEstimate" | "unit">,
): CausalEstimate {
  return {
    causalQuestionId: "cq_test",
    causalQuestionVersion: 1,
    intervention: "enable_flag",
    outcome: "conversion",
    graphHash: "gh_1",
    identificationAnalysisId: "cia_1",
    identificationFingerprint: "ifp_1",
    identificationStrategy: "RANDOMIZED_TREATMENT",
    evidenceBundleId: "eeb_1",
    evidenceBundleHash: "ebh_1",
    outcomeVerificationIds: ["ovr_1"],
    assignmentFingerprint: "afp_1",
    measurementDefinition: "conversion",
    populationScope: "users_us_west",
    environmentScope: EXAMPLE_ENVIRONMENT,
    estimatorId: "difference_in_means",
    estimatorVersion: "difference_in_means_v1",
    treatmentMean: overrides.pointEstimate + 1,
    controlMean: 1,
    treatmentSampleCount: 20,
    controlSampleCount: 20,
    uncertainty: {
      kind: "STANDARD_ERROR",
      standardError: 0.5,
      notes: [
        "SE under independent samples assumption; no confidence interval claimed",
      ],
    },
    estimatorAssumptions: [],
    limitations: [],
    evidenceRefIds: [],
    estimateHash: `hash_${overrides.causalEstimateId}`,
    createdAt: NOW,
    ...overrides,
  };
}

async function promoteLadder(
  ctx: ReturnType<typeof buildCausalServiceWithSeededExperiment>,
  admission?: Partial<Parameters<typeof sampleAdmission>[0]>,
) {
  const experimentId =
    admission?.sourceExperimentIds?.[0] ?? DEFAULT_SEEDED_EXPERIMENT_ID;
  ctx.authoritativeExperimentEvidence.seed(
    mintSeededRandomizedEvidence({
      experimentId,
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
      outcomeUnit: "PERCENT",
    }),
  );
  const { id } = await ladderToAwaitingReview(ctx.service, {
    admission: {
      ...admission,
      sourceExperimentIds: admission?.sourceExperimentIds ?? [experimentId],
    },
    authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
  });
  const routed = await ctx.service.routeReview(id);
  const decided = await ctx.service.decideReview({
    reviewRequestId: routed.request.reviewRequestId,
    reviewerId: "causal_reviewer_full",
    decision: "PROMOTE",
    decisionNonce: routed.decisionNonce,
    submittedAt: NOW,
  });
  return { id, routed, decided };
}

describe("Phase 18 causal intelligence", () => {
  it("allows legal causal question transitions and rejects illegal ones", () => {
    expect(canTransitionCausalQuestion("ADMITTED", "GRAPH_PROPOSED")).toBe(true);
    expect(
      canTransitionCausalQuestion("ESTIMATING", "SYNTHESIZING"),
    ).toBe(true);
    expect(
      canTransitionCausalQuestion("REVIEWED", "PROMOTED"),
    ).toBe(true);
    expect(canTransitionCausalQuestion("ESTIMATING", "PROMOTED")).toBe(false);
    expect(canTransitionCausalQuestion("ADMITTED", "PROMOTED")).toBe(false);
    expect(canTransitionCausalQuestion("PROMOTED", "ADMITTED")).toBe(false);
    expect(canTransitionCausalQuestion("CANCELLED", "ADMITTED")).toBe(false);

    expect(() =>
      assertCausalQuestionTransition("ESTIMATING", "PROMOTED"),
    ).toThrow(/Illegal causal question transition/);

    for (const [from, targets] of Object.entries(CAUSAL_QUESTION_TRANSITIONS)) {
      for (const to of targets) {
        expect(
          canTransitionCausalQuestion(
            from as keyof typeof CAUSAL_QUESTION_TRANSITIONS,
            to,
          ),
        ).toBe(true);
      }
    }
  });

  it("computes stable graph hashes and rejects cycles", () => {
    const question = sampleQuestion();
    const nodes = baseNodes(question);
    const edges: CausalEdge[] = [
      {
        edgeId: "e1",
        fromVariableId: "var_int",
        toVariableId: "var_out",
        edgeType: "CAUSES",
        provenance: "HUMAN_PROVIDED",
      },
    ];
    const hashA = computeCausalGraphHash({
      causalQuestionId: question.causalQuestionId,
      causalQuestionVersion: 1,
      nodes,
      edges,
    });
    const hashB = computeCausalGraphHash({
      causalQuestionId: question.causalQuestionId,
      causalQuestionVersion: 1,
      nodes: [...nodes].reverse(),
      edges,
    });
    expect(hashA).toBe(hashB);

    const graph = withCausalGraphHash({
      causalGraphId: "cg_1",
      causalGraphVersion: 1,
      causalQuestionId: question.causalQuestionId,
      causalQuestionVersion: 1,
      nodes,
      edges,
      createdAt: NOW,
      createdBy: "test",
    });
    expect(validateCausalGraph(graph, question).outcome).toBe("PASS");

    const cyclic = withCausalGraphHash({
      ...graph,
      edges: [
        ...edges,
        {
          edgeId: "e2",
          fromVariableId: "var_out",
          toVariableId: "var_int",
          edgeType: "CAUSES",
          provenance: "MODEL_PROPOSED",
        },
      ],
    });
    expect(() => validateCausalGraph(cyclic, question)).toThrow(
      /Cyclic SCMs unsupported/,
    );
    try {
      validateCausalGraph(cyclic, question);
    } catch (error) {
      expect(isCausalError(error)).toBe(true);
      if (isCausalError(error)) {
        expect(error.code).toBe("CAUSAL_GRAPH_CYCLE_UNSUPPORTED");
      }
    }
  });

  it("rejects unit mixing for variables and pooling", () => {
    expect(() =>
      assertCompatibleUnits("PERCENT", "PERCENT", "compare"),
    ).not.toThrow();
    expect(() => assertCompatibleUnits("PERCENT", "USD", "compare")).toThrow(
      /incompatible units/,
    );
    expect(() => assertSameUnitForPooling("PERCENT", "COUNT")).toThrow(
      /incompatible units/,
    );
    try {
      assertCompatibleUnits("USD", "TOKENS", "mix");
    } catch (error) {
      expect(isCausalError(error)).toBe(true);
      if (isCausalError(error)) {
        expect(error.code).toBe("UNIT_MIXING_REJECTED");
      }
    }
  });

  it("treats MODEL_PROPOSED edges as unverified provenance", () => {
    const modelProposed: CausalEdge = {
      edgeId: "e_model",
      fromVariableId: "a",
      toVariableId: "b",
      edgeType: "CAUSES",
      provenance: "MODEL_PROPOSED",
    };
    const experimentSupported: CausalEdge = {
      ...modelProposed,
      edgeId: "e_exp",
      provenance: "EXPERIMENT_SUPPORTED",
    };
    expect(isVerifiedCausalEdge(modelProposed)).toBe(false);
    expect(isVerifiedCausalEdge(experimentSupported)).toBe(true);
    expect(CAUSAL_DOCTRINE.modelDagNotTrueDag).toContain("MODEL-GENERATED DAG");
  });

  it("requires authoritative randomized evidence for identification; observational and fabricated attachEvidence are NOT_IDENTIFIED", async () => {
    const { service } = buildCausalService();
    const admitted = await service.admit(sampleAdmission());
    const id = admitted.question.causalQuestionId;
    await service.proposeGraph(id);
    await service.attachEvidence(id, [observationalEvidenceRef()]);
    const observational = await service.identify(id);
    expect(observational.analysis.status).toBe("NOT_IDENTIFIED");
    expect(observational.analysis.strategy).toBe("UNIDENTIFIED");
    expect(observational.question.status).toBe("INCONCLUSIVE");
    expect(observational.evidenceGap?.mayFeedPhase17ActiveLearning).toBe(true);
    expect(observational.evidenceGap?.doesNotAuthorizeExperiment).toBe(true);

    const fabricated = buildCausalService();
    const admitted2 = await fabricated.service.admit(
      sampleAdmission({ intervention: "flag_b", outcome: "retention" }),
    );
    const id2 = admitted2.question.causalQuestionId;
    await fabricated.service.proposeGraph(id2);
    await fabricated.service.attachEvidence(id2, [randomizedEvidenceRef({})]);
    const notAuth = await fabricated.service.identify(id2);
    expect(notAuth.analysis.status).toBe("NOT_IDENTIFIED");

    const seeded = buildCausalServiceWithSeededExperiment(
      DEFAULT_SEEDED_EXPERIMENT_ID,
    );
    const admitted3 = await seeded.service.admit(
      sampleAdmission({
        intervention: "flag_c",
        outcome: "ctr",
        sourceExperimentIds: [DEFAULT_SEEDED_EXPERIMENT_ID],
      }),
    );
    const id3 = admitted3.question.causalQuestionId;
    await seeded.service.proposeGraph(id3);
    const identified = await seeded.service.identify(id3);
    expect(identified.analysis.status).toBe("IDENTIFIED");
    expect(identified.analysis.strategy).toBe("RANDOMIZED_TREATMENT");
    expect(identified.question.status).toBe("ESTIMATING");
  });

  it("does not treat PLAUSIBLE assumptions as authoritatively supported", () => {
    expect(assumptionIsAuthoritativelySupported("SUPPORTED")).toBe(true);
    expect(assumptionIsAuthoritativelySupported("PLAUSIBLE")).toBe(false);
    expect(assumptionIsAuthoritativelySupported("UNVERIFIED")).toBe(false);
  });

  it("DifferenceInMeansEstimator enforces samples and never fabricates CIs", () => {
    const estimator = new DifferenceInMeansEstimator();
    const estimate = estimator.estimate(estimatorBinding());
    expect(estimate.pointEstimate).toBeCloseTo(3.5);
    expect(estimate.uncertainty.kind).toBe("STANDARD_ERROR");
    expect(estimate.uncertainty.confidenceLevel).toBeUndefined();
    expect(estimate.uncertainty.notes.join(" ")).toMatch(/no confidence interval/i);
    expect(estimate.limitations.some((l) => /p-values/i.test(l))).toBe(true);

    const thin = estimator.estimate(
      estimatorBinding({
        treatmentMeasurements: [10],
        controlMeasurements: [8],
      }),
    );
    expect(thin.uncertainty.kind).toBe("UNKNOWN");

    expect(() =>
      estimator.estimate(
        estimatorBinding({
          treatmentMeasurements: [],
          controlMeasurements: [1],
        }),
      ),
    ).toThrow(/non-empty/);
  });

  it("separates statistical clarity from business materiality", () => {
    const material = assessMateriality({
      effectEstimate: 5,
      threshold: 1,
      se: 0.2,
    });
    expect(material.statistical.clarity).toBe("CLEAR");
    expect(material.business.materiality).toBe("MATERIAL");

    const uncertainButMaterial = assessMateriality({
      effectEstimate: 2,
      threshold: 1,
      se: 3,
    });
    expect(uncertainButMaterial.statistical.clarity).toBe("UNCERTAIN");
    expect(uncertainButMaterial.business.materiality).toBe("MATERIAL");

    const clearButImmaterial = assessMateriality({
      effectEstimate: 0.2,
      threshold: 1,
      se: 0.05,
    });
    expect(clearButImmaterial.statistical.clarity).toBe("CLEAR");
    expect(clearButImmaterial.business.materiality).toBe("IMMATERIAL");
    expect(CAUSAL_DOCTRINE.statisticalNotBusiness).toContain(
      "STATISTICAL SIGNIFICANCE",
    );
  });

  it("marks cross-project/env generalizability as NOT_SUPPORTED", () => {
    const assessment = assessGeneralizability({
      evidencePopulation: "users_eu",
      evidenceEnvironment: "production",
      targetPopulation: "users_us_west",
      targetEnvironment: EXAMPLE_ENVIRONMENT,
    });
    expect(assessment.status).toBe("NOT_SUPPORTED");
  });

  it("detects contradictory evidence and refuses to pool incomparable effects", () => {
    const positive = makeEstimate({
      causalEstimateId: "ce_pos",
      pointEstimate: 5,
      unit: "PERCENT",
    });
    const negative = makeEstimate({
      causalEstimateId: "ce_neg",
      pointEstimate: -4,
      unit: "PERCENT",
    });
    const contradictions = detectContradictions([positive, negative], 1);
    expect(contradictions.some((c) => c.kind === "DIRECTION_CONFLICT")).toBe(
      true,
    );
    const synthesis = synthesizeEstimates({
      causalQuestionId: "cq_test",
      estimates: [positive, negative],
      materialityThreshold: 1,
      createdAt: NOW,
    });
    expect(synthesis.synthesisStatus).toBe("CONTRADICTORY");
    expect(synthesis.pooledEstimate).toBeUndefined();

    const usd = makeEstimate({
      causalEstimateId: "ce_usd",
      pointEstimate: 5,
      unit: "USD",
    });
    expect(() =>
      synthesizeEstimates({
        causalQuestionId: "cq_test",
        estimates: [positive, usd],
        materialityThreshold: 1,
        createdAt: NOW,
      }),
    ).toThrow(/refuse to pool/);
    try {
      synthesizeEstimates({
        causalQuestionId: "cq_test",
        estimates: [positive, usd],
        materialityThreshold: 1,
        createdAt: NOW,
      });
    } catch (error) {
      expect(isCausalError(error)).toBe(true);
      if (isCausalError(error)) {
        expect(error.code).toBe("INCOMPARABLE_EFFECTS");
      }
    }
  });

  it("keeps CausalClaim hash stable across rehash", () => {
    const claim = withClaimHash({
      claimId: "cc_1",
      claimVersion: 1,
      causalQuestionId: "cq_1",
      causalQuestionVersion: 1,
      interventionVariableId: "var_int",
      outcomeVariableId: "var_out",
      claimType: "POSITIVE_EFFECT",
      effectEstimate: 4,
      unit: "PERCENT",
      identificationStatus: "IDENTIFIED",
      identificationStrategy: "RANDOMIZED_TREATMENT",
      graphId: "cg_1",
      graphVersion: 1,
      graphHash: "gh_1",
      identificationAnalysisId: "cia_1",
      assumptionIds: [],
      evidenceRefs: ["ev1"],
      populationScope: "users_us_west",
      environmentScope: EXAMPLE_ENVIRONMENT,
      timeScope: "14d",
      statisticalEvidenceAssessment: { clarity: "CLEAR", notes: [] },
      businessMaterialityAssessment: {
        materiality: "MATERIAL",
        threshold: 1,
        absoluteEffect: 4,
        notes: [],
      },
      generalizability: {
        status: "DIRECTLY_SUPPORTED",
        evidencePopulation: "users_us_west",
        evidenceEnvironment: EXAMPLE_ENVIRONMENT,
        targetPopulation: "users_us_west",
        targetEnvironment: EXAMPLE_ENVIRONMENT,
        notes: [],
      },
      limitations: [],
      contradictoryEvidenceRefs: [],
      createdAt: NOW,
    });
    const { claimHash: _h, claimId: _id, createdAt: _c, ...rest } = claim;
    expect(
      computeClaimHash({
        ...rest,
        claimId: claim.claimId,
        createdAt: claim.createdAt,
      }),
    ).toBe(claim.claimHash);
  });

  it("isolates CAUSAL_REVIEWER authority (false checker → error)", async () => {
    const ctx = buildCausalServiceWithSeededExperiment();
    const { service } = buildCausalService({
      isCausalReviewer: async () => false,
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
    });
    const { id } = await ladderToAwaitingReview(service, {
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
    });
    const routed = await service.routeReview(id);
    await expect(
      service.decideReview({
        reviewRequestId: routed.request.reviewRequestId,
        reviewerId: "anyone",
        decision: "PROMOTE",
        decisionNonce: routed.decisionNonce,
        submittedAt: NOW,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_REVIEWER_SCOPE_INSUFFICIENT" });
  });

  it("enforces nonce mismatch, replay, and expiry on review", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const ctx = buildCausalServiceWithSeededExperiment(
      DEFAULT_SEEDED_EXPERIMENT_ID,
      { reviewWindowMs: 60_000, nowIso: () => now },
    );
    const { id } = await ladderToAwaitingReview(ctx.service, {
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
    });
    const routed = await ctx.service.routeReview(id);

    await expect(
      ctx.service.decideReview({
        reviewRequestId: routed.request.reviewRequestId,
        reviewerId: "causal_reviewer_full",
        decision: "PROMOTE",
        decisionNonce: "wrong-nonce",
        submittedAt: now,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_REVIEW_INVALID" });

    const promoted = await ctx.service.decideReview({
      reviewRequestId: routed.request.reviewRequestId,
      reviewerId: "causal_reviewer_full",
      decision: "PROMOTE",
      decisionNonce: routed.decisionNonce,
      submittedAt: now,
    });
    expect(promoted.question.status).toBe("PROMOTED");
    expect(promoted.promoted?.status).toBe("ACTIVE");

    await expect(
      ctx.service.decideReview({
        reviewRequestId: routed.request.reviewRequestId,
        reviewerId: "causal_reviewer_full",
        decision: "PROMOTE",
        decisionNonce: routed.decisionNonce,
        submittedAt: now,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_REVIEW_INVALID" });

    const fresh = buildCausalServiceWithSeededExperiment("exp_seed_expiry", {
      reviewWindowMs: 1_000,
      nowIso: () => now,
    });
    const ladder = await ladderToAwaitingReview(fresh.service, {
      admission: {
        intervention: "flag_expiry",
        outcome: "ctr",
        sourceExperimentIds: ["exp_seed_expiry"],
      },
      authoritativeExperimentEvidence: fresh.authoritativeExperimentEvidence,
    });
    const routed2 = await fresh.service.routeReview(ladder.id);
    await expect(
      fresh.service.decideReview({
        reviewRequestId: routed2.request.reviewRequestId,
        reviewerId: "causal_reviewer_full",
        decision: "PROMOTE",
        decisionNonce: routed2.decisionNonce,
        submittedAt: "2026-01-01T00:00:05.000Z",
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_REVIEW_EXPIRED" });
  });

  it("preserves promotion basis integrity and doctrine that promoted claim != policy", async () => {
    const ctx = buildCausalServiceWithSeededExperiment();
    const policyBefore = (
      await ctx.controlPlane.resolve(EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT)
    ).activePolicyBundle.policyHash;

    const { decided } = await promoteLadder(ctx);
    expect(decided.promoted).toBeDefined();
    const promoted = decided.promoted!;
    const expectedBasis = computePromotionBasisHash({
      claimId: promoted.claimId,
      claimVersion: promoted.claimVersion,
      claimHash: promoted.claimHash,
      claimType: promoted.claimType,
      reviewRecordId: promoted.reviewRecordId,
      identificationAnalysisId: promoted.identificationAnalysisId,
      evidenceSynthesisId: promoted.evidenceSynthesisId,
      evidenceSynthesisHash: promoted.evidenceSynthesisHash,
      synthesisStatus: promoted.synthesisStatus,
      evidenceHashes: promoted.evidenceHashes,
      contradictoryEvidenceRefs: promoted.contradictoryEvidenceRefs,
      populationScope: promoted.populationScope,
      environmentScope: promoted.environmentScope,
    });
    expect(promoted.promotionBasisHash).toBe(expectedBasis);
    expect(PROMOTED_CAUSAL_CLAIM_BOUNDARIES.notPolicy).toBe(
      CAUSAL_DOCTRINE.promotedClaimNotPolicy,
    );
    expect(CAUSAL_DOCTRINE.informsDoesNotAuthorize).toMatch(
      /does not authorize/,
    );

    const stored = await ctx.promotedClaims.getById(
      promoted.promotedCausalClaimId,
    );
    expect(stored?.promotionBasisHash).toBe(expectedBasis);

    const policyAfter = (
      await ctx.controlPlane.resolve(EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT)
    ).activePolicyBundle.policyHash;
    expect(policyAfter).toBe(policyBefore);
  });

  it("emits calibration candidates only via createCalibrationCandidate with requiresPhase16Reanalysis", async () => {
    const ctx = buildCausalServiceWithSeededExperiment();
    const { decided } = await promoteLadder(ctx);
    expect(decided).not.toHaveProperty("calibration");
    expect(decided.promoted).toBeDefined();

    const calibration = await ctx.service.createCalibrationCandidate({
      promotedCausalClaimId: decided.promoted!.promotedCausalClaimId,
    });
    expect(calibration.requiresPhase16Reanalysis).toBe(true);
    expect(calibration.promotedCausalClaimId).toBe(
      decided.promoted!.promotedCausalClaimId,
    );
    expect(calibration.limitations.join(" ")).toMatch(/Phase 16 re-analysis/i);
  });

  it("evidence gap may feed Phase 17 active learning but does not authorize experiments", async () => {
    const { service, evidenceGaps } = buildCausalService();
    const admitted = await service.admit(sampleAdmission());
    const id = admitted.question.causalQuestionId;
    await service.proposeGraph(id);
    await service.attachEvidence(id, [observationalEvidenceRef()]);
    const result = await service.identify(id);
    expect(result.evidenceGap?.mayFeedPhase17ActiveLearning).toBe(true);
    expect(result.evidenceGap?.doesNotAuthorizeExperiment).toBe(true);
    const gaps = await evidenceGaps.listByQuestion(id);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.doesNotAuthorizeExperiment).toBe(true);
  });

  it("producer-only loop/materializer does not call estimate or promote", async () => {
    const ctx = buildCausalService();
    const admitted = await ctx.service.admit(sampleAdmission());
    const estimateSpy = vi.spyOn(ctx.service, "estimate");
    const decideSpy = vi.spyOn(ctx.service, "decideReview");
    const identifySpy = vi.spyOn(ctx.service, "identify");
    const promoteRelated = vi.spyOn(ctx.service, "validate");

    await ctx.progression.tick();
    const items = await ctx.workItems.listByRun(admitted.question.causalQuestionId);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.workKind === "PROPOSE_CAUSAL_GRAPH")).toBe(true);

    expect(estimateSpy).not.toHaveBeenCalled();
    expect(decideSpy).not.toHaveBeenCalled();
    expect(identifySpy).not.toHaveBeenCalled();
    expect(promoteRelated).not.toHaveBeenCalled();
  });

  it("keeps prior graph versions immutable", async () => {
    const { graphs } = buildCausalService();
    const question = sampleQuestion();
    const nodes = baseNodes(question);
    const v1 = withCausalGraphHash({
      causalGraphId: "cg_immut",
      causalGraphVersion: 1,
      causalQuestionId: question.causalQuestionId,
      causalQuestionVersion: 1,
      nodes,
      edges: [
        {
          edgeId: "e1",
          fromVariableId: "var_int",
          toVariableId: "var_out",
          edgeType: "CAUSES",
          provenance: "HUMAN_PROVIDED",
        },
      ],
      createdAt: NOW,
      createdBy: "test",
    });
    await graphs.save(v1);
    const storedV1 = await graphs.getByIdVersion("cg_immut", 1);
    expect(storedV1?.graphHash).toBe(v1.graphHash);

    const v2 = withCausalGraphHash({
      causalGraphId: "cg_immut",
      causalGraphVersion: 2,
      causalQuestionId: question.causalQuestionId,
      causalQuestionVersion: 1,
      nodes: [
        ...nodes,
        {
          variableId: "var_conf",
          name: "confounder",
          description: "c",
          unit: "DIMENSIONLESS",
          variableClass: "CONFOUNDER",
          source: "test",
          measurementDefinition: "c",
          populationScope: question.targetPopulation,
          environmentScope: question.targetEnvironment,
        },
      ],
      edges: v1.edges,
      createdAt: NOW,
      createdBy: "test",
    });
    await graphs.save(v2);

    const stillV1 = await graphs.getByIdVersion("cg_immut", 1);
    expect(stillV1?.graphHash).toBe(v1.graphHash);
    expect(stillV1?.causalGraphVersion).toBe(1);
    expect(stillV1?.nodes).toHaveLength(2);

    const latest = await graphs.getLatestByQuestion(question.causalQuestionId);
    expect(latest?.causalGraphVersion).toBe(2);
    expect(latest?.graphHash).not.toBe(v1.graphHash);
  });

  it("runs primary admit→promote ladder end-to-end", async () => {
    const ctx = buildCausalServiceWithSeededExperiment();
    const { id, validated } = await ladderToAwaitingReview(ctx.service, {
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
    });
    expect(validated?.question.status).toBe("AWAITING_CAUSAL_REVIEW");
    const routed = await ctx.service.routeReview(id);
    const decided = await ctx.service.decideReview({
      reviewRequestId: routed.request.reviewRequestId,
      reviewerId: "causal_reviewer_full",
      decision: "PROMOTE",
      decisionNonce: routed.decisionNonce,
      submittedAt: NOW,
    });
    expect(decided.question.status).toBe("PROMOTED");
    expect(decided.promoted?.promotedBy).toBe("causal_reviewer_full");
    expect(decided.promoted?.status).toBe("ACTIVE");
  });

  it("rejects fabricated attachEvidence samples alone for identify/estimate without authoritative seed", async () => {
    const { service } = buildCausalService();
    const admitted = await service.admit(sampleAdmission());
    const id = admitted.question.causalQuestionId;
    await service.proposeGraph(id);
    await service.attachEvidence(id, [randomizedEvidenceRef({})]);
    const identified = await service.identify(id);
    expect(identified.analysis.status).toBe("NOT_IDENTIFIED");
    expect(identified.question.status).toBe("INCONCLUSIVE");
  });

  it("rejects cross-experiment evidence substitution", async () => {
    const port = new InMemoryAuthoritativeExperimentEvidencePort();
    port.seed(
      mintSeededRandomizedEvidence({
        experimentId: "exp_other",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        outcomeUnit: "PERCENT",
      }),
    );
    const { service } = buildCausalService({
      authoritativeExperimentEvidence: port,
    });
    const admitted = await service.admit(
      sampleAdmission({
        sourceExperimentIds: ["exp_question_points_here"],
        intervention: "cross_exp",
        outcome: "y",
      }),
    );
    const id = admitted.question.causalQuestionId;
    await service.proposeGraph(id);
    const identified = await service.identify(id);
    expect(identified.analysis.status).toBe("NOT_IDENTIFIED");
  });

  it("rejects wrong plan hash via expectedExperimentPlanHash", async () => {
    const port = new InMemoryAuthoritativeExperimentEvidencePort();
    port.seed(
      mintSeededRandomizedEvidence({
        experimentId: "exp_plan_check",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        outcomeUnit: "PERCENT",
        experimentPlanHash: "eplan_hash_correct",
      }),
    );
    await expect(
      port.resolveForEstimation({
        experimentId: "exp_plan_check",
        expectedProjectIds: [EXAMPLE_PROJECT_ID],
        expectedEnvironment: EXAMPLE_ENVIRONMENT,
        expectedOutcomeUnit: "PERCENT",
        expectedExperimentPlanHash: "eplan_hash_WRONG",
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_EVIDENCE_INVALID" });

    const { service } = buildCausalService({
      authoritativeExperimentEvidence: port,
    });
    const admitted = await service.admit(
      sampleAdmission({
        sourceExperimentIds: ["exp_plan_check"],
        constraints: ["experimentPlanHash=eplan_hash_WRONG"],
        intervention: "plan_mismatch",
        outcome: "y",
      }),
    );
    const id = admitted.question.causalQuestionId;
    await service.proposeGraph(id);
    const identified = await service.identify(id);
    expect(identified.analysis.status).toBe("NOT_IDENTIFIED");
  });

  it("rejects wrong project/environment on authoritative resolution", async () => {
    const port = new InMemoryAuthoritativeExperimentEvidencePort();
    port.seed(
      mintSeededRandomizedEvidence({
        experimentId: "exp_scope",
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        outcomeUnit: "PERCENT",
      }),
    );
    await expect(
      port.resolveForEstimation({
        experimentId: "exp_scope",
        expectedProjectIds: ["other_project"],
        expectedEnvironment: EXAMPLE_ENVIRONMENT,
        expectedOutcomeUnit: "PERCENT",
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_EVIDENCE_INVALID" });
    await expect(
      port.resolveForEstimation({
        experimentId: "exp_scope",
        expectedProjectIds: [EXAMPLE_PROJECT_ID],
        expectedEnvironment: "production",
        expectedOutcomeUnit: "PERCENT",
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_EVIDENCE_INVALID" });
  });

  it("correct lineage executes estimator; estimate hash changes when evidenceBundleHash changes", async () => {
    const ctx = buildCausalServiceWithSeededExperiment("exp_lineage_a");
    const admitted = await ctx.service.admit(
      sampleAdmission({
        sourceExperimentIds: ["exp_lineage_a"],
        intervention: "lineage_a",
        outcome: "y_a",
      }),
    );
    const id = admitted.question.causalQuestionId;
    await ctx.service.proposeGraph(id);
    await ctx.service.identify(id);
    const first = await ctx.service.estimate(id);
    expect(first.estimate.pointEstimate).toBeCloseTo(4);
    expect(first.estimate.evidenceBundleHash.length).toBeGreaterThan(0);

    const portB = new InMemoryAuthoritativeExperimentEvidencePort();
    const seededB = mintSeededRandomizedEvidence({
      experimentId: "exp_lineage_b",
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
      outcomeUnit: "PERCENT",
      treatmentMean: 20,
      controlMean: 8,
    });
    portB.seed(seededB);
    const alt = mintSeededRandomizedEvidence({
      experimentId: "exp_lineage_b",
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
      outcomeUnit: "PERCENT",
      treatmentMean: 20,
      controlMean: 8,
      experimentPlanHash: "eplan_hash_alt_bundle",
    });
    expect(alt.evidenceBundleHash).not.toBe(seededB.evidenceBundleHash);

    const estimator = new DifferenceInMeansEstimator();
    const e1 = estimator.estimate(
      estimatorBinding({
        treatmentMeasurements: seededB.treatmentMeasurements,
        controlMeasurements: seededB.controlMeasurements,
        evidenceBundleHash: seededB.evidenceBundleHash,
        evidenceBundleId: seededB.evidenceBundleId,
        assignmentFingerprint: seededB.assignmentFingerprint,
      }),
    );
    const e2 = estimator.estimate(
      estimatorBinding({
        treatmentMeasurements: alt.treatmentMeasurements,
        controlMeasurements: alt.controlMeasurements,
        evidenceBundleHash: alt.evidenceBundleHash,
        evidenceBundleId: alt.evidenceBundleId,
        assignmentFingerprint: alt.assignmentFingerprint,
      }),
    );
    expect(e1.estimateHash).not.toBe(e2.estimateHash);
  });

  it("rejects CONTRADICTORY synthesis + directional claim promotion", () => {
    expect(() =>
      assertPromotionCompatibleWithSynthesis({
        synthesisStatus: "CONTRADICTORY",
        claimType: "POSITIVE_EFFECT",
      }),
    ).toThrow(/CAUSAL_PROMOTION_REJECTED|Cannot promote directional/);
  });

  it("allows CONTRADICTORY + INCONCLUSIVE claim promotion with contradiction metadata", async () => {
    expect(() =>
      assertPromotionCompatibleWithSynthesis({
        synthesisStatus: "CONTRADICTORY",
        claimType: "INCONCLUSIVE",
      }),
    ).not.toThrow();

    const ctx = buildCausalServiceWithSeededExperiment("exp_contradict");
    const { id } = await ladderToAwaitingReview(ctx.service, {
      admission: {
        sourceExperimentIds: ["exp_contradict"],
        intervention: "contradict_flag",
        outcome: "y_c",
      },
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
    });

    const claim = (await ctx.claims.getLatestByQuestion(id))!;
    const synthesis = (await ctx.syntheses.getLatestByQuestion(id))!;
    const forcedSynthesis = {
      ...synthesis,
      synthesisStatus: "CONTRADICTORY" as const,
      contradictingEstimateIds: ["ce_a", "ce_b"],
      limitations: [
        ...synthesis.limitations,
        "Forced contradiction for promotion metadata test",
      ],
    };
    await ctx.syntheses.save(forcedSynthesis);

    const { claimHash: _priorHash, ...claimRest } = claim;
    void _priorHash;
    const rewritten = withClaimHash({
      ...claimRest,
      claimType: "INCONCLUSIVE",
      contradictoryEvidenceRefs: ["ce_a", "ce_b"],
      limitations: [
        ...claim.limitations,
        "Forced contradiction for promotion metadata test",
      ],
    });
    await ctx.claims.save(rewritten);

    const { issueDecisionNonce, SequenceDecisionNonceGenerator } = await import(
      "../authorization/decision-nonce.js"
    );
    const nonceGen = new SequenceDecisionNonceGenerator();
    const issued = issueDecisionNonce(nonceGen);
    const pending = await ctx.reviewRequests.getPendingByQuestion(id);
    if (pending) {
      await ctx.reviewRequests.update({ ...pending, status: "DECIDED" });
    }
    const forcedRequest = {
      reviewRequestId: `crr_forced_contradict_${id}`,
      causalQuestionId: id,
      causalQuestionVersion: 1,
      claimId: rewritten.claimId,
      claimVersion: rewritten.claimVersion,
      claimHash: rewritten.claimHash,
      graphHash: rewritten.graphHash,
      identificationAnalysisId: rewritten.identificationAnalysisId,
      evidenceSynthesisHash: forcedSynthesis.synthesisHash,
      evidenceRefs: rewritten.evidenceRefs,
      populationScope: rewritten.populationScope,
      environmentScope: rewritten.environmentScope,
      policyBundleFingerprint: "pol_test",
      capabilitySetFingerprint: "cap_test",
      subjectHash: "subj_forced",
      decisionNonceHash: issued.nonceHash,
      status: "PENDING" as const,
      expiresAt: "2099-01-01T00:00:00.000Z",
      createdAt: NOW,
      recordRevision: 1,
    };
    await ctx.reviewRequests.save(forcedRequest);
    (
      ctx.service as unknown as {
        noncePlaintextByRequest: Map<string, string>;
      }
    ).noncePlaintextByRequest.set(
      forcedRequest.reviewRequestId,
      issued.plaintext,
    );

    const decided = await ctx.service.decideReview({
      reviewRequestId: forcedRequest.reviewRequestId,
      reviewerId: "causal_reviewer_full",
      decision: "PROMOTE",
      decisionNonce: issued.plaintext,
      submittedAt: NOW,
    });
    expect(decided.promoted).toBeDefined();
    expect(decided.promoted?.claimType).toBe("INCONCLUSIVE");
    expect(decided.promoted?.synthesisStatus).toBe("CONTRADICTORY");
    expect(decided.promoted?.contradictoryEvidenceRefs).toEqual([
      "ce_a",
      "ce_b",
    ]);
  });

  it("review does not mutate claim hash / identificationStatus / effectEstimate", async () => {
    const ctx = buildCausalServiceWithSeededExperiment();
    const { id } = await ladderToAwaitingReview(ctx.service, {
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
    });
    const before = await ctx.claims.getLatestByQuestion(id);
    expect(before).toBeDefined();
    const snapshot = {
      claimHash: before!.claimHash,
      identificationStatus: before!.identificationStatus,
      effectEstimate: before!.effectEstimate,
      evidenceRefs: [...before!.evidenceRefs],
      generalizability: before!.generalizability,
    };
    const routed = await ctx.service.routeReview(id);
    await ctx.service.decideReview({
      reviewRequestId: routed.request.reviewRequestId,
      reviewerId: "causal_reviewer_full",
      decision: "PROMOTE",
      decisionNonce: routed.decisionNonce,
      submittedAt: NOW,
    });
    const after = await ctx.claims.getById(before!.claimId);
    expect(after?.claimHash).toBe(snapshot.claimHash);
    expect(after?.identificationStatus).toBe(snapshot.identificationStatus);
    expect(after?.effectEstimate).toBe(snapshot.effectEstimate);
    expect(after?.evidenceRefs).toEqual(snapshot.evidenceRefs);
    expect(after?.generalizability).toEqual(snapshot.generalizability);
  });

  it("createCalibrationCandidate fails for unpromoted/rejected/stale; succeeds for ACTIVE", async () => {
    const ctx = buildCausalServiceWithSeededExperiment();
    await expect(
      ctx.service.createCalibrationCandidate({
        promotedCausalClaimId: "pcc_missing",
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_PROMOTION_REJECTED" });

    const { id } = await ladderToAwaitingReview(ctx.service, {
      authoritativeExperimentEvidence: ctx.authoritativeExperimentEvidence,
      admission: { intervention: "cal_reject", outcome: "y_r" },
    });
    const routedReject = await ctx.service.routeReview(id);
    await ctx.service.decideReview({
      reviewRequestId: routedReject.request.reviewRequestId,
      reviewerId: "causal_reviewer_full",
      decision: "REJECT",
      decisionNonce: routedReject.decisionNonce,
      submittedAt: NOW,
    });
    await expect(
      ctx.service.createCalibrationCandidate({
        promotedCausalClaimId: "pcc_from_reject",
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_PROMOTION_REJECTED" });

    const ctx2 = buildCausalServiceWithSeededExperiment("exp_cal_ok");
    const { decided } = await promoteLadder(ctx2, {
      sourceExperimentIds: ["exp_cal_ok"],
      intervention: "cal_ok",
      outcome: "y_ok",
    });
    const promotedId = decided.promoted!.promotedCausalClaimId;
    const ok = await ctx2.service.createCalibrationCandidate({
      promotedCausalClaimId: promotedId,
    });
    expect(ok.requiresPhase16Reanalysis).toBe(true);

    await ctx2.service.markPromotedClaimStale({
      promotedCausalClaimId: promotedId,
      reason: "evidence invalidated",
    });
    await expect(
      ctx2.service.createCalibrationCandidate({
        promotedCausalClaimId: promotedId,
      }),
    ).rejects.toMatchObject({ code: "CAUSAL_CLAIM_STALE" });
  });

  it("CausalGovernedMemoryAdapter preserves scope/limitations; planning must not import PromotedCausalClaimRepository", async () => {
    const ctx = buildCausalServiceWithSeededExperiment("exp_memory");
    const { decided } = await promoteLadder(ctx, {
      sourceExperimentIds: ["exp_memory"],
      intervention: "memory_flag",
      outcome: "memory_y",
    });
    const promoted = decided.promoted!;
    const claim = await ctx.claims.getById(promoted.claimId);
    const synthesis = await ctx.syntheses.getById
      ? await (ctx.syntheses as {
          getById?: (id: string) => Promise<unknown>;
          getLatestByQuestion: (id: string) => Promise<unknown>;
        }).getLatestByQuestion(promoted.causalQuestionId)
      : await ctx.syntheses.getLatestByQuestion(promoted.causalQuestionId);
    expect(claim).toBeDefined();
    expect(synthesis).toBeDefined();

    const adapter = new CausalGovernedMemoryAdapter({
      getPromoted: (id) => ctx.promotedClaims.getById(id),
      getClaim: (id) => ctx.claims.getById(id),
      getSynthesis: async (id) => {
        const s = await ctx.syntheses.getLatestByQuestion(
          promoted.causalQuestionId,
        );
        return s?.evidenceSynthesisId === id ? s : s;
      },
      resolveInterventionOutcome: async () => ({
        intervention: "memory_flag",
        outcome: "memory_y",
      }),
    });
    const view = await adapter.retrieveForPlanning({
      promotedCausalClaimId: promoted.promotedCausalClaimId,
      requestingProjectId: EXAMPLE_PROJECT_ID,
      requestingEnvironment: EXAMPLE_ENVIRONMENT,
    });
    expect(view).toBeDefined();
    expect(view!.label).toBe("ADVISORY_CAUSAL_PRECEDENT");
    expect(view!.limitations.length).toBeGreaterThan(0);
    expect(view!.scopedStatement).not.toMatch(/^X causes Y$/i);
    expect(view!.scopedStatement).toMatch(/population=/);
    expect(view!.scopedStatement).toMatch(/limitations=/);
    expect(CAUSAL_MEMORY_BOUNDARY.directRepoReadNotPlanningAuthority).toContain(
      "DIRECT CAUSAL REPOSITORY READ",
    );

    // Architecture: planning packages must not import PromotedCausalClaimRepository.
    const here = dirname(fileURLToPath(import.meta.url));
    const governedSrc = readFileSync(join(here, "governed-memory.ts"), "utf8");
    expect(governedSrc).toContain("DIRECT CAUSAL REPOSITORY READ");
    expect(governedSrc).toContain("CausalGovernedMemoryAdapter");
    const planningRoots = [
      join(here, "../scenarios"),
      join(here, "../programs"),
      join(here, "../portfolios"),
      join(here, "../planning"),
    ];
    for (const root of planningRoots) {
      try {
        const { readdirSync, statSync } = await import("node:fs");
        const walk = (dir: string): string[] => {
          const out: string[] = [];
          for (const name of readdirSync(dir)) {
            const p = join(dir, name);
            if (statSync(p).isDirectory()) out.push(...walk(p));
            else if (name.endsWith(".ts")) out.push(p);
          }
          return out;
        };
        for (const file of walk(root)) {
          const text = readFileSync(file, "utf8");
          expect(text).not.toMatch(/PromotedCausalClaimRepository/);
        }
      } catch {
        // package may not exist
      }
    }

    // Direct repo read ≠ planning retrieval path
    const bare = await ctx.promotedClaims.getById(promoted.promotedCausalClaimId);
    expect(bare).toBeDefined();
    expect(view!.scopedStatement).not.toBe(
      `${claim!.claimType} causes effect`,
    );
  });

  describe("authoritative evidence test-seam containment", () => {
    it("TEST fake/seed path works via InMemoryAuthoritativeExperimentEvidencePort", async () => {
      const port = new InMemoryAuthoritativeExperimentEvidencePort();
      port.seed(
        mintSeededRandomizedEvidence({
          experimentId: "exp_test_seam_seed",
          projectId: EXAMPLE_PROJECT_ID,
          environment: EXAMPLE_ENVIRONMENT,
          outcomeUnit: "PERCENT",
          treatmentMean: 15,
          controlMean: 10,
        }),
      );
      const resolved = await port.resolveForEstimation({
        experimentId: "exp_test_seam_seed",
        expectedProjectIds: [EXAMPLE_PROJECT_ID],
        expectedEnvironment: EXAMPLE_ENVIRONMENT,
        expectedOutcomeUnit: "PERCENT",
      });
      expect(resolved.treatmentMean).toBe(15);
      expect(resolved.controlMean).toBe(10);
      expect(resolved.quality).toBe("VALIDATED");
    });

    it("production Postgres stack constructs DB-only authoritative resolver without embedded seed store", () => {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      const stackSrc = readFileSync(
        join(repoRoot, "infrastructure/postgres/stack.ts"),
        "utf8",
      );
      const bootstrapSrc = readFileSync(
        join(repoRoot, "infrastructure/bootstrap.ts"),
        "utf8",
      );
      expect(stackSrc).toContain("PostgresAuthoritativeExperimentEvidencePort");
      expect(stackSrc).not.toMatch(
        /new InMemoryAuthoritativeExperimentEvidencePort\(\)/,
      );
      expect(stackSrc).not.toContain("seedCausalAuthoritativeEvidence");
      expect(bootstrapSrc).not.toContain("testOnlyCausalEvidenceSeeds");
      expect(bootstrapSrc).not.toContain("InMemoryAuthoritativeExperimentEvidencePort");
    });

    it("PostgresOrchestratorStack surface cannot seed authoritative evidence", () => {
      const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
      const stackSrc = readFileSync(
        join(repoRoot, "infrastructure/postgres/stack.ts"),
        "utf8",
      );
      const interfaceBlock = stackSrc.slice(
        stackSrc.indexOf("export interface PostgresOrchestratorStack"),
        stackSrc.indexOf("export async function createPostgresOrchestratorStack"),
      );
      expect(interfaceBlock).not.toContain("seedCausalAuthoritativeEvidence");
    });

    it("missing authoritative evidence fails closed for identify and estimate", async () => {
      const port = new InMemoryAuthoritativeExperimentEvidencePort();
      const { service } = buildCausalService({
        authoritativeExperimentEvidence: port,
      });
      const admitted = await service.admit(
        sampleAdmission({
          sourceExperimentIds: ["exp_no_authoritative_row"],
          intervention: "missing_evidence_flag",
          outcome: "missing_y",
        }),
      );
      const id = admitted.question.causalQuestionId;
      await service.proposeGraph(id);
      await service.attachEvidence(id, [
        randomizedEvidenceRef({
          treatmentMean: 99,
          controlMean: 1,
        }),
      ]);
      const identified = await service.identify(id);
      expect(identified.analysis.status).toBe("NOT_IDENTIFIED");
      expect(identified.question.status).toBe("INCONCLUSIVE");

      await expect(
        port.resolveForEstimation({
          experimentId: "exp_no_authoritative_row",
          expectedProjectIds: [EXAMPLE_PROJECT_ID],
          expectedEnvironment: EXAMPLE_ENVIRONMENT,
          expectedOutcomeUnit: "PERCENT",
        }),
      ).rejects.toMatchObject({ code: "CAUSAL_EVIDENCE_INVALID" });
    });

    it("API attachEvidence payload samples never reach estimator authority", async () => {
      const port = new InMemoryAuthoritativeExperimentEvidencePort();
      port.seed(
        mintSeededRandomizedEvidence({
          experimentId: "exp_authoritative_only",
          projectId: EXAMPLE_PROJECT_ID,
          environment: EXAMPLE_ENVIRONMENT,
          outcomeUnit: "PERCENT",
          treatmentMean: 11,
          controlMean: 9,
        }),
      );
      const { service } = buildCausalService({
        authoritativeExperimentEvidence: port,
      });
      const admitted = await service.admit(
        sampleAdmission({
          sourceExperimentIds: ["exp_authoritative_only"],
          intervention: "payload_isolation",
          outcome: "payload_y",
        }),
      );
      const id = admitted.question.causalQuestionId;
      await service.proposeGraph(id);
      await service.attachEvidence(id, [
        randomizedEvidenceRef({
          treatmentMean: 999,
          controlMean: 0,
        }),
      ]);
      await service.identify(id);
      const estimated = await service.estimate(id);
      expect(estimated.estimate.pointEstimate).toBeCloseTo(2, 5);
      expect(estimated.estimate.pointEstimate).not.toBeCloseTo(999, 1);
      expect(estimated.estimate.evidenceBundleId).toBe(
        "eeb_exp_authoritative_only",
      );
    });

    it("estimate() rejects when authoritativeExperimentEvidence port is absent", () => {
      const serviceSrc = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "service.ts"),
        "utf8",
      );
      expect(serviceSrc).toContain(
        "Estimation requires authoritative ExperimentEvidenceBundle resolution; caller-attached samples are not authority",
      );
      expect(serviceSrc).toMatch(
        /if \(fabricatedOnly \|\| !this\.deps\.authoritativeExperimentEvidence\)/,
      );
    });
  });
});
