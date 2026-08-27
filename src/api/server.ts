import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { RepositoryTruthService } from "../ingestion/service.js";
import type { PlanningService } from "../planning/service.js";
import type { ValidationService } from "../validation/service.js";
import type { AuthorizationRoutingService } from "../authorization/routing.js";
import type { HumanAuthorizationService } from "../authorization/service.js";
import type { ApprovalExpiryService } from "../authorization/expiry.js";
import type { AuthorizationReadinessService } from "../authorization/readiness.js";
import type { ExecutionService } from "../execution/service.js";
import type { ExecutionReadinessService } from "../execution/readiness.js";
import type { OutcomeVerificationService } from "../verification/service.js";
import type { VerificationReadinessService } from "../verification/readiness.js";
import type { GovernedMemoryService } from "../memory/service.js";
import type { ObservabilityService } from "../observability/service.js";
import type { StorageMode } from "../domain/durability/index.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { PortfolioSchedulerService } from "../scheduling/service.js";
import Fastify from "fastify";
import { registerRunRoutes } from "./runs.js";
import { registerIngestRoutes } from "./ingest.js";
import { registerPlanRoutes } from "./plan.js";
import { registerValidationRoutes } from "./validate.js";
import { registerAuthorizationRoutes } from "./authorize.js";
import { registerExecutionRoutes } from "./execute.js";
import { registerVerificationRoutes } from "./verify.js";
import { registerLearningRoutes } from "./learn.js";
import { registerObservabilityRoutes } from "./observability.js";
import { registerSchedulerRoutes } from "./scheduler.js";
import { registerProgramRoutes } from "./programs.js";
import { registerPortfolioRoutes } from "./portfolios.js";
import { registerDecisionRoutes } from "./decisions.js";
import { registerExperimentRoutes } from "./experiments.js";
import { registerCausalRoutes } from "./causal.js";
import { registerDecisionPolicyRoutes } from "./decision-policies.js";
import type { ProgramOrchestrationService } from "../programs/service.js";
import type { ProgramRepository, ProgramPlanRepository } from "../programs/repositories.js";
import type { PortfolioOrchestrationService } from "../portfolio/service.js";
import type {
  PortfolioRepository,
  PortfolioPlanRepository,
} from "../portfolio/repositories.js";
import type { ScenarioOrchestrationService } from "../scenarios/service.js";
import type {
  DecisionProblemRepository,
  DecisionPackageRepository,
  ScenarioCalibrationRepository,
} from "../scenarios/repositories.js";
import type { ExperimentOrchestrationService } from "../experiments/service.js";
import type {
  ExperimentRepository,
  ExperimentEvidenceBundleRepository,
} from "../experiments/repositories.js";
import type { CausalOrchestrationService } from "../causal/service.js";
import type {
  CausalQuestionRepository,
  PromotedCausalClaimRepository,
  DecisionModelCalibrationCandidateRepository,
} from "../causal/repositories.js";
import type { DecisionPolicyOrchestrationService } from "../decision-policies/service.js";
import type {
  DecisionContextRepository,
  DecisionPolicyCandidateRepository,
  DecisionRecommendationRepository,
} from "../decision-policies/repositories.js";
import { registerPerimeter, type PerimeterDeps } from "../runtime/perimeter.js";
import { registerHealthRoutes, type HealthDeps } from "../runtime/health.js";

export interface ApiDeps {
  admission?: ObjectiveAdmissionService;
  ingestion?: RepositoryTruthService;
  planning?: PlanningService;
  validation?: ValidationService;
  authorizationRouting?: AuthorizationRoutingService;
  humanAuthorization?: HumanAuthorizationService;
  approvalExpiry?: ApprovalExpiryService;
  authorizationReadiness?: AuthorizationReadinessService;
  execution?: ExecutionService;
  executionReadiness?: ExecutionReadinessService;
  verification?: OutcomeVerificationService;
  verificationReadiness?: VerificationReadinessService;
  memory?: GovernedMemoryService;
  observability?: ObservabilityService;
  scheduler?: PortfolioSchedulerService;
  programService?: ProgramOrchestrationService;
  programs?: ProgramRepository;
  programPlans?: ProgramPlanRepository;
  portfolioService?: PortfolioOrchestrationService;
  portfolios?: PortfolioRepository;
  portfolioPlans?: PortfolioPlanRepository;
  scenarioService?: ScenarioOrchestrationService;
  decisionProblems?: DecisionProblemRepository;
  decisionPackages?: DecisionPackageRepository;
  calibrationRecords?: ScenarioCalibrationRepository;
  experimentService?: ExperimentOrchestrationService;
  experiments?: ExperimentRepository;
  experimentEvidenceBundles?: ExperimentEvidenceBundleRepository;
  causalService?: CausalOrchestrationService;
  causalQuestions?: CausalQuestionRepository;
  promotedCausalClaims?: PromotedCausalClaimRepository;
  causalCalibrationCandidates?: DecisionModelCalibrationCandidateRepository;
  decisionPolicyService?: DecisionPolicyOrchestrationService;
  decisionContexts?: DecisionContextRepository;
  decisionPolicies?: DecisionPolicyCandidateRepository;
  decisionRecommendations?: DecisionRecommendationRepository;
  storageMode?: StorageMode;
  runs?: RunRepository;
  readiness?: {
    storageMode: StorageMode;
    databaseReachable: boolean;
    schemaCompatible: boolean;
    schemaVersion?: string;
    supportedSchemaVersion: string;
  };
  perimeter?: PerimeterDeps;
  health?: HealthDeps;
  bodyLimitBytes?: number;
  requestTimeoutMs?: number;
}

/**
 * HTTP surface. Business logic lives in application services.
 */
export async function buildServer(deps: ApiDeps = {}) {
  const app = Fastify({
    logger: false,
    bodyLimit: deps.bodyLimitBytes ?? 1_048_576,
    requestTimeout: deps.requestTimeoutMs ?? 30_000,
  });

  const approvalEnabled = Boolean(
    deps.authorizationRouting && deps.humanAuthorization,
  );
  const executionEnabled = Boolean(deps.execution);
  const verificationEnabled = Boolean(deps.verification);
  const memoryEnabled = Boolean(deps.memory);
  const observabilityEnabled = Boolean(deps.observability);

  if (deps.health) {
    registerHealthRoutes(app, deps.health);
  }

  app.get("/health", async () => ({
    status: "ok",
    phase: deps.decisionPolicyService
      ? 19
      : deps.causalService
        ? 18
        : deps.experimentService
        ? 17
        : deps.scenarioService
          ? 16
          : deps.portfolioService
            ? 15
            : deps.programService
              ? 14
              : deps.scheduler
                ? 13
                : observabilityEnabled
                  ? 12
                  : memoryEnabled
                    ? 9
                    : verificationEnabled
                      ? 8
                      : executionEnabled
                        ? 7
                        : approvalEnabled
                          ? 6
                          : deps.validation
                            ? 5
                            : 6,
    milestone: deps.decisionPolicyService
      ? 19
      : deps.causalService
        ? 18
        : deps.experimentService
        ? 17
        : deps.scenarioService
          ? 16
          : deps.portfolioService
            ? 15
            : deps.programService
              ? 14
              : deps.scheduler
                ? 13
                : 12,
    orchestrator: deps.decisionPolicyService
      ? "decision-policies"
      : deps.causalService
        ? "causal"
        : deps.experimentService
        ? "experiments"
        : deps.scenarioService
          ? "scenarios"
          : deps.portfolioService
            ? "portfolios"
            : deps.programService
              ? "programs"
              : deps.scheduler
                ? "scheduler"
                : observabilityEnabled
                  ? "observability"
                  : memoryEnabled
                    ? "memory"
                    : verificationEnabled
                      ? "verification"
                      : executionEnabled
                        ? "execution"
                        : approvalEnabled
                          ? "authorization"
                          : deps.validation
                            ? "validation"
                            : "planning",
    llmConnected: false,
    githubConnected: false,
    githubWritesEnabled: false,
    executionEnabled,
    verificationEnabled,
    memoryEnabled,
    observabilityEnabled,
    approvalEnabled,
    schedulerEnabled: Boolean(deps.scheduler),
    storageMode: deps.storageMode ?? "memory",
    databaseReachable: deps.readiness?.databaseReachable ?? null,
    schemaCompatible: deps.readiness?.schemaCompatible ?? null,
    schemaVersion: deps.readiness?.schemaVersion ?? null,
    supportedSchemaVersion: deps.readiness?.supportedSchemaVersion ?? null,
    planningModelToolsEnabled: false,
    validationModelToolsEnabled: false,
    verificationModelToolsEnabled: false,
    learningModelToolsEnabled: false,
  }));

  if (deps.perimeter) {
    await registerPerimeter(app, deps.perimeter);
  }

  if (deps.admission) {
    registerRunRoutes(app, deps.admission);
  }
  if (deps.ingestion) {
    registerIngestRoutes(app, deps.ingestion);
  }
  if (deps.planning) {
    registerPlanRoutes(app, deps.planning);
  }
  if (deps.validation) {
    registerValidationRoutes(app, deps.validation);
  }
  if (
    deps.authorizationRouting &&
    deps.humanAuthorization &&
    deps.approvalExpiry &&
    deps.authorizationReadiness
  ) {
    registerAuthorizationRoutes(app, {
      routing: deps.authorizationRouting,
      humanAuthorization: deps.humanAuthorization,
      expiry: deps.approvalExpiry,
      readiness: deps.authorizationReadiness,
    });
  }
  if (deps.execution && deps.executionReadiness) {
    registerExecutionRoutes(app, {
      execution: deps.execution,
      readiness: deps.executionReadiness,
    });
  }
  if (deps.verification && deps.verificationReadiness) {
    registerVerificationRoutes(app, {
      verification: deps.verification,
      readiness: deps.verificationReadiness,
    });
  }
  if (deps.memory) {
    registerLearningRoutes(app, { memory: deps.memory });
  }
  if (deps.observability) {
    registerObservabilityRoutes(app, { observability: deps.observability });
  }
  if (deps.scheduler && deps.runs) {
    registerSchedulerRoutes(app, {
      scheduler: deps.scheduler,
      runs: deps.runs,
    });
  }

  if (deps.programService && deps.programs && deps.programPlans) {
    registerProgramRoutes(app, {
      programService: deps.programService,
      programs: deps.programs,
      programPlans: deps.programPlans,
    });
  }

  if (deps.portfolioService && deps.portfolios && deps.portfolioPlans) {
    registerPortfolioRoutes(app, {
      portfolioService: deps.portfolioService,
      portfolios: deps.portfolios,
      portfolioPlans: deps.portfolioPlans,
    });
  }

  if (
    deps.scenarioService &&
    deps.decisionProblems &&
    deps.decisionPackages &&
    deps.calibrationRecords
  ) {
    registerDecisionRoutes(app, {
      scenarioService: deps.scenarioService,
      decisionProblems: deps.decisionProblems,
      decisionPackages: deps.decisionPackages,
      calibrationRecords: deps.calibrationRecords,
    });
  }

  if (
    deps.experimentService &&
    deps.experiments &&
    deps.experimentEvidenceBundles
  ) {
    registerExperimentRoutes(app, {
      experimentService: deps.experimentService,
      experiments: deps.experiments,
      evidenceBundles: deps.experimentEvidenceBundles,
    });
  }

  if (
    deps.causalService &&
    deps.causalQuestions &&
    deps.promotedCausalClaims &&
    deps.causalCalibrationCandidates
  ) {
    registerCausalRoutes(app, {
      causalService: deps.causalService,
      questions: deps.causalQuestions,
      promotedClaims: deps.promotedCausalClaims,
      calibrationCandidates: deps.causalCalibrationCandidates,
    });
  }

  if (
    deps.decisionPolicyService &&
    deps.decisionContexts &&
    deps.decisionPolicies &&
    deps.decisionRecommendations
  ) {
    registerDecisionPolicyRoutes(app, {
      decisionPolicyService: deps.decisionPolicyService,
      decisionContexts: deps.decisionContexts,
      decisionPolicies: deps.decisionPolicies,
      decisionRecommendations: deps.decisionRecommendations,
    });
  }

  return app;
}

import { createOrchestratorRuntime } from "../runtime/process.js";

async function main(): Promise<void> {
  const runtime = createOrchestratorRuntime();
  await runtime.start();
  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("server.ts") ||
    process.argv[1].endsWith("server.js"));

if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
