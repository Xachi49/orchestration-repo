import { describe, expect, it } from "vitest";
import { ControlPlaneService } from "../control-plane/service.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { FixedClock } from "../infrastructure/index.js";
import { SequenceDecisionNonceGenerator } from "../authorization/decision-nonce.js";
import type { Program } from "../programs/program.js";
import type { ProgramCompletionRecord } from "../programs/lineage.js";
import { PORTFOLIO_TRANSITIONS } from "./portfolio-state.js";
import {
  canTransitionPortfolio,
  PORTFOLIO_AUTHORITY_BOUNDARIES,
  assertPortfolioAuthoritySeparation,
  PortfolioOrchestrationService,
  computePortfolioPlanHash,
  defaultPortfolioEnvelope,
  emptyBudgetEstimate,
  exceedsCeiling,
  FakePortfolioStrategyModel,
  InMemoryPortfolioAuthorizationRecordRepository,
  InMemoryPortfolioAuthorizationRequestRepository,
  InMemoryPortfolioBudgetLedgerRepository,
  InMemoryPortfolioBudgetReservationRepository,
  InMemoryPortfolioCompletionRepository,
  InMemoryPortfolioPlanRepository,
  InMemoryPortfolioProgramLineageRepository,
  InMemoryPortfolioRebalanceRepository,
  InMemoryPortfolioRepository,
  PortfolioProgressionLoop,
  provePortfolioGoal,
  computeConcentrationScore,
  evaluateConcentration,
  portfolioAuthorizationEnvelopeHash,
  sumAllocations,
  validatePortfolioGoals,
  validatePortfolioPlan,
  withPortfolioPlanHash,
  type Portfolio,
  type PortfolioGoal,
  type PortfolioPlan,
} from "./index.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");

function buildControlPlane(project = EXAMPLE_PROJECT) {
  return new ControlPlaneService({
    projects: new InMemoryProjectRegistry([project]),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });
}

function sampleGoals(overrides?: Partial<PortfolioGoal>[]): PortfolioGoal[] {
  const base = [
    {
      goalId: "g1",
      description: "First strategic goal",
      successCriteria: ["Criterion Alpha"],
      weight: 0.4,
      classification: "REQUIRED" as const,
      dependencies: [] as string[],
      evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
      status: "OPEN" as const,
    },
    {
      goalId: "g2",
      description: "Second strategic goal",
      successCriteria: ["Criterion Beta"],
      weight: 0.35,
      classification: "REQUIRED" as const,
      dependencies: [] as string[],
      evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
      status: "OPEN" as const,
    },
    {
      goalId: "g3",
      description: "Third strategic goal",
      successCriteria: ["Criterion Gamma"],
      weight: 0.25,
      classification: "REQUIRED" as const,
      dependencies: [] as string[],
      evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
      status: "OPEN" as const,
    },
  ];
  if (!overrides) return base;
  return base.map((g, i) => ({ ...g, ...overrides[i] }));
}

function buildPortfolioService(
  strategyModel = new FakePortfolioStrategyModel(),
) {
  const portfolios = new InMemoryPortfolioRepository();
  const plans = new InMemoryPortfolioPlanRepository();
  const service = new PortfolioOrchestrationService({
    nowIso: () => "2026-01-01T00:00:00.000Z",
    portfolios,
    plans,
    budgets: new InMemoryPortfolioBudgetLedgerRepository(),
    reservations: new InMemoryPortfolioBudgetReservationRepository(),
    lineage: new InMemoryPortfolioProgramLineageRepository(),
    authRequests: new InMemoryPortfolioAuthorizationRequestRepository(),
    authRecords: new InMemoryPortfolioAuthorizationRecordRepository(),
    completions: new InMemoryPortfolioCompletionRepository(),
    rebalances: new InMemoryPortfolioRebalanceRepository(),
    controlPlane: buildControlPlane(),
    strategyModel,
    nonceGenerator: new SequenceDecisionNonceGenerator(),
    isPortfolioAllocator: async (principalId, _projectIds) =>
      principalId === "approver_bootstrap",
  });
  return { service, portfolios, plans };
}

async function admitSamplePortfolio(
  service: PortfolioOrchestrationService,
  opts?: {
    goals?: PortfolioGoal[];
    envelope?: ReturnType<typeof defaultPortfolioEnvelope>;
    projectId?: string;
  },
) {
  const projectId = opts?.projectId ?? EXAMPLE_PROJECT_ID;
  const envelope =
    opts?.envelope ??
    defaultPortfolioEnvelope({
      projectId,
      environment: EXAMPLE_ENVIRONMENT,
    });
  return service.admit({
    portfolioId: "pfo_unit_test",
    primaryProjectId: projectId,
    requesterId: "requester_bootstrap",
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    intent: {
      portfolioName: "Unit test portfolio",
      strategicOutcome: "Prove portfolio orchestration",
      strategicGoals: ["g1", "g2", "g3"],
      constraints: ["no production deployment"],
      nonGoals: [],
      priorityPrinciples: [],
      timeHorizon: "90 days",
      requestedEnvironmentScopes: [EXAMPLE_ENVIRONMENT],
      allowedProjectScopes: [projectId],
      riskToleranceProfile: "MEDIUM",
      capitalAllocationPrinciples: [],
      successCriteria: ["All required goals satisfied"],
    },
    goals: opts?.goals ?? sampleGoals(),
    authorizationEnvelope: envelope,
    submittedAt: "2026-01-01T00:00:00.000Z",
  });
}

async function plannedPortfolio(
  service: PortfolioOrchestrationService,
  portfolioId: string,
) {
  await service.analyze(portfolioId);
  const { portfolio, plan } = await service.plan(portfolioId);
  return { portfolio, plan };
}

describe("Phase 15 portfolios", () => {
  it("allows legal portfolio state transitions and rejects illegal ones", () => {
    expect(canTransitionPortfolio("ADMITTED", "ANALYZING")).toBe(true);
    expect(canTransitionPortfolio("AWAITING_AUTHORIZATION", "AUTHORIZED")).toBe(
      true,
    );
    expect(canTransitionPortfolio("ACTIVE", "VERIFYING")).toBe(true);
    expect(canTransitionPortfolio("ADMITTED", "COMPLETED")).toBe(false);
    expect(canTransitionPortfolio("COMPLETED", "ACTIVE")).toBe(false);
    expect(canTransitionPortfolio("CANCELLED", "ANALYZING")).toBe(false);

    for (const [from, targets] of Object.entries(PORTFOLIO_TRANSITIONS)) {
      for (const to of targets) {
        expect(canTransitionPortfolio(from as Portfolio["status"], to)).toBe(
          true,
        );
      }
    }
  });

  it("canonical portfolio plan hash is stable; replan bumps version", async () => {
    const { service, plans } = buildPortfolioService();
    const admitted = await admitSamplePortfolio(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;

    const { portfolio: planned, plan: planV1 } = await plannedPortfolio(
      service,
      admitted.portfolio.portfolioId,
    );
    expect(planV1.portfolioPlanVersion).toBe(1);
    expect(planV1.portfolioPlanHash).toBe(
      computePortfolioPlanHash({
        ...planV1,
        portfolioPlanHash: undefined as never,
      }),
    );

    const storedV1 = await plans.get(
      planned.portfolioId,
      planV1.portfolioPlanVersion,
    );
    expect(storedV1?.portfolioPlanHash).toBe(planV1.portfolioPlanHash);

    await service.validate(planned.portfolioId);
    const { portfolio: replanned, plan: planV2 } = await service.plan(
      planned.portfolioId,
    );
    expect(planV2.portfolioPlanVersion).toBe(2);
    expect(planV2.portfolioPlanHash).not.toBe(planV1.portfolioPlanHash);
    expect(await plans.get(replanned.portfolioId, 1)).toEqual(storedV1);
  });

  it("rejects goal DAG cycles and negative weights", () => {
    try {
      validatePortfolioGoals([
        {
          goalId: "a",
          description: "A",
          successCriteria: ["x"],
          weight: 0.5,
          classification: "REQUIRED",
          dependencies: ["b"],
          evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
        },
        {
          goalId: "b",
          description: "B",
          successCriteria: ["y"],
          weight: 0.5,
          classification: "REQUIRED",
          dependencies: ["a"],
          evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
        },
      ]);
      expect.fail("expected cycle rejection");
    } catch (err) {
      expect(err).toMatchObject({ code: "PORTFOLIO_GRAPH_CYCLE" });
    }

    try {
      validatePortfolioGoals([
        {
          goalId: "solo",
          description: "Self",
          successCriteria: ["z"],
          weight: -0.1,
          classification: "REQUIRED",
          dependencies: [],
          evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
        },
      ]);
      expect.fail("expected negative weight rejection");
    } catch (err) {
      expect(err).toMatchObject({ code: "PORTFOLIO_GOAL_INVALID" });
    }
  });

  it("fail-closes cross-project proposals outside envelope", async () => {
    const { service } = buildPortfolioService();
    const envelope = defaultPortfolioEnvelope({
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
    });
    const admitted = await admitSamplePortfolio(service, { envelope });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;

    const { portfolio, plan } = await plannedPortfolio(
      service,
      admitted.portfolio.portfolioId,
    );
    const crossProjectPlan: PortfolioPlan = withPortfolioPlanHash({
      ...plan,
      programProposals: plan.programProposals.map((p, i) =>
        i === 0
          ? {
              ...p,
              projectId: "other_project",
              proposalId: p.proposalId,
            }
          : p,
      ),
    });
    const result = validatePortfolioPlan(portfolio, crossProjectPlan);
    expect(result.outcome).toBe("BLOCK");
    expect(
      result.findings.some((f) => f.code === "PROJECT_OUTSIDE_ENVELOPE"),
    ).toBe(true);
  });

  it("conserves budget via sumAllocations and exceedsCeiling", () => {
    const a = { ...emptyBudgetEstimate(), llmCalls: 10 };
    const b = { ...emptyBudgetEstimate(), llmCalls: 20 };
    const total = sumAllocations([a, b]);
    expect(total.llmCalls).toBe(30);

    const ceiling = { ...emptyBudgetEstimate(), llmCalls: 25 };
    expect(exceedsCeiling(total, ceiling)).toBe(true);
    expect(exceedsCeiling(a, ceiling)).toBe(false);
    expect(exceedsCeiling(b, { ...emptyBudgetEstimate(), llmCalls: 20 })).toBe(
      false,
    );
  });

  it("documents PORTFOLIO_ALLOCATOR separation from program and execution authority", () => {
    assertPortfolioAuthoritySeparation();
    expect(PORTFOLIO_AUTHORITY_BOUNDARIES.portfolioApproval).toContain(
      "not child execution",
    );
    expect(PORTFOLIO_AUTHORITY_BOUNDARIES.programMaterialization).toContain(
      "not portfolio plan",
    );
    expect(PORTFOLIO_AUTHORITY_BOUNDARIES.phase6Execution).toContain(
      "not portfolio plan",
    );
    const { service } = buildPortfolioService();
    service.assertAuthoritySeparation();
  });

  it("validatePortfolioPlan returns BLOCK vs HUMAN_APPROVAL_REQUIRED", async () => {
    const blockedSvc = buildPortfolioService();
    const tightEnvelope = defaultPortfolioEnvelope({
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
    });
    tightEnvelope.maximumProgramCount = 1;
    const blockedAdmission = await admitSamplePortfolio(blockedSvc.service, {
      envelope: tightEnvelope,
    });
    expect(blockedAdmission.outcome).toBe("ADMITTED");
    if (blockedAdmission.outcome !== "ADMITTED") return;
    const blockedPlan = await plannedPortfolio(
      blockedSvc.service,
      blockedAdmission.portfolio.portfolioId,
    );
    const blocked = validatePortfolioPlan(
      blockedPlan.portfolio,
      blockedPlan.plan,
    );
    expect(blocked.outcome).toBe("BLOCK");
    expect(
      blocked.findings.some((f) => f.code === "PORTFOLIO_PROGRAM_COUNT_EXCEEDED"),
    ).toBe(true);

    const passSvc = buildPortfolioService();
    const passAdmission = await admitSamplePortfolio(passSvc.service);
    expect(passAdmission.outcome).toBe("ADMITTED");
    if (passAdmission.outcome !== "ADMITTED") return;
    const passPlan = await plannedPortfolio(
      passSvc.service,
      passAdmission.portfolio.portfolioId,
    );
    const approvalRequired = validatePortfolioPlan(
      passPlan.portfolio,
      passPlan.plan,
    );
    expect(approvalRequired.outcome).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(
      approvalRequired.findings.some((f) => f.severity === "BLOCK"),
    ).toBe(false);
  });

  function stubProgram(
    overrides: Partial<Program> & {
      acceptanceCriteria: string[];
      status?: Program["status"];
    },
  ): Program {
    return {
      programId: overrides.programId ?? "prg_1",
      programVersion: 1,
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "r1",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Goal",
        acceptanceCriteria: overrides.acceptanceCriteria,
        nonGoals: [],
        constraints: [],
        priority: "HIGH",
      },
      status: overrides.status ?? "COMPLETED",
      delegationEnvelope: {} as Program["delegationEnvelope"],
      authorityFreeze: {} as Program["authorityFreeze"],
      decompositionRevisionCount: 0,
      maximumDecompositionRevisions: 2,
      paused: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      recordRevision: 1,
      correlationId: "c",
      traceId: "t",
      idempotencyKey: "k",
      contentFingerprint: "f",
    };
  }

  function completionFor(
    programId: string,
    criterionResults: ProgramCompletionRecord["criterionResults"],
  ): ProgramCompletionRecord {
    return {
      programCompletionRecordId: `pcr_${programId}`,
      programId,
      programVersion: 1,
      programPlanVersion: 1,
      programPlanHash: "ph",
      outcome: "VERIFIED_SUCCESS",
      criterionResults,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
  }

  it("provePortfolioGoal A: true contribution when bound criterion is proven", () => {
    const portfolio = { goals: sampleGoals() } as Portfolio;
    const program = stubProgram({
      acceptanceCriteria: ["Criterion Alpha", "Other"],
    });
    const plan = {
      goalBindings: [
        {
          bindingId: "bind_true",
          portfolioGoalId: "g1",
          programId: "prg_1",
          programCriterionId: "Criterion Alpha",
          requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
          contributionType: "PRIMARY" as const,
          contributionScore: 1,
        },
      ],
    } as PortfolioPlan;
    const result = provePortfolioGoal({
      portfolio,
      plan,
      goalId: "g1",
      lineage: [],
      programsById: new Map([["prg_1", program]]),
      programCompletionsById: new Map([
        [
          "prg_1",
          completionFor("prg_1", [
            {
              rootCriterionIndex: 0,
              satisfied: true,
              evidenceRefs: ["phase8:ov_1"],
            },
          ]),
        ],
      ]),
    });
    expect(result.status).toBe("SATISFIED");
    if (result.status === "SATISFIED") {
      expect(result.evidenceRefs.some((r) => r.includes("rootCriterionIndex:0"))).toBe(
        true,
      );
    }
  });

  it("provePortfolioGoal B: false contribution when bound criterion B is unproven", () => {
    const portfolio = {
      goals: [
        {
          goalId: "g_latency",
          description: "Retention",
          successCriteria: ["increase customer retention"],
          weight: 1,
          classification: "REQUIRED" as const,
          dependencies: [],
          evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
          status: "OPEN" as const,
        },
      ],
    } as Portfolio;
    // Program completed proving A only; binding claims B.
    const program = stubProgram({
      acceptanceCriteria: [
        "reduce API latency",
        "increase customer retention",
      ],
    });
    const plan = {
      goalBindings: [
        {
          bindingId: "bind_b",
          portfolioGoalId: "g_latency",
          programId: "prg_1",
          programCriterionId: "increase customer retention",
          requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
          contributionType: "PRIMARY" as const,
          contributionScore: 1,
        },
      ],
    } as PortfolioPlan;
    const result = provePortfolioGoal({
      portfolio,
      plan,
      goalId: "g_latency",
      lineage: [],
      programsById: new Map([["prg_1", program]]),
      programCompletionsById: new Map([
        [
          "prg_1",
          completionFor("prg_1", [
            {
              rootCriterionIndex: 0,
              satisfied: true,
              evidenceRefs: ["phase8:latency"],
            },
          ]),
        ],
      ]),
    });
    expect(result.status).not.toBe("SATISFIED");
    expect(result).toMatchObject({
      status: "INCONCLUSIVE",
      reasonCode: "CRITERION_PROOF_UNAVAILABLE",
    });
  });

  it("provePortfolioGoal C: unrelated criterion is a false binding", () => {
    const portfolio = {
      goals: [
        {
          goalId: "g_retention",
          description: "Retention",
          successCriteria: ["increase customer retention"],
          weight: 1,
          classification: "REQUIRED" as const,
          dependencies: [],
          evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
          status: "OPEN" as const,
        },
      ],
    } as Portfolio;
    const program = stubProgram({
      acceptanceCriteria: ["reduce API latency"],
    });
    const plan = {
      goalBindings: [
        {
          bindingId: "bind_unrelated",
          portfolioGoalId: "g_retention",
          programId: "prg_1",
          programCriterionId: "increase customer retention",
          requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
          contributionType: "PRIMARY" as const,
          contributionScore: 1,
        },
      ],
    } as PortfolioPlan;
    const result = provePortfolioGoal({
      portfolio,
      plan,
      goalId: "g_retention",
      lineage: [],
      programsById: new Map([["prg_1", program]]),
      programCompletionsById: new Map([
        [
          "prg_1",
          completionFor("prg_1", [
            {
              rootCriterionIndex: 0,
              satisfied: true,
              evidenceRefs: ["phase8:latency"],
            },
          ]),
        ],
      ]),
    });
    expect(result.status).toBe("UNSATISFIED");
    expect(result).toMatchObject({
      reasonCode: "FALSE_CONTRIBUTION_BINDING",
    });
  });

  it("provePortfolioGoal D: completion without criterion-level proof is INCONCLUSIVE", () => {
    const portfolio = { goals: sampleGoals() } as Portfolio;
    const program = stubProgram({
      acceptanceCriteria: ["Criterion Alpha"],
      status: "COMPLETED",
    });
    const plan = {
      goalBindings: [
        {
          bindingId: "bind_empty",
          portfolioGoalId: "g1",
          programId: "prg_1",
          programCriterionId: "Criterion Alpha",
          requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
          contributionType: "PRIMARY" as const,
          contributionScore: 1,
        },
      ],
    } as PortfolioPlan;
    const result = provePortfolioGoal({
      portfolio,
      plan,
      goalId: "g1",
      lineage: [],
      programsById: new Map([["prg_1", program]]),
      programCompletionsById: new Map([
        ["prg_1", completionFor("prg_1", [])],
      ]),
    });
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result).toMatchObject({
      reasonCode: "CRITERION_PROOF_UNAVAILABLE",
    });
  });

  it("concentration uses one canonical basis; never mixes units", () => {
    // A: 55/45 cost, ceiling 0.60 → PASS concentration
    expect(
      computeConcentrationScore(
        [
          { ...emptyBudgetEstimate(), estimatedCost: 55 },
          { ...emptyBudgetEstimate(), estimatedCost: 45 },
        ],
        "ESTIMATED_COST",
      ),
    ).toBeCloseTo(0.55, 5);

    // B: 70/30 cost, ceiling 0.60 → BLOCK
    expect(
      computeConcentrationScore(
        [
          { ...emptyBudgetEstimate(), estimatedCost: 70 },
          { ...emptyBudgetEstimate(), estimatedCost: 30 },
        ],
        "ESTIMATED_COST",
      ),
    ).toBeCloseTo(0.7, 5);

    // C: single 100, ceiling 1.0 → PASS
    expect(
      computeConcentrationScore(
        [{ ...emptyBudgetEstimate(), estimatedCost: 100 }],
        "ESTIMATED_COST",
      ),
    ).toBe(1);

    // E: mixed incomplete basis → fail closed (never mix cost with tokens)
    const mixed = evaluateConcentration(
      [
        { ...emptyBudgetEstimate(), estimatedCost: 60 },
        { ...emptyBudgetEstimate(), estimatedCost: 0, totalTokens: 100_000 },
      ],
      "ESTIMATED_COST",
    );
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect(mixed.reasonCode).toBe("INSUFFICIENT_CONCENTRATION_BASIS");
    }

    // F: TOTAL_TOKENS basis uses tokens only
    expect(
      computeConcentrationScore(
        [
          { ...emptyBudgetEstimate(), totalTokens: 70_000 },
          { ...emptyBudgetEstimate(), totalTokens: 30_000 },
        ],
        "TOTAL_TOKENS",
      ),
    ).toBeCloseTo(0.7, 5);

    // G: concentrationBasis is authority-relevant (envelope hash)
    const costEnv = defaultPortfolioEnvelope({
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
    });
    const tokenEnv = {
      ...costEnv,
      concentrationBasis: "TOTAL_TOKENS" as const,
    };
    expect(portfolioAuthorizationEnvelopeHash(costEnv)).not.toBe(
      portfolioAuthorizationEnvelopeHash(tokenEnv),
    );

    const mkPlan = (input: {
      costs: number[];
      ceiling: number;
      basis?: "ESTIMATED_COST" | "TOTAL_TOKENS";
      tokens?: number[];
    }) => {
      const basis = input.basis ?? "ESTIMATED_COST";
      const amounts = input.costs.map((estimatedCost, i) => ({
        ...emptyBudgetEstimate(),
        estimatedCost,
        totalTokens: input.tokens?.[i] ?? 0,
      }));
      const proposals = amounts.map((amount, i) => ({
        proposalId: `p${i + 1}`,
        title: `P${i + 1}`,
        requestedOutcome: "o",
        projectId: EXAMPLE_PROJECT_ID,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        repositoryScope: [] as string[],
        proposedProgramRootIntent: {
          requestedOutcome: "o",
          acceptanceCriteria: ["c"],
          nonGoals: [] as string[],
          constraints: [] as string[],
          priority: "HIGH" as const,
        },
        requestedAllocation: amount,
        goalContributionBindings: [
          {
            bindingId: `b${i + 1}`,
            portfolioGoalId: "g1",
            programProposalId: `p${i + 1}`,
            programCriterionId: "c",
            requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
            contributionType: "PRIMARY" as const,
            contributionScore: 1,
          },
        ],
        programDependencies: [] as string[],
        priorityRecommendation: 50,
        riskClassification: "LOW" as const,
        disposition: "CREATE_PROGRAM" as const,
      }));
      const evalResult = evaluateConcentration(amounts, basis);
      const plan = withPortfolioPlanHash({
        portfolioId: "pfo",
        portfolioVersion: 1,
        portfolioPlanVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        goalBindings: proposals.flatMap((p) => p.goalContributionBindings),
        programProposals: proposals,
        existingProgramDispositions: [],
        proposedAllocations: amounts.map((amount, i) => ({
          proposalId: `p${i + 1}`,
          amount,
        })),
        dependencies: [],
        riskAssessment: {
          overallRisk: "LOW",
          concentrationScore: evalResult.ok ? evalResult.score : 1,
          concentrationBasis: basis,
          notes: [],
        },
        expectedGoalContributions: ["g1"],
        requiredHumanDecisions: [],
        policyBundleFingerprint: "p",
        capabilitySetFingerprint: "c",
        budgetConfigurationFingerprint: "b",
        projectConfigurationFingerprint: "j",
        repositoryAllowlistFingerprint: "r",
        environmentScopeFingerprint: "e",
        authorizationEnvelopeHash: "a",
        allocationPlanHash: "al",
        strategyModelId: "fake",
        strategyModelVersion: "1",
      });
      const portfolio = {
        goals: [
          {
            goalId: "g1",
            description: "g",
            successCriteria: ["c"],
            weight: 1,
            classification: "REQUIRED",
            dependencies: [],
            evidenceRequirements: ["PROGRAM_COMPLETION_AUTHORITY"],
            status: "OPEN",
          },
        ],
        portfolioId: "pfo",
        portfolioVersion: 1,
        authorizationEnvelope: {
          ...defaultPortfolioEnvelope({
            projectId: EXAMPLE_PROJECT_ID,
            environment: EXAMPLE_ENVIRONMENT,
          }),
          allocationConcentrationCeiling: input.ceiling,
          concentrationBasis: basis,
        },
        authorityFreeze: { authorizationEnvelopeHash: "a" },
      } as Portfolio;
      return { plan, portfolio };
    };

    const a = mkPlan({ costs: [55, 45], ceiling: 0.6 });
    expect(
      validatePortfolioPlan(a.portfolio, a.plan).findings.some(
        (f) => f.code === "CONCENTRATION_LIMIT",
      ),
    ).toBe(false);
    expect(
      validatePortfolioPlan(a.portfolio, a.plan).findings.some(
        (f) => f.code === "INSUFFICIENT_CONCENTRATION_BASIS",
      ),
    ).toBe(false);

    const b = mkPlan({ costs: [70, 30], ceiling: 0.6 });
    expect(
      validatePortfolioPlan(b.portfolio, b.plan).findings.some(
        (f) => f.code === "CONCENTRATION_LIMIT",
      ),
    ).toBe(true);

    const c = mkPlan({ costs: [100], ceiling: 1.0 });
    expect(
      validatePortfolioPlan(c.portfolio, c.plan).findings.some(
        (f) => f.code === "CONCENTRATION_LIMIT",
      ),
    ).toBe(false);

    const d = mkPlan({ costs: [100], ceiling: 0.6 });
    expect(
      validatePortfolioPlan(d.portfolio, d.plan).findings.some(
        (f) => f.code === "CONCENTRATION_LIMIT",
      ),
    ).toBe(true);

    const e = mkPlan({
      costs: [60, 0],
      tokens: [0, 100_000],
      ceiling: 1.0,
    });
    expect(
      validatePortfolioPlan(e.portfolio, e.plan).findings.some(
        (f) => f.code === "INSUFFICIENT_CONCENTRATION_BASIS",
      ),
    ).toBe(true);

    const f = mkPlan({
      costs: [0, 0],
      tokens: [55_000, 45_000],
      ceiling: 0.6,
      basis: "TOTAL_TOKENS",
    });
    expect(
      validatePortfolioPlan(f.portfolio, f.plan).findings.some(
        (f) =>
          f.code === "CONCENTRATION_LIMIT" ||
          f.code === "INSUFFICIENT_CONCENTRATION_BASIS",
      ),
    ).toBe(false);
  });

  it("PortfolioProgressionLoop only produces work discovery, never advances state", async () => {
    const { service, portfolios } = buildPortfolioService();
    const admitted = await admitSamplePortfolio(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    let discovered: string[] = [];
    const loop = new PortfolioProgressionLoop({
      portfolios,
      materializer: {
        discoverBatch: async (ids: readonly string[]) => {
          discovered = [...ids];
          return { created: [], reused: [] };
        },
      } as never,
    });
    await loop.tick();
    expect(discovered).toContain(admitted.portfolio.portfolioId);
    const after = await portfolios.getById(admitted.portfolio.portfolioId);
    expect(after?.status).toBe("ADMITTED");
  });

  it("PORTFOLIO_ALLOCATOR must cover full project scope (intersection)", async () => {
    const granted = new Set<string>();
    const portfolios = new InMemoryPortfolioRepository();
    const plans = new InMemoryPortfolioPlanRepository();
    const service = new PortfolioOrchestrationService({
      nowIso: () => "2026-01-01T00:00:00.000Z",
      portfolios,
      plans,
      budgets: new InMemoryPortfolioBudgetLedgerRepository(),
      reservations: new InMemoryPortfolioBudgetReservationRepository(),
      lineage: new InMemoryPortfolioProgramLineageRepository(),
      authRequests: new InMemoryPortfolioAuthorizationRequestRepository(),
      authRecords: new InMemoryPortfolioAuthorizationRecordRepository(),
      completions: new InMemoryPortfolioCompletionRepository(),
      rebalances: new InMemoryPortfolioRebalanceRepository(),
      controlPlane: buildControlPlane(),
      strategyModel: new FakePortfolioStrategyModel(),
      nonceGenerator: new SequenceDecisionNonceGenerator(),
      authorizationNonceStore: {
        map: new Map<string, string>(),
        async put(id, plaintext) {
          this.map.set(id, plaintext);
        },
        async take(id) {
          const v = this.map.get(id) ?? null;
          return v;
        },
      },
      isPortfolioAllocator: async (_principalId, projectIds) =>
        projectIds.every((id) => granted.has(id)),
    });

    const envelope = {
      ...defaultPortfolioEnvelope({
        projectId: "proj_a",
        environment: EXAMPLE_ENVIRONMENT,
      }),
      allowedProjectIds: ["proj_a", "proj_b", "proj_c"],
      crossProjectDelegationAllowed: true,
      maximumCrossProjectPrograms: 3,
      allocationConcentrationCeiling: 1,
    };
    // Control plane only has EXAMPLE project — use primary EXAMPLE for resolve,
    // but envelope lists A/B/C for allocator scope check.
    const envelopeWithPrimary = {
      ...envelope,
      allowedProjectIds: [EXAMPLE_PROJECT_ID, "proj_b", "proj_c"],
    };
    const admitted = await admitSamplePortfolio(service, {
      envelope: envelopeWithPrimary,
      goals: sampleGoals().slice(0, 1),
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.analyze(admitted.portfolio.portfolioId);
    await service.plan(admitted.portfolio.portfolioId);
    await service.validate(admitted.portfolio.portfolioId);
    const routed = await service.routeAuthorization(
      admitted.portfolio.portfolioId,
    );

    granted.clear();
    granted.add(EXAMPLE_PROJECT_ID);
    await expect(
      service.decideAuthorization({
        authorizationId: routed.request.authorizationId,
        allocatorId: "alloc_partial",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PORTFOLIO_AUTHORIZATION_INVALID" });

    granted.add("proj_b");
    await expect(
      service.decideAuthorization({
        authorizationId: routed.request.authorizationId,
        allocatorId: "alloc_partial",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PORTFOLIO_AUTHORIZATION_INVALID" });

    granted.add("proj_c");
    const decided = await service.decideAuthorization({
      authorizationId: routed.request.authorizationId,
      allocatorId: "alloc_full",
      decision: "APPROVE",
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(decided.portfolio.status).toBe("AUTHORIZED");
    expect(decided.record?.decision).toBe("APPROVE");
  });

  it("Fake strategy recommendations do not mutate portfolio authority", async () => {
    const { service, portfolios } = buildPortfolioService();
    const admitted = await admitSamplePortfolio(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;

    const before = await portfolios.getById(admitted.portfolio.portfolioId);
    expect(before?.status).toBe("ADMITTED");
    const envelopeHashBefore =
      before!.authorityFreeze.authorizationEnvelopeHash;

    await service.analyze(admitted.portfolio.portfolioId);
    const analyzing = await portfolios.getById(admitted.portfolio.portfolioId);
    expect(analyzing?.status).toBe("ANALYZING");

    await service.plan(admitted.portfolio.portfolioId);
    const afterPlan = await portfolios.getById(admitted.portfolio.portfolioId);
    expect(afterPlan?.status).toBe("PLANNED");
    expect(afterPlan?.authorityFreeze.authorizationEnvelopeHash).toBe(
      envelopeHashBefore,
    );
    expect(afterPlan?.portfolioPlanVersion).toBe(1);
    expect(
      afterPlan?.authorizationEnvelope.maximumProgramCount,
    ).toBe(before?.authorizationEnvelope.maximumProgramCount);
  });

  it("rejects admission when primary project is outside envelope", async () => {
    const { service } = buildPortfolioService();
    const envelope = defaultPortfolioEnvelope({
      projectId: "allowed_only",
      environment: EXAMPLE_ENVIRONMENT,
    });
    await expect(
      service.admit({
        portfolioId: "pfo_bad_scope",
        primaryProjectId: EXAMPLE_PROJECT_ID,
        requesterId: "requester_bootstrap",
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        intent: {
          portfolioName: "Bad scope",
          strategicOutcome: "Should fail",
          strategicGoals: ["g1"],
          constraints: [],
          nonGoals: [],
          priorityPrinciples: [],
          timeHorizon: "30 days",
          requestedEnvironmentScopes: [EXAMPLE_ENVIRONMENT],
          allowedProjectScopes: [EXAMPLE_PROJECT_ID],
          riskToleranceProfile: "LOW",
          capitalAllocationPrinciples: [],
          successCriteria: ["n/a"],
        },
        goals: sampleGoals().slice(0, 1),
        authorizationEnvelope: envelope,
        submittedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_OUTSIDE_ENVELOPE" });
  });

  it("compiled plan requires human allocator approval without mutating envelope", async () => {
    const { service } = buildPortfolioService();
    const admitted = await admitSamplePortfolio(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const { portfolio, plan } = await plannedPortfolio(
      service,
      admitted.portfolio.portfolioId,
    );
    expect(plan.requiredHumanDecisions).toContain(
      "PORTFOLIO_ALLOCATOR_APPROVAL",
    );
    expect(plan.authorizationEnvelopeHash).toBe(
      portfolio.authorityFreeze.authorizationEnvelopeHash,
    );
    const validated = await service.validate(admitted.portfolio.portfolioId);
    expect(validated.result.outcome).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(validated.portfolio.status).toBe("AWAITING_AUTHORIZATION");
  });
});
