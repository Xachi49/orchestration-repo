import type { RunRepository } from "../admission/run-repository.js";
import type { AuthorizationRoutingOutcome } from "../authorization/result.js";
import type { MetricWindowKind } from "../domain/observability/index.js";
import type { VerifiedRepositoryContext } from "../ingestion/context.js";
import {
  buildDiscoveryContext,
  buildRunBindingFingerprints,
} from "./artifact-probe.js";
import { bindingHashForWorkKind, candidateWorkKinds } from "./discovery-map.js";
import type { PhaseDispatchPorts } from "./dispatcher.js";
import type { RunArtifactProbe } from "./service.js";
import type { SchedulerWorkItem } from "./work-item.js";
import type { SchedulerWorkKind } from "./work-kind.js";
import { isProgramSchedulerWorkKind } from "./work-kind.js";
import { isPortfolioSchedulerWorkKind } from "./work-kind.js";
import { isScenarioSchedulerWorkKind } from "./work-kind.js";
import { isExperimentSchedulerWorkKind } from "./work-kind.js";
import { isCausalSchedulerWorkKind } from "./work-kind.js";
import { isDecisionPolicySchedulerWorkKind } from "./work-kind.js";
import type { ScenarioOrchestrationService } from "../scenarios/service.js";
import type { DecisionProblemRepository } from "../scenarios/repositories.js";
import type { ExperimentOrchestrationService } from "../experiments/service.js";
import type { ExperimentRepository } from "../experiments/repositories.js";
import type { CausalOrchestrationService } from "../causal/service.js";
import type { CausalQuestionRepository } from "../causal/repositories.js";
import type { DecisionPolicyOrchestrationService } from "../decision-policies/service.js";
import type { DecisionPolicyCandidateRepository } from "../decision-policies/repositories.js";
import type { ProgramOrchestrationService } from "../programs/service.js";
import type { ProgramRepository } from "../programs/repositories.js";
import type { PortfolioOrchestrationService } from "../portfolio/service.js";
import type { PortfolioRepository } from "../portfolio/repositories.js";

/**
 * Readiness gate exposed by each phase. Scheduling never substitutes for it:
 * ELIGIBLE != AUTHORIZED, so every dispatch re-asks the owning phase.
 */
export interface PhaseReadinessProbe {
  assess(
    runId: string,
  ): Promise<
    { ready: true } | { ready: false; code: string; message: string }
  >;
}

export interface PhaseDispatchServices {
  ingest(
    runId: string,
    projectId: string,
    requestedEnvironment: string,
  ): Promise<VerifiedRepositoryContext>;
  plan(runId: string): Promise<{ planId: string }>;
  validate(runId: string): Promise<{ validationDecisionId: string }>;
  route(runId: string): Promise<AuthorizationRoutingOutcome>;
  execute(runId: string): Promise<{ executionAttemptId: string }>;
  verify(runId: string): Promise<{ outcomeVerificationId: string }>;
  learn(runId: string): Promise<{ historicalRunRecordId: string }>;
  rebuild(
    projectId: string,
    window: { projectId: string; kind: MetricWindowKind; lastN?: number },
  ): Promise<{ healthSnapshotId: string }>;
}

export interface PhaseDispatchPortsDeps {
  runs: RunRepository;
  artifacts: RunArtifactProbe;
  ingestion: Pick<PhaseDispatchServices, "ingest">;
  planning: Pick<PhaseDispatchServices, "plan">;
  validation: Pick<PhaseDispatchServices, "validate">;
  authorizationRouting: Pick<PhaseDispatchServices, "route">;
  execution: Pick<PhaseDispatchServices, "execute">;
  verification: Pick<PhaseDispatchServices, "verify">;
  memory: Pick<PhaseDispatchServices, "learn">;
  observability: Pick<PhaseDispatchServices, "rebuild">;
  planningReadiness: PhaseReadinessProbe;
  validationReadiness: PhaseReadinessProbe;
  authorizationReadiness: PhaseReadinessProbe;
  executionReadiness: PhaseReadinessProbe;
  verificationReadiness: PhaseReadinessProbe;
  defaultEnvironment: string;
  observabilityWindow?: { kind: MetricWindowKind; lastN?: number };
  /** Phase 14 program progression ports (optional until wired). */
  programs?: ProgramRepository;
  programService?: ProgramOrchestrationService;
  /** Phase 15 portfolio progression ports (optional until wired). */
  portfolios?: PortfolioRepository;
  portfolioService?: PortfolioOrchestrationService;
  /** Phase 16 scenario progression ports (optional until wired). */
  decisionProblems?: DecisionProblemRepository;
  scenarioService?: ScenarioOrchestrationService;
  /** Phase 17 experiment progression ports (optional until wired). */
  experiments?: ExperimentRepository;
  experimentService?: ExperimentOrchestrationService;
  /** Phase 18 causal progression ports (optional until wired). */
  causalQuestions?: CausalQuestionRepository;
  causalService?: CausalOrchestrationService;
  /** Phase 19 decision policy progression ports (optional until wired). */
  decisionPolicies?: DecisionPolicyCandidateRepository;
  decisionPolicyService?: DecisionPolicyOrchestrationService;
}

const DEFAULT_OBSERVABILITY_WINDOW: { kind: MetricWindowKind; lastN: number } =
  {
    kind: "LAST_N_RUNS",
    lastN: 20,
  };

/** Reason codes for binding drift, one per work kind's durable anchor. */
function bindingDriftReasonCode(kind: SchedulerWorkKind): string {
  switch (kind) {
    case "INGEST_REPOSITORY":
      return "RUN_BINDING_CHANGED";
    case "PLAN_RUN":
      return "REPOSITORY_CONTEXT_CHANGED";
    case "VALIDATE_PLAN":
      return "PLAN_REPLACED";
    case "ROUTE_AUTHORIZATION":
      return "VALIDATION_DECISION_CHANGED";
    case "EXECUTE_PLAN":
      return "AUTHORIZATION_CHANGED";
    case "VERIFY_OUTCOME":
      return "EXECUTION_ATTEMPT_CHANGED";
    case "LEARN_FROM_RUN":
      return "COMPLETION_RECORD_CHANGED";
    case "BUILD_OBSERVABILITY":
      return "OBSERVABILITY_BINDING_CHANGED";
    case "DECOMPOSE_PROGRAM":
    case "VALIDATE_PROGRAM":
    case "ROUTE_PROGRAM_MATERIALIZATION":
    case "MATERIALIZE_PROGRAM":
    case "RECONCILE_PROGRAM":
    case "VERIFY_PROGRAM":
      return "PROGRAM_BINDING_CHANGED";
    case "ANALYZE_PORTFOLIO":
    case "PLAN_PORTFOLIO":
    case "VALIDATE_PORTFOLIO":
    case "ROUTE_PORTFOLIO_AUTHORIZATION":
    case "MATERIALIZE_PORTFOLIO_PROGRAMS":
    case "RECONCILE_PORTFOLIO":
    case "VERIFY_PORTFOLIO":
    case "REBALANCE_PORTFOLIO":
      return "PORTFOLIO_BINDING_CHANGED";
    case "GROUND_DECISION_PROBLEM":
    case "GENERATE_SCENARIOS":
    case "SIMULATE_SCENARIOS":
    case "ANALYZE_SCENARIOS":
    case "VALIDATE_DECISION_PACKAGE":
    case "ROUTE_STRATEGY_SELECTION":
    case "MATERIALIZE_PORTFOLIO_PROPOSAL":
      return "SCENARIO_BINDING_CHANGED";
    case "DESIGN_EXPERIMENT":
    case "VALIDATE_EXPERIMENT":
    case "ROUTE_EXPERIMENT_AUTHORIZATION":
    case "COMPILE_EXPERIMENT_EXECUTION":
    case "RECONCILE_EXPERIMENT":
    case "VERIFY_EXPERIMENT":
    case "BUILD_EVIDENCE_BUNDLE":
    case "PROPOSE_ASSUMPTION_UPDATE":
      return "EXPERIMENT_BINDING_CHANGED";
    case "PROPOSE_CAUSAL_GRAPH":
    case "ANALYZE_IDENTIFICATION":
    case "ESTIMATE_CAUSAL_EFFECT":
    case "SYNTHESIZE_CAUSAL_EVIDENCE":
    case "VALIDATE_CAUSAL_CLAIM":
    case "ROUTE_CAUSAL_REVIEW":
    case "PROMOTE_CAUSAL_CLAIM":
    case "PROPOSE_MODEL_CALIBRATION":
      return "CAUSAL_BINDING_CHANGED";
    case "SYNTHESIZE_DECISION_POLICY":
    case "VALIDATE_DECISION_POLICY":
    case "EVALUATE_DECISION_POLICY":
    case "ROUTE_POLICY_APPROVAL":
    case "RUN_POLICY_SHADOW":
    case "EVALUATE_POLICY_SHADOW":
    case "ROUTE_POLICY_ACTIVATION":
    case "GENERATE_DECISION_RECOMMENDATION":
    case "PROPOSE_POLICY_REVISION":
      return "DECISION_POLICY_BINDING_CHANGED";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/**
 * Binds scheduler work kinds to the existing phase services.
 *
 * The scheduler proposes and sequences; it never approves. ROUTE_AUTHORIZATION
 * only opens the human gate, and EXECUTE_PLAN is refused unless the run already
 * reached APPROVED through human authorization.
 */
export function createPhaseDispatchPorts(
  deps: PhaseDispatchPortsDeps,
): PhaseDispatchPorts {
  const observabilityWindow =
    deps.observabilityWindow ?? DEFAULT_OBSERVABILITY_WINDOW;

  function readinessFor(kind: SchedulerWorkKind): PhaseReadinessProbe | null {
    switch (kind) {
      case "PLAN_RUN":
        return deps.planningReadiness;
      case "VALIDATE_PLAN":
        return deps.validationReadiness;
      case "ROUTE_AUTHORIZATION":
        return deps.authorizationReadiness;
      case "EXECUTE_PLAN":
        return deps.executionReadiness;
      case "VERIFY_OUTCOME":
        return deps.verificationReadiness;
      case "INGEST_REPOSITORY":
      case "LEARN_FROM_RUN":
      case "BUILD_OBSERVABILITY":
      case "DECOMPOSE_PROGRAM":
      case "VALIDATE_PROGRAM":
      case "ROUTE_PROGRAM_MATERIALIZATION":
      case "MATERIALIZE_PROGRAM":
      case "RECONCILE_PROGRAM":
      case "VERIFY_PROGRAM":
        // These phases own their own entry checks; no separate readiness port.
        return null;
      case "ANALYZE_PORTFOLIO":
      case "PLAN_PORTFOLIO":
      case "VALIDATE_PORTFOLIO":
      case "ROUTE_PORTFOLIO_AUTHORIZATION":
      case "MATERIALIZE_PORTFOLIO_PROGRAMS":
      case "RECONCILE_PORTFOLIO":
      case "VERIFY_PORTFOLIO":
      case "REBALANCE_PORTFOLIO":
        return null;
      case "GROUND_DECISION_PROBLEM":
      case "GENERATE_SCENARIOS":
      case "SIMULATE_SCENARIOS":
      case "ANALYZE_SCENARIOS":
      case "VALIDATE_DECISION_PACKAGE":
      case "ROUTE_STRATEGY_SELECTION":
      case "MATERIALIZE_PORTFOLIO_PROPOSAL":
        return null;
      case "DESIGN_EXPERIMENT":
      case "VALIDATE_EXPERIMENT":
      case "ROUTE_EXPERIMENT_AUTHORIZATION":
      case "COMPILE_EXPERIMENT_EXECUTION":
      case "RECONCILE_EXPERIMENT":
      case "VERIFY_EXPERIMENT":
      case "BUILD_EVIDENCE_BUNDLE":
      case "PROPOSE_ASSUMPTION_UPDATE":
        return null;
      case "PROPOSE_CAUSAL_GRAPH":
      case "ANALYZE_IDENTIFICATION":
      case "ESTIMATE_CAUSAL_EFFECT":
      case "SYNTHESIZE_CAUSAL_EVIDENCE":
      case "VALIDATE_CAUSAL_CLAIM":
      case "ROUTE_CAUSAL_REVIEW":
      case "PROMOTE_CAUSAL_CLAIM":
      case "PROPOSE_MODEL_CALIBRATION":
        return null;
      case "SYNTHESIZE_DECISION_POLICY":
      case "VALIDATE_DECISION_POLICY":
      case "EVALUATE_DECISION_POLICY":
      case "ROUTE_POLICY_APPROVAL":
      case "RUN_POLICY_SHADOW":
      case "EVALUATE_POLICY_SHADOW":
      case "ROUTE_POLICY_ACTIVATION":
      case "GENERATE_DECISION_RECOMMENDATION":
      case "PROPOSE_POLICY_REVISION":
        return null;
      default: {
        const _exhaustive: never = kind;
        return _exhaustive;
      }
    }
  }

  return {
    defaultEnvironment: deps.defaultEnvironment,

    async ingest(runId, projectId) {
      const run = await deps.runs.getById(runId);
      if (!run) {
        throw new Error(`Run not found for ingestion: ${runId}`);
      }
      // The run's admitted environment is the durable truth; a scheduler
      // default must not widen it.
      const context = await deps.ingestion.ingest(
        runId,
        projectId,
        run.requestedEnvironment,
      );
      return { resultRef: context.repositoryFingerprint };
    },

    async plan(runId) {
      const result = await deps.planning.plan(runId);
      return { resultRef: result.planId };
    },

    async validate(runId) {
      const result = await deps.validation.validate(runId);
      return { resultRef: result.validationDecisionId };
    },

    async routeAuthorization(runId) {
      const outcome = await deps.authorizationRouting.route(runId);
      const approvalRequestId =
        "approvalRequestId" in outcome ? outcome.approvalRequestId : undefined;
      return approvalRequestId !== undefined
        ? { resultRef: approvalRequestId }
        : {};
    },

    async execute(runId) {
      const result = await deps.execution.execute(runId);
      return { resultRef: result.executionAttemptId };
    },

    async verify(runId) {
      const result = await deps.verification.verify(runId);
      return { resultRef: result.outcomeVerificationId };
    },

    async learn(runId) {
      const result = await deps.memory.learn(runId);
      return { resultRef: result.historicalRunRecordId };
    },

    async rebuildObservability(projectId) {
      const result = await deps.observability.rebuild(projectId, {
        projectId,
        kind: observabilityWindow.kind,
        ...(observabilityWindow.lastN !== undefined
          ? { lastN: observabilityWindow.lastN }
          : {}),
      });
      return { resultRef: result.healthSnapshotId };
    },

    async decomposeProgram(programId) {
      if (!deps.programService) {
        throw new Error("Program service not configured");
      }
      const result = await deps.programService.decompose(programId);
      return {
        resultRef: result.plan?.programPlanHash ?? result.program.status,
      };
    },

    async validateProgram(programId) {
      if (!deps.programService) {
        throw new Error("Program service not configured");
      }
      const result = await deps.programService.validate(programId);
      return { resultRef: result.program.status };
    },

    async routeProgramMaterialization(programId) {
      if (!deps.programService) {
        throw new Error("Program service not configured");
      }
      const result =
        await deps.programService.routeMaterializationApproval(programId);
      return { resultRef: result.approval.approvalId };
    },

    async materializeProgram(programId) {
      if (!deps.programService) {
        throw new Error("Program service not configured");
      }
      const result = await deps.programService.materializeNext(programId);
      return { resultRef: result.program.status };
    },

    async reconcileProgram(programId) {
      if (!deps.programService) {
        throw new Error("Program service not configured");
      }
      const result = await deps.programService.reconcile(programId);
      return {
        resultRef: `${result.requiredComplete}/${result.requiredTotal}`,
      };
    },

    async verifyProgram(programId) {
      if (!deps.programService) {
        throw new Error("Program service not configured");
      }
      const result = await deps.programService.verify(programId);
      return { resultRef: result.outcome };
    },

    async analyzePortfolio(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result = await deps.portfolioService.analyze(portfolioId);
      return { resultRef: result.portfolio.status };
    },

    async planPortfolio(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result = await deps.portfolioService.plan(portfolioId);
      return {
        resultRef: result.plan.portfolioPlanHash ?? result.portfolio.status,
      };
    },

    async validatePortfolio(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result = await deps.portfolioService.validate(portfolioId);
      return { resultRef: result.portfolio.status };
    },

    async routePortfolioAuthorization(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result =
        await deps.portfolioService.routeAuthorization(portfolioId);
      return { resultRef: result.request.authorizationId };
    },

    async materializePortfolioPrograms(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result =
        await deps.portfolioService.materializePrograms(portfolioId);
      return { resultRef: result.portfolio.status };
    },

    async reconcilePortfolio(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result = await deps.portfolioService.reconcile(portfolioId);
      return {
        resultRef: `${result.stalledPrograms.length}:${result.computedAt}`,
      };
    },

    async verifyPortfolio(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result = await deps.portfolioService.verify(portfolioId);
      return { resultRef: result.outcome };
    },

    async rebalancePortfolio(portfolioId) {
      if (!deps.portfolioService) {
        throw new Error("Portfolio service not configured");
      }
      const result = await deps.portfolioService.proposeRebalance(
        portfolioId,
        "GOAL_COVERAGE_GAP",
      );
      return { resultRef: result.proposal.rebalanceId };
    },

    async groundDecisionProblem(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result = await deps.scenarioService.ground(decisionProblemId);
      return { resultRef: result.status };
    },

    async generateScenarios(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result =
        await deps.scenarioService.generateScenarios(decisionProblemId);
      return { resultRef: result.scenarioSet.scenarioSetHash };
    },

    async simulateScenarios(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result = await deps.scenarioService.simulateAll(decisionProblemId);
      return { resultRef: `${result.results.length}` };
    },

    async analyzeScenarios(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result = await deps.scenarioService.analyze(decisionProblemId);
      return { resultRef: result.problem.status };
    },

    async validateDecisionPackage(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result =
        await deps.scenarioService.validatePackage(decisionProblemId);
      return { resultRef: result.pkg.decisionPackageHash };
    },

    async routeStrategySelection(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result =
        await deps.scenarioService.routeSelection(decisionProblemId);
      return { resultRef: result.request.selectionId };
    },

    async materializePortfolioProposal(decisionProblemId) {
      if (!deps.scenarioService) {
        throw new Error("Scenario service not configured");
      }
      const result =
        await deps.scenarioService.materializePortfolioProposal(
          decisionProblemId,
        );
      return { resultRef: result.lineage.lineageId };
    },

    async designExperiment(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      const result = await deps.experimentService.design(experimentId);
      return { resultRef: result.plan.experimentPlanHash };
    },

    async validateExperiment(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      const result = await deps.experimentService.validate(experimentId);
      return { resultRef: result.experiment.status };
    },

    async routeExperimentAuthorization(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      const result =
        await deps.experimentService.routeAuthorization(experimentId);
      return { resultRef: result.request.authorizationId };
    },

    async compileExperimentExecution(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      const result =
        await deps.experimentService.compileExecution(experimentId);
      return { resultRef: result.lineage.lineageId };
    },

    async reconcileExperiment(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      // Producer-facing reconcile: recheck truth; do not invent Phase 6 auth.
      const experiment =
        await deps.experiments?.getById(experimentId);
      if (experiment) {
        await deps.experimentService.recheckTruthOrMarkStale(experiment);
      }
      return { resultRef: experimentId };
    },

    async verifyExperiment(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      const result = await deps.experimentService.verifyAndComplete(experimentId);
      return { resultRef: result.completion.completionRecordId };
    },

    async buildEvidenceBundle(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      // Evidence is built inside verifyAndComplete; this kind is idempotent reuse.
      const result = await deps.experimentService.verifyAndComplete(experimentId);
      return { resultRef: result.evidenceBundle.evidenceBundleId };
    },

    async proposeAssumptionUpdate(experimentId) {
      if (!deps.experimentService) {
        throw new Error("Experiment service not configured");
      }
      const result = await deps.experimentService.verifyAndComplete(experimentId);
      return {
        resultRef: result.updateCandidates[0]?.candidateId ?? experimentId,
      };
    },

    async proposeCausalGraph(causalQuestionId) {
      if (!deps.causalService) {
        throw new Error("Causal service not configured");
      }
      const result = await deps.causalService.proposeGraph(causalQuestionId);
      return { resultRef: result.graph.graphHash };
    },

    async analyzeIdentification(causalQuestionId) {
      if (!deps.causalService) {
        throw new Error("Causal service not configured");
      }
      const result = await deps.causalService.identify(causalQuestionId);
      return { resultRef: result.analysis.identificationAnalysisId };
    },

    async estimateCausalEffect(causalQuestionId) {
      if (!deps.causalService) {
        throw new Error("Causal service not configured");
      }
      const result = await deps.causalService.estimate(causalQuestionId);
      return { resultRef: result.estimate.causalEstimateId };
    },

    async synthesizeCausalEvidence(causalQuestionId) {
      if (!deps.causalService) {
        throw new Error("Causal service not configured");
      }
      const result = await deps.causalService.synthesize(causalQuestionId);
      return { resultRef: result.synthesis.evidenceSynthesisId };
    },

    async validateCausalClaim(causalQuestionId) {
      if (!deps.causalService) {
        throw new Error("Causal service not configured");
      }
      const result = await deps.causalService.validate(causalQuestionId);
      return { resultRef: result.claim.claimHash };
    },

    async routeCausalReview(causalQuestionId) {
      if (!deps.causalService) {
        throw new Error("Causal service not configured");
      }
      const result = await deps.causalService.routeReview(causalQuestionId);
      return { resultRef: result.request.reviewRequestId };
    },

    async promoteCausalClaim(causalQuestionId) {
      // Human gate: promotion only via decideReview — dispatch is a no-op settle.
      if (!deps.causalQuestions) {
        throw new Error("Causal questions not configured");
      }
      const question = await deps.causalQuestions.getById(causalQuestionId);
      return { resultRef: question?.status ?? causalQuestionId };
    },

    async proposeModelCalibration(causalQuestionId) {
      if (!deps.causalQuestions) {
        throw new Error("Causal questions not configured");
      }
      const question = await deps.causalQuestions.getById(causalQuestionId);
      return { resultRef: question?.status ?? causalQuestionId };
    },

    async synthesizeDecisionPolicy(decisionPolicyId) {
      if (!deps.decisionPolicies) {
        throw new Error("Decision policies not configured");
      }
      const policy = await deps.decisionPolicies.getById(decisionPolicyId);
      return { resultRef: policy?.policyHash ?? decisionPolicyId };
    },

    async validateDecisionPolicy(decisionPolicyId) {
      if (!deps.decisionPolicyService) {
        throw new Error("Decision policy service not configured");
      }
      const result =
        await deps.decisionPolicyService.validatePolicy(decisionPolicyId);
      return { resultRef: result.policy.policyHash };
    },

    async evaluateDecisionPolicy(decisionPolicyId) {
      if (!deps.decisionPolicies) {
        throw new Error("Decision policies not configured");
      }
      const policy = await deps.decisionPolicies.getById(decisionPolicyId);
      return { resultRef: policy?.policyHash ?? decisionPolicyId };
    },

    async routePolicyApproval(decisionPolicyId) {
      if (!deps.decisionPolicyService || !deps.decisionPolicies) {
        throw new Error("Decision policy service not configured");
      }
      const policy = await deps.decisionPolicies.getById(decisionPolicyId);
      if (policy?.status === "AWAITING_APPROVAL") {
        return { resultRef: policy.policyHash };
      }
      const result =
        await deps.decisionPolicyService.routeApproval(decisionPolicyId);
      return { resultRef: result.request.decisionPolicyApprovalRequestId };
    },

    async runPolicyShadow(decisionPolicyId) {
      if (!deps.decisionPolicies) {
        throw new Error("Decision policies not configured");
      }
      const policy = await deps.decisionPolicies.getById(decisionPolicyId);
      return { resultRef: policy?.status ?? decisionPolicyId };
    },

    async evaluatePolicyShadow(decisionPolicyId) {
      if (!deps.decisionPolicyService) {
        throw new Error("Decision policy service not configured");
      }
      const result =
        await deps.decisionPolicyService.evaluateShadow(decisionPolicyId);
      return {
        resultRef: result.evaluation.decisionPolicyShadowEvaluationId,
      };
    },

    async routePolicyActivation(decisionPolicyId) {
      if (!deps.decisionPolicyService) {
        throw new Error("Decision policy service not configured");
      }
      const result =
        await deps.decisionPolicyService.routeActivation(decisionPolicyId);
      return { resultRef: result.request.decisionPolicyActivationRequestId };
    },

    async generateDecisionRecommendation(decisionPolicyId) {
      // Live recommend requires snapshot — producer settles identity only.
      if (!deps.decisionPolicies) {
        throw new Error("Decision policies not configured");
      }
      const policy = await deps.decisionPolicies.getById(decisionPolicyId);
      return { resultRef: policy?.status ?? decisionPolicyId };
    },

    async proposePolicyRevision(decisionPolicyId) {
      if (!deps.decisionPolicies) {
        throw new Error("Decision policies not configured");
      }
      const policy = await deps.decisionPolicies.getById(decisionPolicyId);
      return { resultRef: policy?.status ?? decisionPolicyId };
    },

    async assertDispatchReady(work: SchedulerWorkItem) {
      if (isDecisionPolicySchedulerWorkKind(work.workKind)) {
        if (!deps.decisionPolicies) {
          return {
            ok: false as const,
            reasonCode: "DECISION_POLICY_SERVICE_MISSING",
            message: "Decision policy repository not configured",
          };
        }
        const policy = await deps.decisionPolicies.getById(work.runId);
        if (!policy) {
          return {
            ok: false as const,
            reasonCode: "DECISION_POLICY_NOT_FOUND",
            message: `Decision policy ${work.runId} not found`,
          };
        }
        if (
          work.workKind === "ROUTE_POLICY_APPROVAL" &&
          policy.status !== "AWAITING_APPROVAL" &&
          policy.status !== "VALIDATED"
        ) {
          return {
            ok: false as const,
            reasonCode: "DECISION_POLICY_STATE_CONFLICT",
            message: `ROUTE_POLICY_APPROVAL requires VALIDATED/AWAITING_APPROVAL (got ${policy.status})`,
          };
        }
        if (
          work.workKind === "ROUTE_POLICY_ACTIVATION" &&
          policy.status !== "AWAITING_ACTIVATION"
        ) {
          return {
            ok: false as const,
            reasonCode: "DECISION_POLICY_STATE_CONFLICT",
            message: `ROUTE_POLICY_ACTIVATION requires AWAITING_ACTIVATION (got ${policy.status})`,
          };
        }
        return { ok: true as const };
      }
      if (isCausalSchedulerWorkKind(work.workKind)) {
        if (!deps.causalQuestions) {
          return {
            ok: false as const,
            reasonCode: "CAUSAL_SERVICE_MISSING",
            message: "Causal question repository not configured for dispatch",
          };
        }
        const question = await deps.causalQuestions.getById(work.runId);
        if (!question) {
          return {
            ok: false as const,
            reasonCode: "CAUSAL_QUESTION_NOT_FOUND",
            message: `Causal question ${work.runId} no longer exists`,
          };
        }
        if (!question.projectIds.includes(work.projectId)) {
          return {
            ok: false as const,
            reasonCode: "CAUSAL_PROJECT_MISMATCH",
            message: `Causal question ${work.runId} does not include project ${work.projectId}`,
          };
        }
        if (
          work.workKind === "ROUTE_CAUSAL_REVIEW" &&
          question.status !== "AWAITING_CAUSAL_REVIEW"
        ) {
          return {
            ok: false as const,
            reasonCode: "CAUSAL_STATE_CONFLICT",
            message: `Causal question ${work.runId} not awaiting causal review`,
          };
        }
        return { ok: true as const };
      }

      if (isExperimentSchedulerWorkKind(work.workKind)) {
        if (!deps.experiments) {
          return {
            ok: false as const,
            reasonCode: "EXPERIMENT_SERVICE_MISSING",
            message: "Experiment repository not configured for dispatch",
          };
        }
        const experiment = await deps.experiments.getById(work.runId);
        if (!experiment) {
          return {
            ok: false as const,
            reasonCode: "EXPERIMENT_NOT_FOUND",
            message: `Experiment ${work.runId} no longer exists`,
          };
        }
        if (experiment.projectId !== work.projectId) {
          return {
            ok: false as const,
            reasonCode: "EXPERIMENT_PROJECT_MISMATCH",
            message: `Experiment ${work.runId} belongs to a different project`,
          };
        }
        if (
          work.workKind === "ROUTE_EXPERIMENT_AUTHORIZATION" &&
          experiment.status !== "AWAITING_AUTHORIZATION"
        ) {
          return {
            ok: false as const,
            reasonCode: "EXPERIMENT_STATE_CONFLICT",
            message: `Experiment ${work.runId} not awaiting authorization`,
          };
        }
        if (
          work.workKind === "COMPILE_EXPERIMENT_EXECUTION" &&
          experiment.status !== "AUTHORIZED" &&
          experiment.status !== "AWAITING_EXECUTION_AUTHORIZATION"
        ) {
          return {
            ok: false as const,
            reasonCode: "EXPERIMENT_AUTHORIZATION_REQUIRED",
            message: `Experiment ${work.runId} requires sponsor authorization first`,
          };
        }
        return { ok: true as const };
      }

      if (isScenarioSchedulerWorkKind(work.workKind)) {
        if (!deps.decisionProblems) {
          return {
            ok: false as const,
            reasonCode: "SCENARIO_SERVICE_MISSING",
            message: "Decision problem repository not configured for dispatch",
          };
        }
        const problem = await deps.decisionProblems.getById(work.runId);
        if (!problem) {
          return {
            ok: false as const,
            reasonCode: "DECISION_PROBLEM_NOT_FOUND",
            message: `Decision problem ${work.runId} no longer exists`,
          };
        }
        if (problem.primaryProjectId !== work.projectId) {
          return {
            ok: false as const,
            reasonCode: "DECISION_PROBLEM_PROJECT_MISMATCH",
            message: `Decision problem ${work.runId} belongs to a different project`,
          };
        }
        if (
          work.workKind === "MATERIALIZE_PORTFOLIO_PROPOSAL" &&
          problem.status !== "SELECTED"
        ) {
          return {
            ok: false as const,
            reasonCode: "STRATEGY_SELECTION_REQUIRED",
            message: `Decision problem ${work.runId} requires strategy selection first`,
          };
        }
        if (
          work.workKind === "ROUTE_STRATEGY_SELECTION" &&
          problem.status !== "AWAITING_SELECTION"
        ) {
          return {
            ok: false as const,
            reasonCode: "DECISION_PROBLEM_STATE_CONFLICT",
            message: `Decision problem ${work.runId} not awaiting selection`,
          };
        }
        return { ok: true as const };
      }

      if (isPortfolioSchedulerWorkKind(work.workKind)) {
        if (!deps.portfolios) {
          return {
            ok: false as const,
            reasonCode: "PORTFOLIO_SERVICE_MISSING",
            message: "Portfolio repository not configured for dispatch",
          };
        }
        const portfolio = await deps.portfolios.getById(work.runId);
        if (!portfolio) {
          return {
            ok: false as const,
            reasonCode: "PORTFOLIO_NOT_FOUND",
            message: `Portfolio ${work.runId} no longer exists`,
          };
        }
        if (portfolio.primaryProjectId !== work.projectId) {
          return {
            ok: false as const,
            reasonCode: "PORTFOLIO_PROJECT_MISMATCH",
            message: `Portfolio ${work.runId} belongs to a different project`,
          };
        }
        if (
          work.workKind === "MATERIALIZE_PORTFOLIO_PROGRAMS" &&
          portfolio.status === "AWAITING_AUTHORIZATION"
        ) {
          return {
            ok: false as const,
            reasonCode: "AWAITING_PORTFOLIO_AUTHORIZATION",
            message: `Portfolio ${work.runId} awaits portfolio authorization`,
          };
        }
        return { ok: true as const };
      }

      if (isProgramSchedulerWorkKind(work.workKind)) {
        if (!deps.programs) {
          return {
            ok: false as const,
            reasonCode: "PROGRAM_SERVICE_MISSING",
            message: "Program repository not configured for dispatch",
          };
        }
        const program = await deps.programs.getById(work.runId);
        if (!program) {
          return {
            ok: false as const,
            reasonCode: "PROGRAM_NOT_FOUND",
            message: `Program ${work.runId} no longer exists`,
          };
        }
        if (program.projectId !== work.projectId) {
          return {
            ok: false as const,
            reasonCode: "PROGRAM_PROJECT_MISMATCH",
            message: `Program ${work.runId} belongs to a different project`,
          };
        }
        if (
          work.workKind === "MATERIALIZE_PROGRAM" &&
          program.status === "AWAITING_MATERIALIZATION_APPROVAL"
        ) {
          return {
            ok: false as const,
            reasonCode: "AWAITING_PROGRAM_MATERIALIZATION_APPROVAL",
            message: `Program ${work.runId} awaits materialization approval`,
          };
        }
        return { ok: true as const };
      }

      const run = await deps.runs.getById(work.runId);
      if (!run) {
        return {
          ok: false as const,
          reasonCode: "RUN_NOT_FOUND",
          message: `Run ${work.runId} no longer exists`,
        };
      }
      if (run.projectId !== work.projectId) {
        return {
          ok: false as const,
          reasonCode: "RUN_PROJECT_MISMATCH",
          message: `Run ${work.runId} belongs to a different project`,
        };
      }

      // HUMAN APPROVAL BARRIER. Checked before anything else so no drift,
      // readiness, or binding path can reach an actuator without approval.
      if (work.workKind === "EXECUTE_PLAN") {
        if (run.state === "AWAITING_APPROVAL") {
          return {
            ok: false as const,
            reasonCode: "AWAITING_HUMAN_APPROVAL",
            message: `Run ${work.runId} is awaiting human approval`,
          };
        }
        if (run.state !== "APPROVED") {
          return {
            ok: false as const,
            reasonCode: "RUN_NOT_APPROVED",
            message: `Run ${work.runId} is in ${run.state}, expected APPROVED`,
          };
        }
      }

      const context = await buildDiscoveryContext(deps.artifacts, run);
      const kinds = candidateWorkKinds(context);
      if (!kinds.includes(work.workKind)) {
        return {
          ok: false as const,
          reasonCode: "WORK_KIND_NOT_APPLICABLE",
          message: `${work.workKind} is no longer a candidate for run ${work.runId} in ${run.state}`,
        };
      }

      const fingerprints = await buildRunBindingFingerprints(
        deps.artifacts,
        work.runId,
      );
      const liveBindingHash = bindingHashForWorkKind(
        work.workKind,
        fingerprints,
      );
      if (liveBindingHash !== work.bindingHash) {
        return {
          ok: false as const,
          reasonCode: bindingDriftReasonCode(work.workKind),
          message: `Binding for ${work.workKind} on run ${work.runId} changed since this work was created`,
        };
      }

      const readiness = readinessFor(work.workKind);
      if (readiness) {
        const assessment = await readiness.assess(work.runId);
        if (!assessment.ready) {
          return {
            ok: false as const,
            reasonCode: assessment.code,
            message: assessment.message,
          };
        }
      }

      return { ok: true as const };
    },
  };
}
