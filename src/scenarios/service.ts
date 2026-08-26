import { createHash } from "node:crypto";
import type { ControlPlaneService } from "../control-plane/service.js";
import {
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "../authorization/decision-nonce.js";
import { hashDecisionNonce } from "../authorization/decision-card-hasher.js";
import { capabilitySetFingerprint } from "../execution/capability-fingerprint.js";
import {
  projectConfigurationFingerprint,
} from "../programs/authority.js";
import {
  withOptionalTransaction,
  type TransactionManager,
} from "../durability/transaction.js";
import type { PortfolioOrchestrationService } from "../portfolio/service.js";
import {
  Phase15PortfolioProposalAdmissionPort,
  type PortfolioProposalAdmissionPort,
} from "./portfolio-admission-port.js";
import {
  assumptionSetHash,
  type ScenarioAssumption,
} from "./assumptions.js";
import { compareScenarios } from "./comparison.js";
import {
  INITIAL_DECISION_PROBLEM_VERSION,
  assertDecisionTransition,
  decisionProblemContentFingerprint,
  decisionProblemIdempotencyKey,
  mintDecisionProblemId,
  parseDecisionProblem,
  type DecisionCriterion,
  type DecisionProblem,
} from "./decision-problem.js";
import {
  INITIAL_DECISION_PACKAGE_VERSION,
  assertModelWeightsNotUsedAsAuthority,
  mintDecisionPackageId,
  withDecisionPackageHash,
  type StrategicDecisionPackage,
} from "./decision-package.js";
import { ScenarioError } from "./errors.js";
import type { ScenarioGenerationModel } from "./generation-model.js";
import {
  assertSelectionDoesNotAllocateCapital,
  scenarioPortfolioLineageIdFor,
  type ScenarioPortfolioLineage,
} from "./lineage.js";
import {
  compiledPortfolioIntentHash,
  compileProposedPortfolioIntent,
} from "./portfolio-intent-compiler.js";
import type {
  DecisionPackageRepository,
  DecisionProblemRepository,
  ScenarioPortfolioLineageRepository,
  ScenarioSetRepository,
  SimulationResultRepository,
  SimulationUsageLedgerRepository,
  StrategySelectionRecordRepository,
  StrategySelectionRequestRepository,
} from "./repositories.js";
import { runSensitivity } from "./sensitivity.js";
import {
  computeSelectionSubjectHash,
  mintSelectionId,
  mintSelectionRecordId,
  assertStrategySelectionDoesNotAllocate,
  assertStrategySelectorDistinctFromApprover,
  assertStrategySelectorDistinctFromPortfolioAllocator,
  assertStrategySelectorDistinctFromProgramMaterializer,
  type StrategySelectionRecord,
  type StrategySelectionRequest,
} from "./selection.js";
import {
  INITIAL_SCENARIO_SET_VERSION,
  mintScenarioSetId,
  withScenarioSetHash,
  type ScenarioDefinition,
  type ScenarioSet,
} from "./scenario.js";
import type { ScenarioSimulationEngine } from "./simulation-engine.js";
import {
  simulationConfigurationFingerprint,
  simulationInputFingerprint,
  SIMULATION_ENGINE_VERSION,
  type ScenarioSimulationResult,
} from "./simulation-result.js";
import { validateDecisionPackage } from "./validator.js";

export interface DecisionProblemAdmissionRequest {
  decisionProblemId?: string;
  decisionProblemVersion?: number;
  primaryProjectId: string;
  question: string;
  strategicObjective: string;
  decisionCriteria: DecisionCriterion[];
  timeHorizon: string;
  constraints?: string[];
  nonGoals?: string[];
  allowedProjectIds: string[];
  allowedEnvironments: string[];
  allowedRepositoryIdentities?: string[];
  riskTolerance: DecisionProblem["riskTolerance"];
  decisionDeadline?: string;
  createdBy: string;
  requestedEnvironment: string;
  correlationId?: string;
  traceId?: string;
  submittedAt: string;
  maximumScenarioCount?: number;
  maximumSimulationRuns?: number;
  maximumModelCalls?: number;
  maximumSensitivityEvaluations?: number;
}

export type DecisionProblemAdmissionOutcome =
  | { outcome: "ADMITTED"; problem: DecisionProblem }
  | { outcome: "DUPLICATE"; problem: DecisionProblem }
  | {
      outcome: "VERSION_CONFLICT";
      existing: DecisionProblem;
      message: string;
    };

export interface ScenarioSimulationFailpoint {
  hit(newResultCount: number): Promise<void>;
}

export interface ScenarioOrchestrationServiceDeps {
  nowIso: () => string;
  decisionProblems: DecisionProblemRepository;
  scenarioSets: ScenarioSetRepository;
  simulationResults: SimulationResultRepository;
  decisionPackages: DecisionPackageRepository;
  selectionRequests: StrategySelectionRequestRepository;
  selectionRecords: StrategySelectionRecordRepository;
  lineage: ScenarioPortfolioLineageRepository;
  usageLedger: SimulationUsageLedgerRepository;
  controlPlane: ControlPlaneService;
  generationModel: ScenarioGenerationModel;
  simulationEngine: ScenarioSimulationEngine;
  nonceGenerator: DecisionNonceGenerator;
  selectionNonceStore?: {
    put(selectionId: string, plaintext: string): Promise<void>;
    take(selectionId: string): Promise<string | null>;
  };
  /** Must hold STRATEGY_SELECTOR for EVERY project in allowedProjectIds. */
  isStrategySelector?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  /**
   * Required for MATERIALIZED_AS_PROPOSAL. Prefer portfolioAdmissionPort;
   * portfolioService is adapted automatically when port is omitted.
   */
  portfolioAdmissionPort?: PortfolioProposalAdmissionPort;
  /** @deprecated Prefer portfolioAdmissionPort — still accepted as adapter source. */
  portfolioService?: PortfolioOrchestrationService;
  transactions?: TransactionManager;
  simulationFailpoint?: ScenarioSimulationFailpoint;
  /** Test-only: crash after lineage persist, before state transition. */
  materializationFailpoint?: {
    afterLineagePersist?(): Promise<void>;
  };
}

export const SCENARIO_AUTHORITY_BOUNDARIES = {
  strategySelector:
    "STRATEGY_SELECTOR chooses scenario — not portfolio authorization",
  simulation:
    "Simulation produces estimates — never selects strategy or allocates capital",
  recommendation:
    "Ranked scenarios are recommendations — not human selection",
} as const;

export function assertScenarioAuthoritySeparation(): void {
  assertStrategySelectionDoesNotAllocate();
  assertStrategySelectorDistinctFromApprover();
  assertStrategySelectorDistinctFromPortfolioAllocator();
  assertStrategySelectorDistinctFromProgramMaterializer();
  assertSelectionDoesNotAllocateCapital();
}

export class ScenarioOrchestrationService {
  constructor(private readonly deps: ScenarioOrchestrationServiceDeps) {}

  assertAuthoritySeparation(): void {
    assertScenarioAuthoritySeparation();
  }

  async admit(
    request: DecisionProblemAdmissionRequest,
  ): Promise<DecisionProblemAdmissionOutcome> {
    const context = await this.deps.controlPlane.resolve(
      request.primaryProjectId,
      request.requestedEnvironment,
    );
    const contentFingerprint = decisionProblemContentFingerprint({
      question: request.question,
      strategicObjective: request.strategicObjective,
      decisionCriteria: request.decisionCriteria,
      primaryProjectId: request.primaryProjectId,
      allowedProjectIds: request.allowedProjectIds,
    });
    const idempotencyKey = decisionProblemIdempotencyKey({
      primaryProjectId: request.primaryProjectId,
      contentFingerprint,
      createdBy: request.createdBy,
    });

    const existing =
      await this.deps.decisionProblems.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      if (existing.contentFingerprint !== contentFingerprint) {
        return {
          outcome: "VERSION_CONFLICT",
          existing,
          message: "Same decision identity with different semantic content",
        };
      }
      return { outcome: "DUPLICATE", problem: existing };
    }

    const now = request.submittedAt;
    const caps = context.availableCapabilities.map((c) => ({
      capabilityId: c.capabilityId,
      version: c.version,
      enabled: c.enabled,
      allowedActions: c.allowedActions,
      forbiddenActions: c.forbiddenActions,
      allowedEnvironments: c.allowedEnvironments,
      approvalRequirement: c.approvalRequirement,
      maximumRuntimeSeconds: c.maximumRuntimeSeconds,
    }));

    const decisionProblemId =
      request.decisionProblemId ??
      mintDecisionProblemId({
        primaryProjectId: request.primaryProjectId,
        contentFingerprint,
        admittedAt: now,
      });

    const problem = parseDecisionProblem({
      decisionProblemId,
      decisionProblemVersion:
        request.decisionProblemVersion ?? INITIAL_DECISION_PROBLEM_VERSION,
      primaryProjectId: request.primaryProjectId,
      question: request.question,
      strategicObjective: request.strategicObjective,
      decisionCriteria: request.decisionCriteria,
      timeHorizon: request.timeHorizon,
      constraints: request.constraints ?? [],
      nonGoals: request.nonGoals ?? [],
      allowedProjectIds: request.allowedProjectIds,
      allowedEnvironments: request.allowedEnvironments,
      allowedRepositoryIdentities: request.allowedRepositoryIdentities ?? [],
      riskTolerance: request.riskTolerance,
      decisionDeadline: request.decisionDeadline,
      createdBy: request.createdBy,
      status: "ADMITTED",
      policyBundleFingerprint: context.activePolicyBundle.policyHash,
      capabilitySetFingerprint: capabilitySetFingerprint(caps),
      projectConfigurationFingerprint: projectConfigurationFingerprint({
        projectId: request.primaryProjectId,
        activePolicyBundleId: context.project.activePolicyBundleId,
        budgetProfileId: context.project.resourceBudgetProfileId,
        allowedEnvironments: context.project.allowedEnvironments,
        executionMode: context.project.executionMode,
      }),
      maximumScenarioCount: request.maximumScenarioCount ?? 12,
      maximumSimulationRuns: request.maximumSimulationRuns ?? 50,
      maximumModelCalls: request.maximumModelCalls ?? 32,
      maximumSensitivityEvaluations:
        request.maximumSensitivityEvaluations ?? 64,
      createdAt: now,
      updatedAt: now,
      recordRevision: 1,
      correlationId: request.correlationId ?? `corr_${decisionProblemId}`,
      traceId: request.traceId ?? `trace_${decisionProblemId}`,
      idempotencyKey,
      contentFingerprint,
    });

    const created = await this.deps.decisionProblems.create(problem);
    await this.deps.usageLedger.create({
      decisionProblemId: created.decisionProblemId,
      scenarioCount: 0,
      simRuns: 0,
      modelCalls: 0,
      sensitivityEvals: 0,
      recordRevision: 1,
      updatedAt: now,
    });
    return { outcome: "ADMITTED", problem: created };
  }

  async ground(decisionProblemId: string): Promise<DecisionProblem> {
    let problem = await this.requireProblem(decisionProblemId);
    if (problem.status === "ADMITTED") {
      problem = await this.transition(problem, "GROUNDING");
    } else if (problem.status === "STALE") {
      problem = await this.transition(problem, "GROUNDING");
    } else if (problem.status !== "GROUNDING") {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Cannot ground from ${problem.status}`,
      );
    }

    const env = problem.allowedEnvironments[0]!;
    const snapshot = await this.buildTruthSnapshot(
      problem.primaryProjectId,
      env,
    );

    const grounded = await this.deps.decisionProblems.save(
      {
        ...problem,
        truthSnapshotFingerprint: snapshot.truthSnapshotFingerprint,
        policyBundleFingerprint: snapshot.policyBundleFingerprint,
        capabilitySetFingerprint: snapshot.capabilitySetFingerprint,
        projectConfigurationFingerprint: snapshot.projectConfigurationFingerprint,
        updatedAt: this.deps.nowIso(),
      },
      problem.recordRevision,
    );

    return this.transition(grounded, "SCENARIOS_PROPOSED");
  }

  async generateScenarios(decisionProblemId: string): Promise<{
    problem: DecisionProblem;
    scenarioSet: ScenarioSet;
    assumptions: ScenarioAssumption[];
  }> {
    let problem = await this.requireProblem(decisionProblemId);
    if (problem.status === "SCENARIOS_PROPOSED") {
      // idempotent re-entry allowed
    } else if (problem.status === "GROUNDING") {
      problem = await this.transition(problem, "SCENARIOS_PROPOSED");
    } else {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Cannot generate scenarios from ${problem.status}`,
      );
    }

    if (!problem.truthSnapshotFingerprint) {
      throw new ScenarioError(
        "DECISION_PACKAGE_INVALID",
        "Decision problem must be grounded before scenario generation",
      );
    }

    const scenarioSetVersion =
      (problem.scenarioSetVersion ?? INITIAL_SCENARIO_SET_VERSION - 1) + 1;
    const scenarioSetId = mintScenarioSetId({
      decisionProblemId: problem.decisionProblemId,
      scenarioSetVersion,
    });

    const proposal = await this.deps.generationModel.generate({
      decisionProblem: problem,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint,
      scenarioSetId,
      scenarioSetVersion,
    });

    const assumptions = proposal.assumptions as ScenarioAssumption[];
    const asmHash = assumptionSetHash(assumptions);
    const now = this.deps.nowIso();

    const scenarioSet = withScenarioSetHash({
      scenarioSetId,
      scenarioSetVersion,
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      scenarios: proposal.scenarios as ScenarioDefinition[],
      baselineScenarioId: (proposal.scenarios as ScenarioDefinition[]).find(
        (s) => s.roleHint === "BASELINE" || s.roleHint === "BASE_CASE",
      )!.scenarioId,
      assumptionSetHash: asmHash,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint,
      createdAt: now,
    });

    await this.deps.scenarioSets.save(scenarioSet);
    await this.incrementUsage(problem.decisionProblemId, {
      scenarioCount: scenarioSet.scenarios.length,
      modelCalls: 1,
    });

    const updated = await this.deps.decisionProblems.transition(
      problem.decisionProblemId,
      problem.status,
      problem.recordRevision,
      "SIMULATING",
      now,
      {
        scenarioSetVersion: scenarioSet.scenarioSetVersion,
        scenarioSetHash: scenarioSet.scenarioSetHash,
      },
    );

    return { problem: updated, scenarioSet, assumptions };
  }

  async simulateAll(
    decisionProblemId: string,
    randomSeed = "scenario-default-seed",
  ): Promise<{
    problem: DecisionProblem;
    results: ScenarioSimulationResult[];
  }> {
    const problem = await this.requireProblem(decisionProblemId);
    if (problem.status !== "SIMULATING" && problem.status !== "ANALYZING") {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Cannot simulate from ${problem.status}`,
      );
    }

    const scenarioSet = await this.requireLatestScenarioSet(problem);
    const results: ScenarioSimulationResult[] = [];
    let newCount = 0;

    for (const scenario of scenarioSet.scenarios) {
      const { result, created } = await this.simulateScenarioInternal(
        problem,
        scenarioSet,
        scenario,
        randomSeed,
      );
      results.push(result);
      if (created) {
        newCount += 1;
        // Crash-class failpoints escape after durable persist of this result.
        if (this.deps.simulationFailpoint) {
          await this.deps.simulationFailpoint.hit(newCount);
        }
      }
    }

    const now = this.deps.nowIso();
    const updated =
      problem.status === "SIMULATING"
        ? await this.transition(problem, "ANALYZING")
        : await this.deps.decisionProblems.save(
            { ...problem, updatedAt: now },
            problem.recordRevision,
          );

    return { problem: updated, results };
  }

  async simulateScenario(
    decisionProblemId: string,
    scenarioId: string,
    randomSeed = "scenario-default-seed",
  ): Promise<ScenarioSimulationResult> {
    const problem = await this.requireProblem(decisionProblemId);
    const scenarioSet = await this.requireLatestScenarioSet(problem);
    const scenario = scenarioSet.scenarios.find((s) => s.scenarioId === scenarioId);
    if (!scenario) {
      throw new ScenarioError(
        "SCENARIO_INVALID",
        `Scenario ${scenarioId} not found`,
      );
    }
    const { result, created } = await this.simulateScenarioInternal(
      problem,
      scenarioSet,
      scenario,
      randomSeed,
    );
    if (created && this.deps.simulationFailpoint) {
      await this.deps.simulationFailpoint.hit(1);
    }
    return result;
  }

  async analyze(decisionProblemId: string): Promise<{
    problem: DecisionProblem;
    comparison: ReturnType<typeof compareScenarios>;
    sensitivity: Awaited<ReturnType<typeof runSensitivity>>;
  }> {
    let problem = await this.requireProblem(decisionProblemId);
    if (problem.status === "SIMULATING") {
      await this.simulateAll(decisionProblemId);
      problem = await this.requireProblem(decisionProblemId);
    }
    if (problem.status === "ANALYZING") {
      // continue
    } else if (problem.status === "VALIDATING") {
      problem = await this.transition(problem, "ANALYZING");
    } else {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Cannot analyze from ${problem.status}`,
      );
    }

    const scenarioSet = await this.requireLatestScenarioSet(problem);
    const results = await this.deps.simulationResults.listByScenarioSet(
      scenarioSet.scenarioSetId,
      scenarioSet.scenarioSetVersion,
    );
    if (results.length === 0) {
      throw new ScenarioError(
        "DECISION_PACKAGE_INVALID",
        "No simulation results available for analysis",
      );
    }

    const comparison = compareScenarios({
      criteria: problem.decisionCriteria,
      baselineScenarioId: scenarioSet.baselineScenarioId,
      results,
    });

    const generation = await this.deps.generationModel.generate({
      decisionProblem: problem,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint!,
      scenarioSetId: scenarioSet.scenarioSetId,
      scenarioSetVersion: scenarioSet.scenarioSetVersion,
    });

    const sensitivity = await runSensitivity({
      decisionProblem: problem,
      assumptions: generation.assumptions as ScenarioAssumption[],
      results,
      comparison,
      evaluatePerturbation: async ({ assumptionId, perturbedValue, scenarioId }) => {
        const base = results.find((r) => r.scenarioId === scenarioId);
        const baseScore =
          comparison.rankedScenarios.find((r) => r.scenarioId === scenarioId)
            ?.weightedScore ?? 0;
        const perturbationFactor =
          perturbedValue /
          ((generation.assumptions as ScenarioAssumption[]).find(
            (a) => a.assumptionId === assumptionId,
          )?.value ?? 1);
        await this.incrementUsage(problem.decisionProblemId, {
          sensitivityEvals: 1,
        });
        return baseScore * perturbationFactor * (base ? 1 : 0.5);
      },
    });

    await this.incrementUsage(problem.decisionProblemId, {
      sensitivityEvals: sensitivity.evaluationsPerformed,
    });

    const validating = await this.transition(problem, "VALIDATING");
    return { problem: validating, comparison, sensitivity };
  }

  async validatePackage(decisionProblemId: string): Promise<{
    problem: DecisionProblem;
    pkg: StrategicDecisionPackage;
    validation: ReturnType<typeof validateDecisionPackage>;
  }> {
    let problem = await this.requireProblem(decisionProblemId);
    if (problem.status === "ANALYZING") {
      await this.analyze(decisionProblemId);
      problem = await this.requireProblem(decisionProblemId);
    }
    if (problem.status !== "VALIDATING") {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Cannot validate from ${problem.status}`,
      );
    }

    const scenarioSet = await this.requireLatestScenarioSet(problem);
    const results = await this.deps.simulationResults.listByScenarioSet(
      scenarioSet.scenarioSetId,
      scenarioSet.scenarioSetVersion,
    );
    const comparison = compareScenarios({
      criteria: problem.decisionCriteria,
      baselineScenarioId: scenarioSet.baselineScenarioId,
      results,
    });

    const generation = await this.deps.generationModel.generate({
      decisionProblem: problem,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint!,
      scenarioSetId: scenarioSet.scenarioSetId,
      scenarioSetVersion: scenarioSet.scenarioSetVersion,
    });
    // Explicitly discard untrusted model weight suggestions.
    void generation.untrustedSuggestedCriteriaWeights;
    assertModelWeightsNotUsedAsAuthority();

    const sensitivity = await runSensitivity({
      decisionProblem: problem,
      assumptions: generation.assumptions as ScenarioAssumption[],
      results,
      comparison,
      evaluatePerturbation: async ({ perturbedValue, scenarioId, assumptionId }) => {
        const base =
          comparison.rankedScenarios.find((r) => r.scenarioId === scenarioId)
            ?.weightedScore ?? 0;
        const asm = (generation.assumptions as ScenarioAssumption[]).find(
          (a) => a.assumptionId === assumptionId,
        );
        return base * (perturbedValue / (asm?.value ?? 1));
      },
    });

    const decisionPackageVersion = INITIAL_DECISION_PACKAGE_VERSION;
    const now = this.deps.nowIso();
    const recommendedScenarioIds = comparison.rankedScenarios
      .slice(0, 3)
      .map((r) => r.scenarioId);

    const pkg = withDecisionPackageHash({
      decisionPackageId: mintDecisionPackageId({
        decisionProblemId: problem.decisionProblemId,
        decisionPackageVersion,
      }),
      decisionPackageVersion,
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      scenarioSetId: scenarioSet.scenarioSetId,
      scenarioSetVersion: scenarioSet.scenarioSetVersion,
      scenarioSetHash: scenarioSet.scenarioSetHash,
      authoritativeDecisionCriteria: [...problem.decisionCriteria],
      simulationResults: [...results],
      comparison,
      sensitivity,
      recommendedScenarioIds,
      limitations: [
        "All simulation values are estimates — not verified outcomes",
        "Recommended scenarios require human STRATEGY_SELECTOR decision",
        "MODEL_SUGGESTED_WEIGHT ≠ AUTHORITATIVE_DECISION_WEIGHT",
        ...generation.riskFactors,
      ],
      requiredHumanDecisions: ["STRATEGY_SELECTOR"],
      policyBundleFingerprint: problem.policyBundleFingerprint,
      capabilitySetFingerprint: problem.capabilitySetFingerprint,
      projectConfigurationFingerprint: problem.projectConfigurationFingerprint,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint!,
      assumptionSetHash: scenarioSet.assumptionSetHash,
      generationModelId: this.deps.generationModel.modelId,
      generationModelVersion: this.deps.generationModel.modelVersion,
      simulationEngineVersion: SIMULATION_ENGINE_VERSION,
      createdAt: now,
    });

    const validation = validateDecisionPackage({
      problem,
      scenarioSet,
      pkg,
      simulationResults: results,
    });

    if (validation.outcome === "BLOCK") {
      await this.deps.decisionProblems.transition(
        problem.decisionProblemId,
        problem.status,
        problem.recordRevision,
        "ANALYZING",
        now,
        { failureReasonCode: "DECISION_PACKAGE_INVALID" },
      );
      throw new ScenarioError(
        "DECISION_PACKAGE_INVALID",
        validation.findings.map((f) => f.message).join("; "),
        { findings: validation.findings },
      );
    }

    await this.deps.decisionPackages.save(pkg);
    const awaiting = await this.deps.decisionProblems.transition(
      problem.decisionProblemId,
      problem.status,
      problem.recordRevision,
      "AWAITING_SELECTION",
      now,
      { decisionPackageHash: pkg.decisionPackageHash },
    );

    return { problem: awaiting, pkg, validation };
  }

  async routeSelection(decisionProblemId: string): Promise<{
    request: StrategySelectionRequest;
    decisionNonce: string;
  }> {
    const problem = await this.requireProblem(decisionProblemId);
    if (problem.status !== "AWAITING_SELECTION") {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        "Selection routing requires AWAITING_SELECTION",
      );
    }
    await this.recheckTruthOrMarkStale(problem);

    const pkg = await this.requireLatestPackage(problem);
    const existing = await this.deps.selectionRequests.getPending(
      decisionProblemId,
    );
    if (existing) {
      const stored = await this.deps.selectionNonceStore?.take(
        existing.selectionId,
      );
      if (stored) {
        await this.deps.selectionNonceStore?.put(existing.selectionId, stored);
        return { request: existing, decisionNonce: stored };
      }
    }

    const now = this.deps.nowIso();
    const expiresAt = new Date(
      Date.parse(now) + 24 * 60 * 60 * 1000,
    ).toISOString();
    const subjectHash = computeSelectionSubjectHash({
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      decisionPackageHash: pkg.decisionPackageHash,
      scenarioSetHash: pkg.scenarioSetHash,
      truthSnapshotFingerprint: pkg.truthSnapshotFingerprint,
      policyBundleFingerprint: pkg.policyBundleFingerprint,
      capabilitySetFingerprint: pkg.capabilitySetFingerprint,
      projectConfigurationFingerprint: pkg.projectConfigurationFingerprint,
      expiresAt,
    });
    const issued = issueDecisionNonce(this.deps.nonceGenerator);
    const selectionId = mintSelectionId({
      decisionProblemId: problem.decisionProblemId,
      decisionPackageHash: pkg.decisionPackageHash,
    });
    const request: StrategySelectionRequest = {
      selectionId,
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      decisionPackageHash: pkg.decisionPackageHash,
      scenarioSetHash: pkg.scenarioSetHash,
      truthSnapshotFingerprint: pkg.truthSnapshotFingerprint,
      policyBundleFingerprint: pkg.policyBundleFingerprint,
      capabilitySetFingerprint: pkg.capabilitySetFingerprint,
      projectConfigurationFingerprint: pkg.projectConfigurationFingerprint,
      subjectHash,
      decisionNonceHash: issued.nonceHash,
      status: "PENDING",
      expiresAt,
      createdAt: now,
      recordRevision: 1,
    };
    const saved = await this.deps.selectionRequests.save(request);
    await this.deps.selectionNonceStore?.put(saved.selectionId, issued.plaintext);
    return { request: saved, decisionNonce: issued.plaintext };
  }

  async decideSelection(input: {
    selectionId: string;
    selectorId: string;
    decision: "SELECT_SCENARIO" | "REJECT_ALL" | "REQUEST_REVISION";
    selectedScenarioId?: string;
    decisionNonce: string;
    submittedAt: string;
  }): Promise<{
    request: StrategySelectionRequest;
    record?: StrategySelectionRecord;
    problem: DecisionProblem;
  }> {
    const request = await this.deps.selectionRequests.getById(input.selectionId);
    if (!request || request.status !== "PENDING") {
      throw new ScenarioError(
        "STRATEGY_SELECTION_INVALID",
        "No pending strategy selection request",
      );
    }
    if (Date.parse(input.submittedAt) > Date.parse(request.expiresAt)) {
      await this.deps.selectionRequests.saveCas(
        { ...request, status: "EXPIRED" },
        request.recordRevision,
      );
      throw new ScenarioError(
        "STRATEGY_SELECTION_EXPIRED",
        "Strategy selection request expired",
      );
    }
    if (hashDecisionNonce(input.decisionNonce) !== request.decisionNonceHash) {
      throw new ScenarioError(
        "STRATEGY_SELECTION_INVALID",
        "Decision nonce mismatch",
      );
    }

    const problem = await this.requireProblem(request.decisionProblemId);
    if (!this.deps.isStrategySelector) {
      throw new ScenarioError(
        "STRATEGY_SELECTION_INVALID",
        "STRATEGY_SELECTOR authority check not configured",
      );
    }
    const allowed = await this.deps.isStrategySelector(
      input.selectorId,
      problem.allowedProjectIds,
    );
    if (!allowed) {
      throw new ScenarioError(
        "STRATEGY_SELECTOR_SCOPE_INSUFFICIENT",
        "Principal lacks explicit STRATEGY_SELECTOR for all allowedProjectIds",
        {
          selectorId: input.selectorId,
          requiredProjects: [...problem.allowedProjectIds],
        },
      );
    }

    await this.recheckTruthOrMarkStale(problem);

    if (
      input.decision === "SELECT_SCENARIO" &&
      !input.selectedScenarioId
    ) {
      throw new ScenarioError(
        "STRATEGY_SELECTION_INVALID",
        "SELECT_SCENARIO requires selectedScenarioId",
      );
    }

    const decided = await this.deps.selectionRequests.saveCas(
      {
        ...request,
        status: "DECIDED",
        selectorId: input.selectorId,
        decision: input.decision,
        selectedScenarioId: input.selectedScenarioId,
        decidedAt: input.submittedAt,
      },
      request.recordRevision,
    );

    if (input.decision === "REQUEST_REVISION") {
      const revised = await this.transition(problem, "ANALYZING");
      return { request: decided, problem: revised };
    }
    if (input.decision === "REJECT_ALL") {
      const cancelled = await this.transition(problem, "CANCELLED");
      return { request: decided, problem: cancelled };
    }

    const record: StrategySelectionRecord = {
      selectionRecordId: mintSelectionRecordId({
        selectionId: request.selectionId,
        decidedAt: input.submittedAt,
      }),
      selectionId: request.selectionId,
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      decisionPackageHash: request.decisionPackageHash,
      scenarioSetHash: request.scenarioSetHash,
      selectorId: input.selectorId,
      decision: input.decision,
      selectedScenarioId: input.selectedScenarioId,
      subjectHash: request.subjectHash,
      decisionNonceHash: request.decisionNonceHash,
      decidedAt: input.submittedAt,
      expiresAt: request.expiresAt,
      createdAt: input.submittedAt,
    };
    await this.deps.selectionRecords.save(record);
    const selected = await this.transition(problem, "SELECTED");
    return { request: decided, record, problem: selected };
  }

  async materializePortfolioProposal(
    decisionProblemId: string,
  ): Promise<{
    problem: DecisionProblem;
    lineage: ScenarioPortfolioLineage;
  }> {
    const problem = await this.requireProblem(decisionProblemId);

    if (problem.status === "MATERIALIZED_AS_PROPOSAL") {
      const existing = await this.deps.lineage.listByDecisionProblem(
        decisionProblemId,
      );
      const lineage = existing[0];
      if (!lineage?.portfolioId) {
        throw new ScenarioError(
          "PORTFOLIO_PROPOSAL_FAILED",
          "MATERIALIZED_AS_PROPOSAL without durable portfolio lineage",
        );
      }
      return { problem, lineage };
    }

    if (problem.status !== "SELECTED") {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        "Portfolio proposal materialization requires SELECTED",
      );
    }
    await this.recheckTruthOrMarkStale(problem);

    const selection = await this.deps.selectionRecords.getLatest(
      decisionProblemId,
    );
    if (!selection || selection.decision !== "SELECT_SCENARIO") {
      throw new ScenarioError(
        "STRATEGY_SELECTION_REQUIRED",
        "No SELECT_SCENARIO record found",
      );
    }

    const scenarioSet = await this.requireLatestScenarioSet(problem);
    const selectedScenario = scenarioSet.scenarios.find(
      (s) => s.scenarioId === selection.selectedScenarioId,
    );
    if (!selectedScenario) {
      throw new ScenarioError(
        "SCENARIO_INVALID",
        "Selected scenario not found in set",
      );
    }

    const intent = compileProposedPortfolioIntent(selectedScenario, problem);
    const intentHash = compiledPortfolioIntentHash(selectedScenario, problem);
    const now = this.deps.nowIso();
    const lineageId = scenarioPortfolioLineageIdFor({
      decisionProblemId: problem.decisionProblemId,
      selectedScenarioId: selectedScenario.scenarioId,
      decisionPackageHash: selection.decisionPackageHash,
    });

    assertSelectionDoesNotAllocateCapital();
    assertStrategySelectionDoesNotAllocate();

    // Retry-safe: reuse durable lineage if Phase 15 admit already recorded.
    const priorLineage = await this.deps.lineage.getById(lineageId);
    if (
      priorLineage?.portfolioId &&
      (priorLineage.portfolioAdmissionOutcome === "ADMITTED" ||
        priorLineage.portfolioAdmissionOutcome === "DUPLICATE")
    ) {
      const materialized = await this.transition(
        problem,
        "MATERIALIZED_AS_PROPOSAL",
      );
      return { problem: materialized, lineage: priorLineage };
    }

    const admissionPort = this.resolvePortfolioAdmissionPort();
    if (!admissionPort) {
      throw new ScenarioError(
        "PORTFOLIO_ADMISSION_UNAVAILABLE",
        "Phase 15 PortfolioProposalAdmissionPort is not configured — DecisionProblem remains SELECTED",
      );
    }

    const admission = await admissionPort.admitProposal({
      decisionProblem: problem,
      selectedScenario,
      intent,
      submittedAt: now,
    });

    if (admission.outcome === "UNAVAILABLE") {
      throw new ScenarioError(
        "PORTFOLIO_ADMISSION_UNAVAILABLE",
        admission.reason,
      );
    }
    if (admission.outcome === "REJECTED") {
      throw new ScenarioError(
        "PORTFOLIO_PROPOSAL_FAILED",
        admission.reason,
      );
    }

    const lineage: ScenarioPortfolioLineage = {
      lineageId,
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      decisionPackageHash: selection.decisionPackageHash,
      scenarioSetHash: selection.scenarioSetHash,
      selectedScenarioId: selectedScenario.scenarioId,
      selectionRecordId: selection.selectionRecordId,
      compiledIntentHash: intentHash,
      portfolioId: admission.portfolioId,
      portfolioAdmissionOutcome: admission.outcome,
      createdAt: priorLineage?.createdAt ?? now,
      updatedAt: now,
      recordRevision: (priorLineage?.recordRevision ?? 0) + 1,
    };
    await this.deps.lineage.save(lineage);

    if (this.deps.materializationFailpoint?.afterLineagePersist) {
      await this.deps.materializationFailpoint.afterLineagePersist();
    }

    const materialized = await this.transition(
      problem,
      "MATERIALIZED_AS_PROPOSAL",
    );
    return { problem: materialized, lineage };
  }

  private resolvePortfolioAdmissionPort():
    | PortfolioProposalAdmissionPort
    | undefined {
    if (this.deps.portfolioAdmissionPort) {
      return this.deps.portfolioAdmissionPort;
    }
    if (this.deps.portfolioService) {
      return new Phase15PortfolioProposalAdmissionPort(this.deps.portfolioService);
    }
    return undefined;
  }

  async markStale(decisionProblemId: string): Promise<DecisionProblem> {
    const problem = await this.requireProblem(decisionProblemId);
    if (problem.status === "MATERIALIZED_AS_PROPOSAL" || problem.status === "CANCELLED") {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Cannot mark stale from terminal state ${problem.status}`,
      );
    }
    return this.transition(problem, "STALE", {
      failureReasonCode: "TRUTH_DRIFT",
    });
  }

  private async simulateScenarioInternal(
    problem: DecisionProblem,
    scenarioSet: ScenarioSet,
    scenario: ScenarioDefinition,
    randomSeed: string,
  ): Promise<{ result: ScenarioSimulationResult; created: boolean }> {
    const configFp = simulationConfigurationFingerprint({
      maximumScenarioCount: problem.maximumScenarioCount,
      maximumSimulationRuns: problem.maximumSimulationRuns,
    });
    const inputFp = simulationInputFingerprint({
      decisionProblemVersion: problem.decisionProblemVersion,
      scenarioId: scenario.scenarioId,
      assumptionSetHash: scenarioSet.assumptionSetHash,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint!,
      engineVersion: this.deps.simulationEngine.engineVersion,
      configurationFingerprint: configFp,
      randomSeed,
    });

    const existing =
      await this.deps.simulationResults.getByInputFingerprint(inputFp);
    if (existing) {
      return { result: existing, created: false };
    }

    const ledger = await this.deps.usageLedger.get(problem.decisionProblemId);
    if (ledger && ledger.simRuns >= problem.maximumSimulationRuns) {
      throw new ScenarioError(
        "SIMULATION_BUDGET_EXCEEDED",
        `Simulation run budget ${problem.maximumSimulationRuns} exceeded`,
      );
    }

    const result = await this.deps.simulationEngine.simulate({
      decisionProblemId: problem.decisionProblemId,
      decisionProblemVersion: problem.decisionProblemVersion,
      scenario,
      scenarioSetId: scenarioSet.scenarioSetId,
      scenarioSetVersion: scenarioSet.scenarioSetVersion,
      assumptionSetHash: scenarioSet.assumptionSetHash,
      truthSnapshotFingerprint: problem.truthSnapshotFingerprint!,
      randomSeed,
      decisionCriteria: problem.decisionCriteria,
      maximumScenarioCount: problem.maximumScenarioCount,
      maximumSimulationRuns: problem.maximumSimulationRuns,
      createdAt: this.deps.nowIso(),
    });

    await this.deps.simulationResults.save(result);
    await this.incrementUsage(problem.decisionProblemId, { simRuns: 1 });
    return { result, created: true };
  }

  private async buildTruthSnapshot(
    primaryProjectId: string,
    environment: string,
  ): Promise<{
    truthSnapshotFingerprint: string;
    policyBundleFingerprint: string;
    capabilitySetFingerprint: string;
    projectConfigurationFingerprint: string;
  }> {
    const context = await this.deps.controlPlane.resolve(
      primaryProjectId,
      environment,
    );
    const caps = context.availableCapabilities.map((c) => ({
      capabilityId: c.capabilityId,
      version: c.version,
      enabled: c.enabled,
      allowedActions: c.allowedActions,
      forbiddenActions: c.forbiddenActions,
      allowedEnvironments: c.allowedEnvironments,
      approvalRequirement: c.approvalRequirement,
      maximumRuntimeSeconds: c.maximumRuntimeSeconds,
    }));
    const policyBundleFingerprint = context.activePolicyBundle.policyHash;
    const capFp = capabilitySetFingerprint(caps);
    const projFp = projectConfigurationFingerprint({
      projectId: primaryProjectId,
      activePolicyBundleId: context.project.activePolicyBundleId,
      budgetProfileId: context.project.resourceBudgetProfileId,
      allowedEnvironments: context.project.allowedEnvironments,
      executionMode: context.project.executionMode,
    });
    const truthSnapshotFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          capabilitySetFingerprint: capFp,
          policyBundleFingerprint,
          projectConfigurationFingerprint: projFp,
        }),
        "utf8",
      )
      .digest("hex");

    return {
      truthSnapshotFingerprint,
      policyBundleFingerprint,
      capabilitySetFingerprint: capFp,
      projectConfigurationFingerprint: projFp,
    };
  }

  private async recheckTruthOrMarkStale(problem: DecisionProblem): Promise<void> {
    const env = problem.allowedEnvironments[0]!;
    const current = await this.buildTruthSnapshot(
      problem.primaryProjectId,
      env,
    );
    if (
      problem.truthSnapshotFingerprint &&
      current.truthSnapshotFingerprint !== problem.truthSnapshotFingerprint
    ) {
      await this.markStale(problem.decisionProblemId);
      throw new ScenarioError(
        "PACKAGE_STALE",
        "Truth snapshot drifted — decision package marked STALE; re-analysis required",
        { reasonCode: "TRUTH_DRIFT" },
      );
    }
  }

  private async incrementUsage(
    decisionProblemId: string,
    delta: Partial<{
      scenarioCount: number;
      simRuns: number;
      modelCalls: number;
      sensitivityEvals: number;
    }>,
  ): Promise<void> {
    const ledger = await this.deps.usageLedger.get(decisionProblemId);
    if (!ledger) return;
    await this.deps.usageLedger.saveCas(
      {
        ...ledger,
        scenarioCount: ledger.scenarioCount + (delta.scenarioCount ?? 0),
        simRuns: ledger.simRuns + (delta.simRuns ?? 0),
        modelCalls: ledger.modelCalls + (delta.modelCalls ?? 0),
        sensitivityEvals:
          ledger.sensitivityEvals + (delta.sensitivityEvals ?? 0),
        updatedAt: this.deps.nowIso(),
      },
      ledger.recordRevision,
    );
  }

  private async requireProblem(
    decisionProblemId: string,
  ): Promise<DecisionProblem> {
    const problem = await this.deps.decisionProblems.getById(decisionProblemId);
    if (!problem) {
      throw new ScenarioError(
        "DECISION_PROBLEM_NOT_FOUND",
        `Decision problem ${decisionProblemId} missing`,
      );
    }
    return problem;
  }

  private async requireLatestScenarioSet(
    problem: DecisionProblem,
  ): Promise<ScenarioSet> {
    const set = await this.deps.scenarioSets.getLatest(problem.decisionProblemId);
    if (!set) {
      throw new ScenarioError(
        "SCENARIO_SET_INVALID",
        "Scenario set missing",
      );
    }
    return set;
  }

  private async requireLatestPackage(
    problem: DecisionProblem,
  ): Promise<StrategicDecisionPackage> {
    const pkg = await this.deps.decisionPackages.getLatest(
      problem.decisionProblemId,
    );
    if (!pkg) {
      throw new ScenarioError(
        "DECISION_PACKAGE_INVALID",
        "Decision package missing",
      );
    }
    return pkg;
  }

  private async transition(
    problem: DecisionProblem,
    next: DecisionProblem["status"],
    extras: Parameters<DecisionProblemRepository["transition"]>[5] = {},
  ): Promise<DecisionProblem> {
    assertDecisionTransition(problem.status, next);
    return withOptionalTransaction(this.deps.transactions, async () =>
      this.deps.decisionProblems.transition(
        problem.decisionProblemId,
        problem.status,
        problem.recordRevision,
        next,
        this.deps.nowIso(),
        extras,
      ),
    );
  }
}
