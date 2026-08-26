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
import {
  InMemorySchedulerProjectConfigRepository,
  InMemorySchedulerWorkItemRepository,
} from "../scheduling/index.js";
import { PortfolioIntentSchema } from "../portfolio/intent.js";
import { DECISION_PROBLEM_TRANSITIONS } from "./decision-state.js";
import {
  ScenarioOrchestrationService,
  FakeScenarioGenerationModel,
  FakeScenarioSimulationEngine,
  FakePortfolioProposalAdmissionPort,
  ScenarioProgressionLoop,
  ScenarioWorkMaterializer,
  assertCompatibleUnits,
  assumptionSetHash,
  withAssumptionSetHash,
  canTransitionDecisionProblem,
  compareScenarios,
  scenarioDominates,
  checkHardConstraints,
  computeDecisionPackageHash,
  withDecisionPackageHash,
  MODEL_WEIGHT_AUTHORITY,
  mintSimulationRunId,
  simulationInputFingerprint,
  simulationConfigurationFingerprint,
  SIMULATION_ENGINE_VERSION,
  SCENARIO_DOCTRINE,
  labelScenarioEvidence,
  SCENARIO_EVIDENCE_AUTHORITY_CLASSES,
  withScenarioSetHash,
  mintScenarioSetId,
  mintScenarioId,
  runSensitivity,
  assertScenarioAuthoritySeparation,
  assertSelectionDoesNotAllocateCapital,
  compileProposedPortfolioIntent,
  STRATEGY_SELECTION_AUTHORITY_BOUNDARIES,
  SCENARIO_AUTHORITY_BOUNDARIES,
  isScenarioError,
  type DecisionCriterion,
  type ScenarioAssumption,
  type ScenarioSimulationResult,
} from "./index.js";
import {
  InMemoryDecisionProblemRepository,
  InMemoryScenarioSetRepository,
  InMemorySimulationResultRepository,
  InMemoryDecisionPackageRepository,
  InMemoryStrategySelectionRequestRepository,
  InMemoryStrategySelectionRecordRepository,
  InMemoryScenarioPortfolioLineageRepository,
  InMemorySimulationUsageLedgerRepository,
} from "./memory-repositories.js";
import { validateDecisionPackage } from "./validator.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");

const PROJECT_A = "proj_a";
const PROJECT_B = "proj_b";
const PROJECT_C = "proj_c";

/** Principal → set of projects with explicit STRATEGY_SELECTOR grants. */
function buildStrategySelectorChecker(
  grants: ReadonlyMap<string, ReadonlySet<string>>,
): (principalId: string, projectIds: readonly string[]) => Promise<boolean> {
  return async (principalId, projectIds) => {
    const held = grants.get(principalId);
    if (!held) return false;
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return false;
    return unique.every((projectId) => held.has(projectId));
  };
}

const DEFAULT_SELECTOR_GRANTS = new Map<string, ReadonlySet<string>>([
  [
    "strategy_selector_full",
    new Set([EXAMPLE_PROJECT_ID, PROJECT_A, PROJECT_B, PROJECT_C]),
  ],
  ["selector_ab", new Set([EXAMPLE_PROJECT_ID, PROJECT_B])],
  ["selector_a_only", new Set([EXAMPLE_PROJECT_ID])],
]);

function buildControlPlane(project = EXAMPLE_PROJECT) {
  return new ControlPlaneService({
    projects: new InMemoryProjectRegistry([project]),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });
}

function sampleDecisionCriteria(
  overrides?: Partial<DecisionCriterion>[],
): DecisionCriterion[] {
  const base: DecisionCriterion[] = [
    {
      criterionId: "c_expected_value",
      name: "Expected strategic value",
      kind: "EXPECTED_VALUE",
      weight: 0.4,
      higherIsBetter: true,
    },
    {
      criterionId: "c_risk",
      name: "Downside risk",
      kind: "RISK",
      weight: 0.35,
      higherIsBetter: false,
    },
    {
      criterionId: "c_goal_coverage",
      name: "Goal coverage",
      kind: "GOAL_COVERAGE",
      weight: 0.25,
      higherIsBetter: true,
    },
  ];
  if (!overrides) return base;
  return base.map((c, i) => ({ ...c, ...overrides[i] }));
}

function buildScenarioService(opts?: {
  simulationFailpoint?: {
    hit(newResultCount: number): Promise<void>;
  };
  selectorGrants?: ReadonlyMap<string, ReadonlySet<string>>;
  portfolioAdmissionPort?: FakePortfolioProposalAdmissionPort;
  omitPortfolioAdmissionPort?: boolean;
  materializationFailpoint?: {
    afterLineagePersist?(): Promise<void>;
  };
  projects?: typeof EXAMPLE_PROJECT[];
}) {
  const decisionProblems = new InMemoryDecisionProblemRepository();
  const scenarioSets = new InMemoryScenarioSetRepository();
  const simulationResults = new InMemorySimulationResultRepository();
  const decisionPackages = new InMemoryDecisionPackageRepository();
  const selectionRequests = new InMemoryStrategySelectionRequestRepository();
  const selectionRecords = new InMemoryStrategySelectionRecordRepository();
  const lineage = new InMemoryScenarioPortfolioLineageRepository();
  const usageLedger = new InMemorySimulationUsageLedgerRepository();
  const nonceStore = new Map<string, string>();
  const portfolioAdmissionPort =
    opts?.omitPortfolioAdmissionPort === true
      ? undefined
      : (opts?.portfolioAdmissionPort ?? new FakePortfolioProposalAdmissionPort());

  const controlPlaneProjects = opts?.projects ?? [EXAMPLE_PROJECT];
  const projects = new InMemoryProjectRegistry(controlPlaneProjects);
  const service = new ScenarioOrchestrationService({
    nowIso: () => "2026-01-01T00:00:00.000Z",
    decisionProblems,
    scenarioSets,
    simulationResults,
    decisionPackages,
    selectionRequests,
    selectionRecords,
    lineage,
    usageLedger,
    controlPlane: new ControlPlaneService({
      projects,
      capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
      policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
      budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
      clock,
    }),
    generationModel: new FakeScenarioGenerationModel(),
    simulationEngine: new FakeScenarioSimulationEngine(),
    nonceGenerator: new SequenceDecisionNonceGenerator(),
    selectionNonceStore: {
      put: async (id, plaintext) => {
        nonceStore.set(id, plaintext);
      },
      take: async (id) => nonceStore.get(id) ?? null,
    },
    isStrategySelector: buildStrategySelectorChecker(
      opts?.selectorGrants ?? DEFAULT_SELECTOR_GRANTS,
    ),
    ...(portfolioAdmissionPort !== undefined
      ? { portfolioAdmissionPort }
      : {}),
    ...(opts?.simulationFailpoint
      ? { simulationFailpoint: opts.simulationFailpoint }
      : {}),
    ...(opts?.materializationFailpoint
      ? { materializationFailpoint: opts.materializationFailpoint }
      : {}),
  });

  const materializer = new ScenarioWorkMaterializer({
    nowIso: () => "2026-01-01T00:00:00.000Z",
    decisionProblems,
    scenarioSets,
    decisionPackages,
    workItems: new InMemorySchedulerWorkItemRepository(),
    projectConfigs: new InMemorySchedulerProjectConfigRepository(),
  });

  const progression = new ScenarioProgressionLoop({
    decisionProblems,
    materializer,
  });

  return {
    service,
    decisionProblems,
    scenarioSets,
    simulationResults,
    decisionPackages,
    selectionRequests,
    selectionRecords,
    lineage,
    materializer,
    progression,
    portfolioAdmissionPort,
  };
}

async function admitSampleDecisionProblem(
  service: ScenarioOrchestrationService,
  opts?: {
    criteria?: DecisionCriterion[];
    projectId?: string;
    maximumSensitivityEvaluations?: number;
  },
) {
  const projectId = opts?.projectId ?? EXAMPLE_PROJECT_ID;
  return service.admit({
    primaryProjectId: projectId,
    question: "Which strategic trajectory should we pursue next quarter?",
    strategicObjective: "Maximize durable goal coverage under budget",
    decisionCriteria: opts?.criteria ?? sampleDecisionCriteria(),
    timeHorizon: "90 days",
    constraints: ["no production deployment"],
    nonGoals: ["Autonomous capital allocation"],
    allowedProjectIds: [projectId],
    allowedEnvironments: [EXAMPLE_ENVIRONMENT],
    riskTolerance: "MEDIUM",
    createdBy: "requester_bootstrap",
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    submittedAt: "2026-01-01T00:00:00.000Z",
    ...(opts?.maximumSensitivityEvaluations !== undefined
      ? { maximumSensitivityEvaluations: opts.maximumSensitivityEvaluations }
      : {}),
  });
}

async function ladderToAwaitingSelection(service: ScenarioOrchestrationService) {
  const admitted = await admitSampleDecisionProblem(service);
  expect(admitted.outcome).toBe("ADMITTED");
  if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
  const id = admitted.problem.decisionProblemId;
  await service.ground(id);
  await service.generateScenarios(id);
  await service.simulateAll(id, "unit-test-seed");
  await service.analyze(id);
  const validated = await service.validatePackage(id);
  expect(validated.problem.status).toBe("AWAITING_SELECTION");
  return { id, pkg: validated.pkg, problem: validated.problem };
}

function sampleAssumptions(): ScenarioAssumption[] {
  return [
    {
      assumptionId: "asm_a",
      name: "Growth",
      description: "Growth assumption",
      value: 0.1,
      unit: "PERCENT",
      sourceClass: "ASSUMPTION",
      confidenceClassification: "MEDIUM",
      lowerBound: 0.05,
      upperBound: 0.15,
      sensitivityEligible: true,
      materiality: "HIGH",
    },
    {
      assumptionId: "asm_b",
      name: "Cost",
      description: "Cost assumption",
      value: 0.03,
      unit: "PERCENT",
      sourceClass: "ASSUMPTION",
      confidenceClassification: "MEDIUM",
      lowerBound: 0.01,
      upperBound: 0.06,
      sensitivityEligible: false,
      materiality: "MEDIUM",
    },
  ];
}

function fakeSimResult(
  overrides: Partial<ScenarioSimulationResult> & {
    scenarioId: string;
    criterionScores: Record<string, number>;
  },
): ScenarioSimulationResult {
  const inputFp = simulationInputFingerprint({
    decisionProblemVersion: 1,
    scenarioId: overrides.scenarioId,
    assumptionSetHash: "asm_hash",
    truthSnapshotFingerprint: "truth_fp",
    engineVersion: SIMULATION_ENGINE_VERSION,
    configurationFingerprint: simulationConfigurationFingerprint({
      maximumScenarioCount: 12,
      maximumSimulationRuns: 50,
    }),
    randomSeed: "seed",
  });
  return {
    simulationRunId: mintSimulationRunId({
      scenarioId: overrides.scenarioId,
      inputFingerprint: inputFp,
    }),
    scenarioId: overrides.scenarioId,
    scenarioSetId: "scs_test",
    scenarioSetVersion: 1,
    decisionProblemId: "sdp_test",
    decisionProblemVersion: 1,
    inputFingerprint: inputFp,
    assumptionSetHash: "asm_hash",
    truthSnapshotFingerprint: "truth_fp",
    engineVersion: SIMULATION_ENGINE_VERSION,
    configurationFingerprint: simulationConfigurationFingerprint({
      maximumScenarioCount: 12,
      maximumSimulationRuns: 50,
    }),
    randomSeed: "seed",
    expectedOutcomes: [],
    riskMetrics: [],
    resourceRequirements: [],
    estimatedPortfolioEffects: [],
    goalEffects: [],
    distributionSummary: "",
    uncertainty: {
      assumptionSensitivity: "UNKNOWN",
      evidenceQuality: "UNKNOWN",
      modelUncertaintyClass: "UNKNOWN",
      confidenceWithoutProvenance: "UNKNOWN",
    },
    sensitivityCandidates: [],
    limitations: [],
    criterionScores: overrides.criterionScores,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("Phase 16 scenario intelligence", () => {
  it("allows legal decision problem transitions and rejects illegal ones", () => {
    expect(canTransitionDecisionProblem("ADMITTED", "GROUNDING")).toBe(true);
    expect(canTransitionDecisionProblem("AWAITING_SELECTION", "SELECTED")).toBe(
      true,
    );
    expect(canTransitionDecisionProblem("SELECTED", "MATERIALIZED_AS_PROPOSAL")).toBe(
      true,
    );
    expect(canTransitionDecisionProblem("ADMITTED", "COMPLETED" as never)).toBe(
      false,
    );
    expect(canTransitionDecisionProblem("MATERIALIZED_AS_PROPOSAL", "ADMITTED")).toBe(
      false,
    );
    expect(canTransitionDecisionProblem("CANCELLED", "GROUNDING")).toBe(false);

    for (const [from, targets] of Object.entries(DECISION_PROBLEM_TRANSITIONS)) {
      for (const to of targets) {
        expect(
          canTransitionDecisionProblem(
            from as keyof typeof DECISION_PROBLEM_TRANSITIONS,
            to,
          ),
        ).toBe(true);
      }
    }
  });

  it("assumption set hash is stable; changing an assumption yields a new hash", () => {
    const assumptions = sampleAssumptions();
    const h1 = assumptionSetHash(assumptions);
    const h2 = assumptionSetHash(assumptions);
    expect(h1).toBe(h2);

    const changed = assumptions.map((a) =>
      a.assumptionId === "asm_a" ? { ...a, value: 0.11 } : a,
    );
    expect(assumptionSetHash(changed)).not.toBe(h1);
    expect(withAssumptionSetHash(assumptions).assumptionSetHash).toBe(h1);
  });

  it("separates truth from assumptions via SCENARIO_DOCTRINE and evidence classes", () => {
    expect(SCENARIO_DOCTRINE.currentTruthNotAssumption).toContain("!=");
    expect(SCENARIO_DOCTRINE.assumptionNotEvidence).toContain("!=");
    expect(SCENARIO_DOCTRINE.selectionNotPortfolioAuthorization).toContain("!=");
    expect(SCENARIO_EVIDENCE_AUTHORITY_CLASSES).toContain(
      "CURRENT_CONTROL_PLANE_TRUTH",
    );
    expect(SCENARIO_EVIDENCE_AUTHORITY_CLASSES).toContain("ASSUMPTION");
    expect(SCENARIO_EVIDENCE_AUTHORITY_CLASSES).toContain("MODEL_ESTIMATE");

    const truth = labelScenarioEvidence(
      "CURRENT_CONTROL_PLANE_TRUTH",
      "policy",
      { hash: "abc" },
    );
    const assumption = labelScenarioEvidence("ASSUMPTION", "growth", 0.08);
    expect(truth.authorityClass).not.toBe(assumption.authorityClass);
  });

  it("requires baseline scenario and rejects invalid scenario sets", () => {
    const scenarioSetId = mintScenarioSetId({
      decisionProblemId: "sdp_x",
      scenarioSetVersion: 1,
    });
    const baselineId = mintScenarioId({
      scenarioSetId,
      name: "Baseline",
    });
    const orphanId = mintScenarioId({
      scenarioSetId,
      name: "Orphan",
    });

    expect(() =>
      withScenarioSetHash({
        scenarioSetId,
        scenarioSetVersion: 1,
        decisionProblemId: "sdp_x",
        decisionProblemVersion: 1,
        scenarios: [
          {
            scenarioId: orphanId,
            scenarioSetId,
            name: "No baseline",
            description: "Missing baseline role",
            roleHint: "UPSIDE",
            assumptionOverrides: [],
            strategicActionsProposed: [],
            expectedTimeHorizon: "90 days",
            riskFactors: [],
            dependencies: [],
          },
        ],
        baselineScenarioId: baselineId,
        assumptionSetHash: "hash",
        truthSnapshotFingerprint: "truth",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow(/Baseline scenario/);

    const valid = withScenarioSetHash({
      scenarioSetId,
      scenarioSetVersion: 1,
      decisionProblemId: "sdp_x",
      decisionProblemVersion: 1,
      scenarios: [
        {
          scenarioId: baselineId,
          scenarioSetId,
          name: "Baseline",
          description: "Baseline continuation",
          roleHint: "BASELINE",
          assumptionOverrides: [],
          strategicActionsProposed: [],
          expectedTimeHorizon: "90 days",
          riskFactors: [],
          dependencies: [],
        },
      ],
      baselineScenarioId: baselineId,
      assumptionSetHash: "hash",
      truthSnapshotFingerprint: "truth",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(valid.baselineScenarioId).toBe(baselineId);
    expect(valid.scenarioSetHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unit mixing via assertCompatibleUnits", () => {
    try {
      assertCompatibleUnits("USD", "TOKENS", "add quantities");
      expect.fail("expected unit mixing rejection");
    } catch (error) {
      expect(isScenarioError(error)).toBe(true);
      if (isScenarioError(error)) {
        expect(error.code).toBe("UNIT_MIXING_REJECTED");
      }
    }
    expect(() =>
      assertCompatibleUnits("USD", "USD", "add quantities"),
    ).not.toThrow();
    try {
      assertCompatibleUnits("UNKNOWN", "USD", "compare");
      expect.fail("expected UNKNOWN unit rejection");
    } catch (error) {
      expect(isScenarioError(error)).toBe(true);
      if (isScenarioError(error)) {
        expect(error.code).toBe("UNIT_MIXING_REJECTED");
      }
    }
  });

  it("replays deterministic simulation results for identical FakeScenarioSimulationEngine inputs", async () => {
    const engine = new FakeScenarioSimulationEngine();
    const scenarioSetId = mintScenarioSetId({
      decisionProblemId: "sdp_det",
      scenarioSetVersion: 1,
    });
    const scenarioId = mintScenarioId({
      scenarioSetId,
      name: "Baseline",
    });
    const criteria = sampleDecisionCriteria();
    const input = {
      decisionProblemId: "sdp_det",
      decisionProblemVersion: 1,
      scenario: {
        scenarioId,
        scenarioSetId,
        name: "Baseline",
        description: "d",
        roleHint: "BASELINE" as const,
        assumptionOverrides: [],
        strategicActionsProposed: [],
        expectedTimeHorizon: "90 days",
        riskFactors: [],
        dependencies: [],
      },
      scenarioSetId,
      scenarioSetVersion: 1,
      assumptionSetHash: "asm_det",
      truthSnapshotFingerprint: "truth_det",
      randomSeed: "replay-seed-42",
      decisionCriteria: criteria,
      maximumScenarioCount: 12,
      maximumSimulationRuns: 50,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const r1 = await engine.simulate(input);
    const r2 = await engine.simulate(input);
    expect(r1).toEqual(r2);
    expect(r1.simulationRunId).toBe(r2.simulationRunId);
    expect(r1.criterionScores).toEqual(r2.criterionScores);
  });

  it("mintSimulationRunId is stable for the same scenario and input fingerprint", () => {
    const inputFp = "abcdef0123456789";
    const id1 = mintSimulationRunId({
      scenarioId: "scn_a",
      inputFingerprint: inputFp,
    });
    const id2 = mintSimulationRunId({
      scenarioId: "scn_a",
      inputFingerprint: inputFp,
    });
    expect(id1).toBe(id2);
    expect(
      mintSimulationRunId({
        scenarioId: "scn_b",
        inputFingerprint: inputFp,
      }),
    ).not.toBe(id1);
  });

  it("compareScenarios and scenarioDominates are deterministic", () => {
    const criteria = sampleDecisionCriteria();
    const results = [
      fakeSimResult({
        scenarioId: "scn_base",
        criterionScores: {
          c_expected_value: 0.5,
          c_risk: 0.4,
          c_goal_coverage: 0.6,
        },
      }),
      fakeSimResult({
        scenarioId: "scn_up",
        criterionScores: {
          c_expected_value: 0.7,
          c_risk: 0.3,
          c_goal_coverage: 0.65,
        },
      }),
      fakeSimResult({
        scenarioId: "scn_down",
        criterionScores: {
          c_expected_value: 0.4,
          c_risk: 0.6,
          c_goal_coverage: 0.5,
        },
      }),
    ];

    const c1 = compareScenarios({
      criteria,
      baselineScenarioId: "scn_base",
      results,
    });
    const c2 = compareScenarios({
      criteria,
      baselineScenarioId: "scn_base",
      results,
    });
    expect(c1).toEqual(c2);
    expect(c1.rankingDisclaimer).toMatch(/STRATEGY_SELECTOR/);
    expect(c1.rankedScenarios[0]!.rank).toBe(1);

    const up = results.find((r) => r.scenarioId === "scn_up")!;
    const down = results.find((r) => r.scenarioId === "scn_down")!;
    expect(scenarioDominates(up, down, criteria)).toBe(true);
    expect(scenarioDominates(down, up, criteria)).toBe(false);
  });

  it("hard constraint violators are never recommended even with highest score", () => {
    const criteria: DecisionCriterion[] = [
      {
        criterionId: "c_min_value",
        name: "Minimum value",
        kind: "EXPECTED_VALUE",
        weight: 1,
        higherIsBetter: true,
        hardConstraint: { min: 0.8 },
      },
    ];
    const results = [
      fakeSimResult({
        scenarioId: "scn_high_but_violates",
        // Would win weighted score but fails hard constraint
        criterionScores: { c_min_value: 0.5 },
      }),
      fakeSimResult({
        scenarioId: "scn_eligible",
        criterionScores: { c_min_value: 0.85 },
      }),
    ];

    const comparison = compareScenarios({
      criteria,
      baselineScenarioId: "scn_eligible",
      results,
    });
    expect(comparison.hardConstraintViolations.length).toBeGreaterThan(0);
    expect(
      comparison.rankedScenarios.map((r) => r.scenarioId),
    ).not.toContain("scn_high_but_violates");
    expect(comparison.rankedScenarios[0]!.scenarioId).toBe("scn_eligible");
  });

  it("runSensitivity evaluates only bounded eligible assumptions within budget", async () => {
    const assumptions = sampleAssumptions();
    const criteria = sampleDecisionCriteria();
    const results = [
      fakeSimResult({
        scenarioId: "scn_a",
        criterionScores: {
          c_expected_value: 0.6,
          c_risk: 0.4,
          c_goal_coverage: 0.5,
        },
      }),
    ];
    const comparison = compareScenarios({
      criteria,
      baselineScenarioId: "scn_a",
      results,
    });
    const problem = {
      maximumSensitivityEvaluations: 1,
    } as Parameters<typeof runSensitivity>[0]["decisionProblem"];

    const sensitivity = await runSensitivity({
      decisionProblem: problem,
      assumptions,
      results,
      comparison,
      evaluatePerturbation: async () => 0.55,
    });

    expect(sensitivity.evaluationBudget).toBe(1);
    expect(sensitivity.evaluationsPerformed).toBe(1);
    expect(sensitivity.truncated).toBe(true);
    expect(
      sensitivity.findings.every((f) => f.assumptionId === "asm_a"),
    ).toBe(true);
    expect(sensitivity.findings.some((f) => f.assumptionId === "asm_b")).toBe(
      false,
    );
  });

  it("decision package hash is stable; mutating payload changes hash", () => {
    const criteria = sampleDecisionCriteria();
    const results = [
      fakeSimResult({
        scenarioId: "scn_base",
        criterionScores: {
          c_expected_value: 0.5,
          c_risk: 0.4,
          c_goal_coverage: 0.6,
        },
      }),
    ];
    const comparison = compareScenarios({
      criteria,
      baselineScenarioId: "scn_base",
      results,
    });
    const base = {
      decisionPackageId: "sdpkg_hash",
      decisionPackageVersion: 1,
      decisionProblemId: "sdp_hash",
      decisionProblemVersion: 1,
      scenarioSetId: "scs_hash",
      scenarioSetVersion: 1,
      scenarioSetHash: "set_hash",
      authoritativeDecisionCriteria: criteria,
      simulationResults: results,
      comparison,
      sensitivity: {
        findings: [],
        evaluationsPerformed: 0,
        evaluationBudget: 64,
        truncated: false,
      },
      recommendedScenarioIds: ["scn_base"],
      limitations: ["test"],
      requiredHumanDecisions: ["STRATEGY_SELECTOR"] as const,
      policyBundleFingerprint: "p",
      capabilitySetFingerprint: "c",
      projectConfigurationFingerprint: "j",
      truthSnapshotFingerprint: "truth_fp",
      assumptionSetHash: "asm_hash",
      generationModelId: "fake",
      generationModelVersion: "1",
      simulationEngineVersion: SIMULATION_ENGINE_VERSION,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const pkg1 = withDecisionPackageHash(base);
    const pkg2 = withDecisionPackageHash(base);
    expect(pkg1.decisionPackageHash).toBe(pkg2.decisionPackageHash);
    expect(computeDecisionPackageHash(base)).toBe(pkg1.decisionPackageHash);

    const mutated = withDecisionPackageHash({
      ...base,
      limitations: ["test", "changed"],
    });
    expect(mutated.decisionPackageHash).not.toBe(pkg1.decisionPackageHash);
  });

  it("documents STRATEGY_SELECTOR authority separation hooks", () => {
    assertScenarioAuthoritySeparation();
    assertSelectionDoesNotAllocateCapital();
    expect(STRATEGY_SELECTION_AUTHORITY_BOUNDARIES.strategySelector).toMatch(
      /STRATEGY_SELECTOR/,
    );
    expect(STRATEGY_SELECTION_AUTHORITY_BOUNDARIES.portfolioAllocator).toMatch(
      /PORTFOLIO_ALLOCATOR/,
    );
    expect(SCENARIO_AUTHORITY_BOUNDARIES.strategySelector).toMatch(/STRATEGY_SELECTOR/);
    expect(SCENARIO_AUTHORITY_BOUNDARIES.recommendation).toMatch(/human/i);
    expect(SCENARIO_AUTHORITY_BOUNDARIES.simulation).toMatch(/never selects/i);
  });

  it("compileProposedPortfolioIntent produces a valid PortfolioIntent", async () => {
    const { service } = buildScenarioService();
    const admitted = await admitSampleDecisionProblem(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.ground(admitted.problem.decisionProblemId);
    const { scenarioSet } = await service.generateScenarios(
      admitted.problem.decisionProblemId,
    );
    const upside = scenarioSet.scenarios.find((s) => s.roleHint === "UPSIDE");
    expect(upside).toBeTruthy();
    const intent = compileProposedPortfolioIntent(
      upside!,
      admitted.problem,
    );
    expect(() => PortfolioIntentSchema.parse(intent)).not.toThrow();
    expect(intent.riskToleranceProfile).toBe("HIGH");
    expect(intent.allowedProjectScopes).toContain(EXAMPLE_PROJECT_ID);
  });

  it("ScenarioProgressionLoop is producer-only and never advances decision state", async () => {
    const {
      service,
      decisionProblems,
      progression,
      materializer,
    } = buildScenarioService();
    const admitted = await admitSampleDecisionProblem(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.problem.decisionProblemId;
    const before = (await decisionProblems.getById(id))!;

    await progression.tick();
    const afterTick = (await decisionProblems.getById(id))!;
    expect(afterTick.status).toBe(before.status);
    expect(afterTick.recordRevision).toBe(before.recordRevision);

    const discovered = await materializer.discoverForDecisionProblem(id);
    const groundWork = [...discovered.created, ...discovered.reused].filter(
      (w) => w.workKind === "GROUND_DECISION_PROBLEM",
    );
    expect(groundWork.length).toBeGreaterThan(0);

    await service.ground(id);
    await progression.tick();
    const afterGround = (await decisionProblems.getById(id))!;
    expect(afterGround.status).toBe("SCENARIOS_PROPOSED");
  });

  it("FakeScenarioGenerationModel creates a baseline scenario", async () => {
    const { service } = buildScenarioService();
    const admitted = await admitSampleDecisionProblem(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.ground(admitted.problem.decisionProblemId);
    const { scenarioSet } = await service.generateScenarios(
      admitted.problem.decisionProblemId,
    );
    const baseline = scenarioSet.scenarios.find(
      (s) => s.scenarioId === scenarioSet.baselineScenarioId,
    );
    expect(baseline).toBeTruthy();
    expect(baseline!.roleHint === "BASELINE" || baseline!.roleHint === "BASE_CASE").toBe(
      true,
    );
    expect(scenarioSet.scenarios.length).toBeGreaterThanOrEqual(3);
  });

  it("full ladder: selection admits portfolio proposal without capital authority", async () => {
    const { service, lineage, portfolioAdmissionPort } = buildScenarioService();
    const { id, pkg } = await ladderToAwaitingSelection(service);
    const routed = await service.routeSelection(id);
    const topScenario = pkg.recommendedScenarioIds[0]!;
    await service.decideSelection({
      selectionId: routed.request.selectionId,
      selectorId: "strategy_selector_full",
      decision: "SELECT_SCENARIO",
      selectedScenarioId: topScenario,
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T01:00:00.000Z",
    });

    const materialized = await service.materializePortfolioProposal(id);
    expect(materialized.problem.status).toBe("MATERIALIZED_AS_PROPOSAL");
    expect(materialized.lineage.portfolioAdmissionOutcome).toBe("ADMITTED");
    expect(materialized.lineage.portfolioId).toMatch(/^pf_fake_/);
    expect(materialized.lineage.compiledIntentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(portfolioAdmissionPort?.admitCallCount).toBe(1);

    const records = await lineage.listByDecisionProblem(id);
    expect(records).toHaveLength(1);
    assertSelectionDoesNotAllocateCapital();
  });

  it("fails closed when portfolio admission port is unavailable", async () => {
    const { service, decisionProblems, lineage } = buildScenarioService({
      omitPortfolioAdmissionPort: true,
    });
    const { id, pkg } = await ladderToAwaitingSelection(service);
    const routed = await service.routeSelection(id);
    await service.decideSelection({
      selectionId: routed.request.selectionId,
      selectorId: "strategy_selector_full",
      decision: "SELECT_SCENARIO",
      selectedScenarioId: pkg.recommendedScenarioIds[0]!,
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T01:00:00.000Z",
    });

    await expect(service.materializePortfolioProposal(id)).rejects.toMatchObject({
      code: "PORTFOLIO_ADMISSION_UNAVAILABLE",
    });
    const problem = await decisionProblems.getById(id);
    expect(problem?.status).toBe("SELECTED");
    expect(await lineage.listByDecisionProblem(id)).toHaveLength(0);
  });

  it("materialization crash after admit reuses deterministic portfolio on retry", async () => {
    const port = new FakePortfolioProposalAdmissionPort();
    port.crashAfterAdmit = true;
    const { service, lineage } = buildScenarioService({
      portfolioAdmissionPort: port,
    });
    const { id, pkg } = await ladderToAwaitingSelection(service);
    const routed = await service.routeSelection(id);
    await service.decideSelection({
      selectionId: routed.request.selectionId,
      selectorId: "strategy_selector_full",
      decision: "SELECT_SCENARIO",
      selectedScenarioId: pkg.recommendedScenarioIds[0]!,
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T01:00:00.000Z",
    });

    await expect(service.materializePortfolioProposal(id)).rejects.toThrow(
      /simulated crash after portfolio admission/,
    );
    expect(await lineage.listByDecisionProblem(id)).toHaveLength(0);

    port.crashAfterAdmit = false;
    const resumed = await service.materializePortfolioProposal(id);
    expect(resumed.problem.status).toBe("MATERIALIZED_AS_PROPOSAL");
    expect(resumed.lineage.portfolioAdmissionOutcome).toBe("DUPLICATE");
    expect(port.admitCallCount).toBe(2);
    expect(await lineage.listByDecisionProblem(id)).toHaveLength(1);
  });

  it("materialization crash after lineage reuses lineage without second admit", async () => {
    let crashOnce = true;
    const port = new FakePortfolioProposalAdmissionPort();
    const { service, lineage } = buildScenarioService({
      portfolioAdmissionPort: port,
      materializationFailpoint: {
        async afterLineagePersist() {
          if (crashOnce) {
            throw new Error("simulated crash after lineage persist");
          }
        },
      },
    });
    const { id, pkg } = await ladderToAwaitingSelection(service);
    const routed = await service.routeSelection(id);
    await service.decideSelection({
      selectionId: routed.request.selectionId,
      selectorId: "strategy_selector_full",
      decision: "SELECT_SCENARIO",
      selectedScenarioId: pkg.recommendedScenarioIds[0]!,
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T01:00:00.000Z",
    });

    await expect(service.materializePortfolioProposal(id)).rejects.toThrow(
      /simulated crash after lineage persist/,
    );
    expect(await lineage.listByDecisionProblem(id)).toHaveLength(1);
    expect(port.admitCallCount).toBe(1);

    crashOnce = false;
    const resumed = await service.materializePortfolioProposal(id);
    expect(resumed.problem.status).toBe("MATERIALIZED_AS_PROPOSAL");
    expect(port.admitCallCount).toBe(1);
    expect(await lineage.listByDecisionProblem(id)).toHaveLength(1);
  });

  it("simulation failpoint resume reuses persisted results", async () => {
    let crashOnce = true;
    const { service, simulationResults, decisionProblems } = buildScenarioService({
      simulationFailpoint: {
        async hit(newResultCount: number) {
          if (crashOnce && newResultCount >= 3) {
            throw new Error("simulated worker crash after 3 simulations");
          }
        },
      },
    });
    const admitted = await admitSampleDecisionProblem(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.problem.decisionProblemId;
    await service.ground(id);
    const { scenarioSet } = await service.generateScenarios(id);

    await expect(service.simulateAll(id, "crash-resume-seed")).rejects.toThrow(
      /simulated worker crash/,
    );
    const mid = (await decisionProblems.getById(id))!;
    expect(mid.status).toBe("SIMULATING");
    const saved = await simulationResults.listByScenarioSet(
      scenarioSet.scenarioSetId,
      scenarioSet.scenarioSetVersion,
    );
    expect(saved.length).toBe(3);

    crashOnce = false;
    const resumed = await service.simulateAll(id, "crash-resume-seed");
    expect(resumed.results.length).toBe(3);
    expect(resumed.problem.status).toBe("ANALYZING");
    const savedAfter = await simulationResults.listByScenarioSet(
      scenarioSet.scenarioSetId,
      scenarioSet.scenarioSetVersion,
    );
    expect(savedAfter.length).toBe(3);
  });

  it("STRATEGY_SELECTOR requires grants for every allowed project", async () => {
    const { service, selectionRecords, lineage } = buildScenarioService();

    const admitted = await service.admit({
      primaryProjectId: EXAMPLE_PROJECT_ID,
      question: "Multi-project strategy?",
      strategicObjective: "Cover A/B/C scope",
      decisionCriteria: sampleDecisionCriteria(),
      timeHorizon: "90 days",
      constraints: [],
      nonGoals: [],
      allowedProjectIds: [EXAMPLE_PROJECT_ID, PROJECT_B, PROJECT_C],
      allowedEnvironments: [EXAMPLE_ENVIRONMENT],
      riskTolerance: "MEDIUM",
      createdBy: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.problem.decisionProblemId;
    await service.ground(id);
    await service.generateScenarios(id);
    await service.simulateAll(id, "scope-seed");
    await service.analyze(id);
    const { pkg } = await service.validatePackage(id);
    const routed = await service.routeSelection(id);
    const selectedScenarioId = pkg.recommendedScenarioIds[0]!;

    const failClosed = async (selectorId: string) => {
      await expect(
        service.decideSelection({
          selectionId: routed.request.selectionId,
          selectorId,
          decision: "SELECT_SCENARIO",
          selectedScenarioId,
          decisionNonce: routed.decisionNonce,
          submittedAt: "2026-01-01T01:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "STRATEGY_SELECTOR_SCOPE_INSUFFICIENT" });
      expect(await selectionRecords.getLatest(id)).toBeNull();
      expect(await lineage.listByDecisionProblem(id)).toHaveLength(0);
    };

    // Partial STRATEGY_SELECTOR coverage fails closed.
    await failClosed("selector_ab");
    await failClosed("selector_a_only");
    // Other roles never imply STRATEGY_SELECTOR.
    await failClosed("approver_only");
    await failClosed("portfolio_allocator_only");
    await failClosed("program_materializer_only");

    const decided = await service.decideSelection({
      selectionId: routed.request.selectionId,
      selectorId: "strategy_selector_full",
      decision: "SELECT_SCENARIO",
      selectedScenarioId,
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T01:00:00.000Z",
    });
    expect(decided.problem.status).toBe("SELECTED");
    expect(decided.record?.selectorId).toBe("strategy_selector_full");
  });

  it("authoritative weights ignore model-suggested weights", () => {
    expect(MODEL_WEIGHT_AUTHORITY.modelSuggested).not.toBe(
      MODEL_WEIGHT_AUTHORITY.authoritative,
    );
    const authoritative: DecisionCriterion[] = [
      {
        criterionId: "c_a",
        name: "A",
        kind: "EXPECTED_VALUE",
        weight: 0.9,
        higherIsBetter: true,
      },
      {
        criterionId: "c_b",
        name: "B",
        kind: "GOAL_COVERAGE",
        weight: 0.1,
        higherIsBetter: true,
      },
    ];
    const modelSuggested: DecisionCriterion[] = [
      { ...authoritative[0]!, weight: 0.1 },
      { ...authoritative[1]!, weight: 0.9 },
    ];
    const results = [
      fakeSimResult({
        scenarioId: "scn_a",
        criterionScores: { c_a: 0.9, c_b: 0.1 },
      }),
      fakeSimResult({
        scenarioId: "scn_b",
        criterionScores: { c_a: 0.1, c_b: 0.9 },
      }),
    ];
    const authRank = compareScenarios({
      criteria: authoritative,
      baselineScenarioId: "scn_a",
      results,
    });
    const modelRank = compareScenarios({
      criteria: modelSuggested,
      baselineScenarioId: "scn_a",
      results,
    });
    expect(authRank.rankedScenarios[0]!.scenarioId).toBe("scn_a");
    expect(modelRank.rankedScenarios[0]!.scenarioId).toBe("scn_b");
    // Production path only passes DecisionProblem.decisionCriteria.
    expect(authRank.rankedScenarios[0]!.scenarioId).not.toBe(
      modelRank.rankedScenarios[0]!.scenarioId,
    );
  });

  it("changing authoritative weights changes DecisionPackage hash", () => {
    const criteriaA = sampleDecisionCriteria();
    const criteriaB = sampleDecisionCriteria([
      { weight: 0.1 },
      { weight: 0.1 },
      { weight: 0.8 },
    ]);
    const results = [
      fakeSimResult({
        scenarioId: "scn_base",
        criterionScores: {
          c_expected_value: 0.5,
          c_risk: 0.4,
          c_goal_coverage: 0.6,
        },
      }),
    ];
    const baseFields = {
      decisionPackageId: "sdpkg_w",
      decisionPackageVersion: 1,
      decisionProblemId: "sdp_w",
      decisionProblemVersion: 1,
      scenarioSetId: "scs_w",
      scenarioSetVersion: 1,
      scenarioSetHash: "set_hash",
      simulationResults: results,
      sensitivity: {
        findings: [],
        evaluationsPerformed: 0,
        evaluationBudget: 64,
        truncated: false,
      },
      limitations: [],
      requiredHumanDecisions: ["STRATEGY_SELECTOR"] as const,
      policyBundleFingerprint: "p",
      capabilitySetFingerprint: "c",
      projectConfigurationFingerprint: "j",
      truthSnapshotFingerprint: "truth_fp",
      assumptionSetHash: "asm_hash",
      generationModelId: "fake",
      generationModelVersion: "1",
      simulationEngineVersion: SIMULATION_ENGINE_VERSION,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const pkgA = withDecisionPackageHash({
      ...baseFields,
      authoritativeDecisionCriteria: criteriaA,
      comparison: compareScenarios({
        criteria: criteriaA,
        baselineScenarioId: "scn_base",
        results,
      }),
      recommendedScenarioIds: ["scn_base"],
    });
    const pkgB = withDecisionPackageHash({
      ...baseFields,
      authoritativeDecisionCriteria: criteriaB,
      comparison: compareScenarios({
        criteria: criteriaB,
        baselineScenarioId: "scn_base",
        results,
      }),
      recommendedScenarioIds: ["scn_base"],
    });
    expect(pkgA.decisionPackageHash).not.toBe(pkgB.decisionPackageHash);
    expect(pkgA.authoritativeDecisionCriteria).toEqual(criteriaA);
    expect(pkgA.truthSnapshotFingerprint).toBe("truth_fp");
    expect(pkgA.assumptionSetHash).toBe("asm_hash");
  });

  it("rejects strategy selection from principals lacking STRATEGY_SELECTOR", async () => {
    const { service, selectionRecords, lineage } = buildScenarioService();
    const { id, pkg } = await ladderToAwaitingSelection(service);
    const routed = await service.routeSelection(id);
    const selectedScenarioId = pkg.recommendedScenarioIds[0]!;

    for (const selectorId of [
      "approver_only",
      "portfolio_allocator_only",
      "program_materializer_only",
    ]) {
      await expect(
        service.decideSelection({
          selectionId: routed.request.selectionId,
          selectorId,
          decision: "SELECT_SCENARIO",
          selectedScenarioId,
          decisionNonce: routed.decisionNonce,
          submittedAt: "2026-01-01T01:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "STRATEGY_SELECTOR_SCOPE_INSUFFICIENT" });
    }
    expect(await selectionRecords.getLatest(id)).toBeNull();
    expect(await lineage.listByDecisionProblem(id)).toHaveLength(0);
  });

  it("truth snapshot fingerprint is stable across recompute without material drift", async () => {
    const { service, decisionProblems } = buildScenarioService();
    const admitted = await admitSampleDecisionProblem(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.problem.decisionProblemId;
    await service.ground(id);
    const grounded = (await decisionProblems.getById(id))!;
    const fp1 = grounded.truthSnapshotFingerprint!;

    await service.generateScenarios(id);
    await service.simulateAll(id, "truth-stable-seed");
    await service.analyze(id);
    const { pkg } = await service.validatePackage(id);
    expect(pkg.truthSnapshotFingerprint).toBe(fp1);

    // Progression / recordRevision must not invalidate external truth.
    const after = (await decisionProblems.getById(id))!;
    expect(after.truthSnapshotFingerprint).toBe(fp1);
    expect(after.recordRevision).toBeGreaterThan(grounded.recordRevision);

    const routed = await service.routeSelection(id);
    expect(routed.request.status).toBe("PENDING");
    expect(routed.request.truthSnapshotFingerprint).toBe(fp1);
  });

  it("surfaces ScenarioError with stable codes", () => {
    try {
      assertCompatibleUnits("USD", "TOKENS", "sum");
    } catch (error) {
      expect(isScenarioError(error)).toBe(true);
      if (isScenarioError(error)) {
        expect(error.code).toBe("UNIT_MIXING_REJECTED");
      }
    }
  });
});
