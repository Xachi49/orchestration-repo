import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlPlaneService } from "../../control-plane/service.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
} from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_GRANTS } from "../../admission/fixtures.js";
import { ObjectiveAdmissionService } from "../../admission/service.js";
import { NoopObservability } from "../../observability/index.js";
import { RepositoryTruthService } from "../../ingestion/service.js";
import { DeterministicProjectIndexer } from "../../ingestion/indexer.js";
import { DeterministicRepositoryFingerprintService } from "../../ingestion/fingerprint.js";
import {
  EXAMPLE_COMMIT_METADATA,
  EXAMPLE_COMMIT_SHA,
  EXAMPLE_DRIFT_SHA,
  EXAMPLE_REPOSITORY_SOURCE,
  EXAMPLE_WORKSPACE_FILES,
} from "../../ingestion/fixtures.js";
import { FakeRemoteRepository } from "../ingestion/fake-remote.js";
import { FakeRepositoryWorkspace } from "../ingestion/fake-workspace.js";
import {
  PlanningReadinessService,
  PlanningService,
} from "../../planning/index.js";
import {
  FakeValidationModel,
  PlanningModelRevisionAdapter,
  ValidationReadinessService,
  ValidationService,
} from "../../validation/index.js";
import {
  AuthorizationReadinessService,
  AuthorizationRoutingService,
  ApprovalExpiryService,
  FakeApprovalDeliveryService,
  HumanAuthorizationService,
  SequenceDecisionNonceGenerator,
} from "../../authorization/index.js";
import {
  ApprovalDeliveryOutboxConsumer,
  createApprovalDeliveryDispatcher,
} from "../../authorization/outbox-consumer.js";
import {
  ExecutionReadinessService,
  ExecutionService,
  TestProfileRegistry,
} from "../../execution/index.js";
import { FakeSafeActuator } from "../execution/actuators.js";
import { createExecutionFriendlyPlanningModel } from "../../execution/friendly-planning-model.js";
import { createExperimentAwarePlanningModel } from "../../experiments/planning-proposal.js";
import {
  FakeVerificationModel,
  OutcomeVerificationService,
  VerificationReadinessService,
} from "../../verification/index.js";
import {
  FakeLearningModel,
  GovernedMemoryService,
} from "../../memory/index.js";
import {
  ObservabilityService,
  SLORegistry,
} from "../../observability/index.js";
import {
  UuidAuthorizationIdentityGenerator,
  UuidExecutionIdentityGenerator,
  UuidMemoryIdentityGenerator,
  UuidObservabilityIdentityGenerator,
  UuidPlanIdentityGenerator,
  UuidValidationIdentityGenerator,
  UuidVerificationIdentityGenerator,
} from "./identity-generators.js";
import {
  Aes256GcmDeliverySecretProtector,
  loadDeliverySecretKeyFromEnv,
} from "./delivery-secret-protector.js";
import {
  PostgresAuthorityDirectory,
  PostgresApproverAuthorizationService,
  PostgresRequesterAuthorization,
  buildAuthoritySeeds,
} from "./repositories/authority-directory.js";
import { PostgresApprovalDeliverySecretStore } from "./repositories/delivery-secrets.js";
import { UuidAdmissionIdentityGenerator } from "../admission/identity.js";
import { FixedClock, SystemClock, type ClockPort } from "../clock.js";
import type { PostgresDatabase } from "./database.js";
import { PostgresLeaseStore } from "./leases.js";
import { PostgresTransactionManager } from "./transaction.js";
import { PostgresArtifactBlobStore } from "./artifacts.js";
import { PostgresTransactionalOutbox } from "./outbox.js";
import { PostgresInbox } from "./inbox.js";
import { DurableRecoveryService } from "./recovery.js";
import {
  PostgresProjectRegistry,
  PostgresCapabilityRegistry,
  PostgresPolicyRegistry,
  PostgresResourceBudgetRegistry,
} from "./repositories/control-plane.js";
import {
  PostgresRunRepository,
  PostgresEventStore,
  PostgresIdempotencyStore,
  PostgresObjectiveRepository,
  PostgresProjectLockService,
} from "./repositories/admission.js";
import {
  PostgresPlanRepository,
  PostgresPlanningUsageLedger,
  PostgresValidationUsageLedger,
  PostgresValidationDecisionRepository,
  PostgresApprovalRequestRepository,
  PostgresAuthorizationRecordRepository,
  PostgresModificationRequestRepository,
  PostgresDecisionCardStore,
  PostgresExecutionAttemptRepository,
  PostgresStepExecutionRepository,
  PostgresExecutionArtifactRepository,
  PostgresOutcomeVerificationRepository,
  PostgresCompletionRecordRepository,
  PostgresVerificationEvidenceRepository,
  PostgresVerificationInferenceLedger,
  PostgresHistoricalRunRepository,
  PostgresLearningCandidateRepository,
  PostgresPromotedPrecedentRepository,
  PostgresPrecedentPromotionDecisionRepository,
  PostgresLearningLedgerRepository,
  PostgresPrecedentContradictionRepository,
  PostgresLearningInferenceLedger,
  PostgresRunTelemetryRepository,
  PostgresPhaseTelemetryRepository,
  PostgresSystemHealthSnapshotRepository,
  PostgresSLOEvaluationRepository,
  PostgresAnomalyFindingRepository,
  PostgresOptimizationCandidateRepository,
  PostgresObservabilityLedger,
  PostgresRepositorySourceRegistry,
  PostgresLockedRepositoryStore,
  PostgresEvidenceRegistry,
  PostgresVerifiedRepositoryContextStore,
  PostgresRepositoryIndexStore,
} from "./repositories/phase-stores.js";
import { PostgresExecutionAuthoritySnapshotStore } from "./repositories/snapshots.js";
import { PostgresExecutionResourceLedgerStore } from "./repositories/execution-resource-ledger.js";
import {
  PostgresRepositoryIngestionCoordinator,
  PostgresPlanningCoordinator,
  PostgresValidationCoordinator,
  PostgresAuthorizationCoordinator,
  PostgresExecutionCoordinator,
  PostgresVerificationCoordinator,
  PostgresLearningCoordinator,
} from "./coordinators.js";
import {
  PostgresSchedulerWorkItemRepository,
  PostgresSchedulerDependencyRepository,
  PostgresSchedulerDecisionRepository,
  PostgresSchedulerProjectConfigRepository,
  PostgresSchedulerPauseRepository,
  PostgresSchedulerFairnessRepository,
} from "./repositories/scheduler.js";
import {
  createPhaseDispatchPorts,
  DISCOVERABLE_RUN_STATES,
  PortfolioSchedulerService,
  SchedulerDispatcher,
  StackRunArtifactProbe,
  type PhaseDispatchPorts,
  type RunArtifactProbe,
} from "../../scheduling/index.js";
import {
  FakeProgramDecompositionModel,
  ProgramOrchestrationService,
  ProgramWorkMaterializer,
} from "../../programs/index.js";
import { ProgramProgressionLoop } from "../../programs/loops.js";
import {
  FakePortfolioStrategyModel,
  PortfolioOrchestrationService,
  PortfolioWorkMaterializer,
} from "../../portfolio/index.js";
import { PortfolioProgressionLoop } from "../../portfolio/loops.js";
import {
  PostgresProgramRepository,
  PostgresProgramPlanRepository,
  PostgresProgramBudgetLedgerRepository,
  PostgresProgramBudgetReservationRepository,
  PostgresProgramLineageRepository,
  PostgresProgramMaterializationApprovalRepository,
  PostgresProgramCompletionRepository,
} from "./repositories/programs.js";
import {
  PostgresPortfolioRepository,
  PostgresPortfolioPlanRepository,
  PostgresPortfolioBudgetLedgerRepository,
  PostgresPortfolioBudgetReservationRepository,
  PostgresPortfolioProgramLineageRepository,
  PostgresPortfolioAuthorizationRequestRepository,
  PostgresPortfolioAuthorizationRecordRepository,
  PostgresPortfolioCompletionRepository,
  PostgresPortfolioRebalanceRepository,
} from "./repositories/portfolios.js";
import {
  PostgresDecisionProblemRepository,
  PostgresScenarioSetRepository,
  PostgresSimulationResultRepository,
  PostgresDecisionPackageRepository,
  PostgresStrategySelectionRequestRepository,
  PostgresStrategySelectionRecordRepository,
  PostgresScenarioPortfolioLineageRepository,
  PostgresScenarioCalibrationRepository,
  PostgresSimulationUsageLedgerRepository,
} from "./repositories/scenarios.js";
import {
  FakeScenarioGenerationModel,
  Phase15PortfolioProposalAdmissionPort,
  ScenarioOrchestrationService,
  ScenarioProgressionLoop,
  ScenarioWorkMaterializer,
  FakeScenarioSimulationEngine,
} from "../../scenarios/index.js";
import {
  PostgresExperimentRepository,
  PostgresExperimentPlanRepository,
  PostgresExperimentAuthorizationRequestRepository,
  PostgresExperimentAuthorizationRecordRepository,
  PostgresExperimentResultRepository,
  PostgresExperimentEvidenceBundleRepository,
  PostgresAssumptionEvidenceUpdateCandidateRepository,
  PostgresExperimentCompletionRecordRepository,
  PostgresExperimentExecutionLineageRepository,
  PostgresExperimentUsageLedgerRepository,
} from "./repositories/experiments.js";
import {
  FakeExperimentDesignModel,
  ExperimentOrchestrationService,
  ExperimentProgressionLoop,
  ExperimentWorkMaterializer,
  Phase2ExperimentObjectiveAdmissionPort,
  Phase8ExperimentOutcomeVerificationPort,
} from "../../experiments/index.js";
import {
  PostgresCausalQuestionRepository,
  PostgresCausalGraphRepository,
  PostgresCausalEvidenceReferenceRepository,
  PostgresCausalIdentificationAnalysisRepository,
  PostgresCausalEstimateRepository,
  PostgresCausalEvidenceSynthesisRepository,
  PostgresCausalClaimCandidateRepository,
  PostgresCausalReviewRequestRepository,
  PostgresCausalReviewRecordRepository,
  PostgresPromotedCausalClaimRepository,
  PostgresDecisionModelCalibrationCandidateRepository,
  PostgresCausalEvidenceGapRepository,
  PostgresCausalUsageLedgerRepository,
} from "./repositories/causal.js";
import {
  FakeCausalGraphProposalModel,
  CausalOrchestrationService,
  CausalProgressionLoop,
  CausalWorkMaterializer,
  CausalGovernedMemoryAdapter,
  CausalEvidenceSynthesisSchema,
  type InMemoryAuthoritativeExperimentEvidencePort,
} from "../../causal/index.js";
import {
  PostgresAuthoritativeExperimentEvidencePort,
  composeTestAuthoritativeExperimentEvidencePort,
} from "./causal-authoritative-evidence.js";
import { CryptoDecisionNonceGenerator } from "../../authorization/decision-nonce.js";
import {
  PostgresDecisionContextRepository,
  PostgresDecisionPolicyCandidateRepository,
  PostgresDecisionPolicyEvaluationRepository,
  PostgresDecisionPolicyComparisonRepository,
  PostgresDecisionPolicyApprovalRequestRepository,
  PostgresDecisionPolicyApprovalRecordRepository,
  PostgresDecisionPolicyShadowRecordRepository,
  PostgresDecisionPolicyShadowEvaluationRepository,
  PostgresDecisionPolicyActivationRequestRepository,
  PostgresDecisionPolicyActivationRecordRepository,
  PostgresDecisionStateSnapshotRepository,
  PostgresDecisionRecommendationRepository,
  PostgresDecisionOverrideRecordRepository,
  PostgresDecisionPolicyPerformanceRecordRepository,
  PostgresDecisionPolicyRevisionCandidateRepository,
} from "./repositories/decision-policies.js";
import {
  DecisionPolicyOrchestrationService,
} from "../../decision-policies/service.js";
import { DecisionPolicyProgressionLoop } from "../../decision-policies/loops.js";
import { DecisionPolicyWorkMaterializer } from "../../decision-policies/work-materializer.js";
import { FakeDecisionPolicySynthesisModel } from "../../decision-policies/synthesis-model.js";
import {
  CausalGovernedMemoryEvidencePort,
  InMemoryDecisionRecommendationMaterializationLineageRepository,
  InMemoryDecisionStateSourcePort,
} from "../../decision-policies/index.js";
import {
  PostgresInstitutionRepository,
  PostgresOrganizationalUnitRepository,
  PostgresGovernanceMandateRepository,
  PostgresAuthorityDelegationRepository,
  PostgresDirectAuthorityGrantRepository,
  PostgresCanonicalAuthorityGrantAdapter,
  PostgresGovernanceCaseRepository,
  PostgresGovernanceAttestationRepository,
  PostgresInstitutionalAuthorizationProofRepository,
  PostgresAuthorityRevocationRepository,
  PostgresGovernanceHoldRepository,
  PostgresInstitutionalAuthoritySnapshotRepository,
  PostgresGovernanceAuditRepository,
} from "./repositories/governance.js";
import {
  PostgresConstitutionalProposalRepository,
  PostgresConstitutionalImpactAnalysisRepository,
  PostgresConstitutionalReviewDecisionRepository,
  PostgresConstitutionalActivationRecordRepository,
  PostgresConstitutionalAuditRepository,
} from "./repositories/constitutional.js";
import { GovernanceOrchestrationService } from "../../governance/index.js";
import { ConstitutionalChangeOrchestrationService } from "../../constitutional/index.js";

export interface PostgresOrchestratorStack {
  storageMode: "postgres";
  instanceId: string;
  db: PostgresDatabase;
  clock: ClockPort;
  transactions: PostgresTransactionManager;
  leases: PostgresLeaseStore;
  blobStore: PostgresArtifactBlobStore;
  outbox: PostgresTransactionalOutbox;
  inbox: PostgresInbox;
  recovery: DurableRecoveryService;
  controlPlane: ControlPlaneService;
  admission: ObjectiveAdmissionService;
  ingestion: RepositoryTruthService;
  planning: PlanningService;
  validation: ValidationService;
  authorizationRouting: AuthorizationRoutingService;
  humanAuthorization: HumanAuthorizationService;
  approvalExpiry: ApprovalExpiryService;
  authorizationReadiness: AuthorizationReadinessService;
  execution: ExecutionService;
  executionReadiness: ExecutionReadinessService;
  verification: OutcomeVerificationService;
  verificationReadiness: VerificationReadinessService;
  memory: GovernedMemoryService;
  observability: ObservabilityService;
  runs: PostgresRunRepository;
  objectives: PostgresObjectiveRepository;
  events: PostgresEventStore;
  resourceLedgerStore: PostgresExecutionResourceLedgerStore;
  approvalDeliveryDispatcher: ReturnType<typeof createApprovalDeliveryDispatcher>;
  approvalDelivery: FakeApprovalDeliveryService;
  actuator: FakeSafeActuator;
  deliverySecrets: PostgresApprovalDeliverySecretStore;
  authorityDirectory: PostgresAuthorityDirectory;
  stepExecutions: PostgresStepExecutionRepository;
  authorizationRecords: PostgresAuthorizationRecordRepository;
  approvalRequests: PostgresApprovalRequestRepository;
  scheduler: PortfolioSchedulerService;
  schedulerWorkItems: PostgresSchedulerWorkItemRepository;
  schedulerDependencies: PostgresSchedulerDependencyRepository;
  schedulerDecisions: PostgresSchedulerDecisionRepository;
  schedulerProjectConfigs: PostgresSchedulerProjectConfigRepository;
  schedulerPauses: PostgresSchedulerPauseRepository;
  schedulerFairness: PostgresSchedulerFairnessRepository;
  schedulerArtifacts: RunArtifactProbe;
  schedulerPorts: PhaseDispatchPorts;
  schedulerDispatcher: SchedulerDispatcher;
  programs: PostgresProgramRepository;
  programPlans: PostgresProgramPlanRepository;
  programLineage: import("../../programs/repositories.js").ProgramLineageRepository;
  programCompletions: import("../../programs/repositories.js").ProgramCompletionRepository;
  runCompletions: import("../../verification/completion-repository.js").CompletionRecordRepository;
  outcomeVerifications: import("../../verification/outcome-repository.js").OutcomeVerificationRepository;
  repositorySources: PostgresRepositorySourceRegistry;
  programService: ProgramOrchestrationService;
  programProgression: ProgramProgressionLoop;
  programWorkMaterializer: ProgramWorkMaterializer;
  portfolios: PostgresPortfolioRepository;
  portfolioPlans: PostgresPortfolioPlanRepository;
  portfolioService: PortfolioOrchestrationService;
  portfolioProgression: PortfolioProgressionLoop;
  portfolioWorkMaterializer: PortfolioWorkMaterializer;
  decisionProblems: PostgresDecisionProblemRepository;
  scenarioSets: PostgresScenarioSetRepository;
  decisionPackages: PostgresDecisionPackageRepository;
  scenarioCalibration: PostgresScenarioCalibrationRepository;
  scenarioService: ScenarioOrchestrationService;
  scenarioProgression: ScenarioProgressionLoop;
  scenarioWorkMaterializer: ScenarioWorkMaterializer;
  experiments: PostgresExperimentRepository;
  experimentPlans: PostgresExperimentPlanRepository;
  experimentEvidenceBundles: PostgresExperimentEvidenceBundleRepository;
  experimentService: ExperimentOrchestrationService;
  experimentProgression: ExperimentProgressionLoop;
  experimentWorkMaterializer: ExperimentWorkMaterializer;
  causalQuestions: PostgresCausalQuestionRepository;
  causalService: CausalOrchestrationService;
  causalProgression: CausalProgressionLoop;
  causalWorkMaterializer: CausalWorkMaterializer;
  promotedCausalClaims: PostgresPromotedCausalClaimRepository;
  causalCalibrationCandidates: PostgresDecisionModelCalibrationCandidateRepository;
  decisionContexts: PostgresDecisionContextRepository;
  decisionPolicies: PostgresDecisionPolicyCandidateRepository;
  decisionRecommendations: PostgresDecisionRecommendationRepository;
  decisionPolicyService: DecisionPolicyOrchestrationService;
  decisionPolicyProgression: DecisionPolicyProgressionLoop;
  decisionPolicyWorkMaterializer: DecisionPolicyWorkMaterializer;
  governanceService: GovernanceOrchestrationService;
  governanceInstitutions: PostgresInstitutionRepository;
  governanceMandates: PostgresGovernanceMandateRepository;
  governanceCases: PostgresGovernanceCaseRepository;
  governanceProofs: PostgresInstitutionalAuthorizationProofRepository;
  governanceHolds: PostgresGovernanceHoldRepository;
  constitutionalService: ConstitutionalChangeOrchestrationService;
  constitutionalProposals: PostgresConstitutionalProposalRepository;
  /** Runs whose durable state can still yield missing scheduler work. */
  listDiscoverableRunIds: (
    limit: number,
    projectIds?: readonly string[],
  ) => Promise<readonly string[]>;
  dataRoot: string;
  close: () => Promise<void>;
}

export async function createPostgresOrchestratorStack(options: {
  db: PostgresDatabase;
  instanceId?: string;
  clock?: ClockPort;
  seedControlPlane?: boolean;
  dataRoot?: string;
  completionFailpoint?: import("../../verification/service.js").VerificationCompletionFailpoint;
  programCompletionFailpoint?: import("../../programs/service.js").ProgramCompletionFailpoint;
  programMaterializationFailpoint?: import("../../programs/service.js").ProgramMaterializationFailpoint;
  portfolioCompletionFailpoint?: import("../../portfolio/service.js").PortfolioCompletionFailpoint;
  portfolioMaterializationFailpoint?: import("../../portfolio/service.js").PortfolioMaterializationFailpoint;
  portfolioStrategyModel?: import("../../portfolio/strategy-model.js").PortfolioStrategyModel;
  scenarioSimulationFailpoint?: import("../../scenarios/service.js").ScenarioSimulationFailpoint;
  scenarioGenerationModel?: import("../../scenarios/generation-model.js").ScenarioGenerationModel;
  promotionFailpoint?: import("../../memory/promotion.js").PromotionFailpoint;
  /** @internal TEST ONLY — constitutional activation failpoint seam. */
  constitutionalActivationFailpoint?: {
    name: string;
    trigger: () => void;
  };
  schedulerGlobalMaxConcurrency?: number;
  defaultEnvironment?: string;
  /**
   * @internal TEST ONLY — PostgreSQL integration tests may supply in-memory
   * authoritative evidence seeds. Bootstrap and production runtime must not set this.
   */
  testOnlyCausalEvidenceSeeds?: InMemoryAuthoritativeExperimentEvidencePort;
  /**
   * @internal TEST ONLY — Phase 19 decision-state resolution seeds.
   * Production must not set this; authoritative sources are resolved via ports.
   */
  testOnlyDecisionStateSources?: InMemoryDecisionStateSourcePort;
}): Promise<PostgresOrchestratorStack> {
  const instanceId = options.instanceId ?? options.db.instanceId;
  const clock = options.clock ?? new SystemClock();
  const dataRoot =
    options.dataRoot ?? mkdtempSync(path.join(tmpdir(), "orchestrator-pg-"));
  const db = options.db;
  const transactions = new PostgresTransactionManager(db);
  const leases = new PostgresLeaseStore(db);
  const blobStore = new PostgresArtifactBlobStore(db);
  const outbox = new PostgresTransactionalOutbox(db);
  const inbox = new PostgresInbox(db);
  const resourceLedgerStore = new PostgresExecutionResourceLedgerStore(db);
  const deliverySecretKey = loadDeliverySecretKeyFromEnv();
  const deliverySecretProtector = new Aes256GcmDeliverySecretProtector(
    deliverySecretKey,
  );
  const deliverySecrets = new PostgresApprovalDeliverySecretStore(
    db,
    deliverySecretProtector,
  );
  const authorityDirectory = new PostgresAuthorityDirectory(db);

  const projects = new PostgresProjectRegistry(db);
  const capabilities = new PostgresCapabilityRegistry(db);
  const policies = new PostgresPolicyRegistry(db, clock);
  const budgets = new PostgresResourceBudgetRegistry(db);
  if (options.seedControlPlane !== false) {
    await projects.seed([EXAMPLE_PROJECT]);
    await capabilities.seed(EXAMPLE_CAPABILITIES);
    await policies.seed([EXAMPLE_POLICY_BUNDLE]);
    await budgets.seed([EXAMPLE_BUDGET]);
    await authorityDirectory.seed(
      buildAuthoritySeeds({
        requesterGrants: EXAMPLE_REQUESTER_GRANTS,
        approverIds: [
          ...EXAMPLE_PROJECT.authorizedApproverIds,
          "approver_bootstrap",
        ],
        projectId: EXAMPLE_PROJECT.projectId,
        environments: EXAMPLE_PROJECT.allowedEnvironments,
      }),
    );
  }

  const requesterAuthorization = new PostgresRequesterAuthorization(
    authorityDirectory,
  );

  const controlPlane = new ControlPlaneService({
    projects,
    capabilities,
    policies,
    budgets,
    clock,
  });

  /** Assigned after GovernanceOrchestrationService construction (Phase 20). */
  const institutionalGovernanceBridge: {
    current: import("../../governance/port.js").InstitutionalGovernancePort | null;
  } = { current: null };
  const institutionalGovernancePort: import("../../governance/port.js").InstitutionalGovernancePort =
    {
      resolveAuthority: (input) => {
        if (!institutionalGovernanceBridge.current) {
          throw new Error("Institutional governance not initialized");
        }
        return institutionalGovernanceBridge.current.resolveAuthority(input);
      },
      resolveApplicableMandates: (input) => {
        if (!institutionalGovernanceBridge.current) {
          return Promise.resolve({
            kind: "MANDATE_RESOLUTION_FAILED" as const,
            reason: "Institutional governance not initialized",
          });
        }
        return institutionalGovernanceBridge.current.resolveApplicableMandates(
          input,
        );
      },
      validateProof: (input) => {
        if (!institutionalGovernanceBridge.current) {
          throw new Error("Institutional governance not initialized");
        }
        return institutionalGovernanceBridge.current.validateProof(input);
      },
      assertNoActiveHold: async (input) => {
        if (!institutionalGovernanceBridge.current) return;
        await institutionalGovernanceBridge.current.assertNoActiveHold(input);
      },
    };

  const runs = new PostgresRunRepository(db);
  const events = new PostgresEventStore(db);
  const idempotency = new PostgresIdempotencyStore(db);
  const objectives = new PostgresObjectiveRepository(db);
  const admissionLocks = new PostgresProjectLockService(db);
  const admission = new ObjectiveAdmissionService({
    controlPlane,
    authorization: requesterAuthorization,
    idempotency,
    locks: admissionLocks,
    runs,
    events,
    identities: new UuidAdmissionIdentityGenerator(),
    clock,
    observability: new NoopObservability(),
    objectives,
    transactions,
  });

  const sources = new PostgresRepositorySourceRegistry(db);
  await sources.seed([EXAMPLE_REPOSITORY_SOURCE]);
  const remote = new FakeRemoteRepository({
    identity: {
      provider: "GITHUB",
      owner: EXAMPLE_REPOSITORY_SOURCE.owner,
      repository: EXAMPLE_REPOSITORY_SOURCE.repository,
    },
    defaultBranch: EXAMPLE_REPOSITORY_SOURCE.defaultBranch,
    branches: {
      [EXAMPLE_REPOSITORY_SOURCE.defaultBranch]: EXAMPLE_COMMIT_SHA,
    },
    commits: {
      [EXAMPLE_COMMIT_SHA]: EXAMPLE_COMMIT_METADATA,
      [EXAMPLE_DRIFT_SHA]: {
        ...EXAMPLE_COMMIT_METADATA,
        sha: EXAMPLE_DRIFT_SHA,
        message: "later commit",
      },
    },
  });
  const filesBySha = new Map([
    [EXAMPLE_COMMIT_SHA, EXAMPLE_WORKSPACE_FILES],
    [EXAMPLE_DRIFT_SHA, EXAMPLE_WORKSPACE_FILES],
  ]);
  const workspace = new FakeRepositoryWorkspace({ filesBySha });
  const lockedRepos = new PostgresLockedRepositoryStore(db);
  const evidence = new PostgresEvidenceRegistry(db);
  const contexts = new PostgresVerifiedRepositoryContextStore(db);
  const indexStore = new PostgresRepositoryIndexStore(db);
  const ingestionCoordinator = new PostgresRepositoryIngestionCoordinator(
    db,
    leases,
    instanceId,
  );
  const ingestion = new RepositoryTruthService({
    runs,
    controlPlane,
    sources,
    remote,
    locks: lockedRepos,
    workspace,
    indexer: new DeterministicProjectIndexer(),
    fingerprints: new DeterministicRepositoryFingerprintService(),
    indexStore,
    evidence,
    contexts,
    coordinator: ingestionCoordinator,
    clock,
  });

  const experiments = new PostgresExperimentRepository(db);
  const experimentPlans = new PostgresExperimentPlanRepository(db);
  const experimentLineage =
    new PostgresExperimentExecutionLineageRepository(db);

  const planningCoordinator = new PostgresPlanningCoordinator(
    db,
    leases,
    instanceId,
  );
  const plans = new PostgresPlanRepository(db);
  const planningUsage = new PostgresPlanningUsageLedger(db);
  const planningModel = createExperimentAwarePlanningModel(
    createExecutionFriendlyPlanningModel(),
    {
      lineage: experimentLineage,
      plans: experimentPlans,
      experiments,
    },
  );
  const planningReadiness = new PlanningReadinessService({
    runs,
    contexts,
    locks: lockedRepos,
    objectives,
    controlPlane,
  });
  const planning = new PlanningService({
    readiness: planningReadiness,
    coordinator: planningCoordinator,
    runs,
    objectives,
    controlPlane,
    contexts,
    locks: lockedRepos,
    evidence,
    workspace,
    model: planningModel,
    usage: planningUsage,
    plans,
    capabilities,
    identities: new UuidPlanIdentityGenerator(),
    clock,
  });

  const validationCoordinator = new PostgresValidationCoordinator(
    db,
    leases,
    instanceId,
  );
  const validationDecisions = new PostgresValidationDecisionRepository(db);
  const validationUsage = new PostgresValidationUsageLedger(db);
  const validationModel = new FakeValidationModel();
  const validationReadiness = new ValidationReadinessService({
    runs,
    plans,
    objectives,
    controlPlane,
  });
  const validation = new ValidationService({
    readiness: validationReadiness,
    coordinator: validationCoordinator,
    runs,
    objectives,
    controlPlane,
    contexts,
    locks: lockedRepos,
    evidence,
    workspace,
    plans,
    capabilities,
    decisions: validationDecisions,
    model: validationModel,
    usage: validationUsage,
    revisionModel: new PlanningModelRevisionAdapter(planningModel),
    planIdentities: new UuidPlanIdentityGenerator(),
    identities: new UuidValidationIdentityGenerator(),
    clock,
  });

  const approvalRequests = new PostgresApprovalRequestRepository(db);
  const authorizationRecords = new PostgresAuthorizationRecordRepository(db);
  const modificationRequests = new PostgresModificationRequestRepository(db);
  const decisionCards = new PostgresDecisionCardStore(db);
  const authorizationCoordinator = new PostgresAuthorizationCoordinator(
    db,
    leases,
    instanceId,
    approvalRequests,
  );
  const approvalDelivery = new FakeApprovalDeliveryService();
  const authorizationIdentities = new UuidAuthorizationIdentityGenerator();
  const approvalDeliveryConsumer = new ApprovalDeliveryOutboxConsumer({
    delivery: approvalDelivery,
    requests: approvalRequests,
    coordinator: authorizationCoordinator,
    runs,
    inbox,
    deliverySecrets,
    transactions,
    clockNowIso: () => clock.nowIso(),
  });
  const approvalDeliveryDispatcher = createApprovalDeliveryDispatcher({
    outbox,
    inbox,
    ownerId: instanceId,
    consumer: approvalDeliveryConsumer,
  });
  const approverAuthorization = new PostgresApproverAuthorizationService(
    controlPlane,
    authorityDirectory,
  );
  const authorizationReadiness = new AuthorizationReadinessService({
    runs,
    plans,
    objectives,
    controlPlane,
    decisions: validationDecisions,
    locks: lockedRepos,
  });
  const decisionNonceGenerator = new SequenceDecisionNonceGenerator();
  const authorizationRouting = new AuthorizationRoutingService({
    readiness: authorizationReadiness,
    runs,
    objectives,
    controlPlane,
    plans,
    decisions: validationDecisions,
    locks: lockedRepos,
    requests: approvalRequests,
    cards: decisionCards,
    coordinator: authorizationCoordinator,
    delivery: approvalDelivery,
    clock,
    identities: authorizationIdentities,
    nonceGenerator: decisionNonceGenerator,
    transactions,
    outbox,
    deliverySecrets,
    events,
    dispatchPendingDeliveries: () => approvalDeliveryDispatcher.dispatchOnce(),
  });
  const humanAuthorization = new HumanAuthorizationService({
    runs,
    objectives,
    controlPlane,
    plans,
    decisions: validationDecisions,
    locks: lockedRepos,
    requests: approvalRequests,
    records: authorizationRecords,
    modifications: modificationRequests,
    cards: decisionCards,
    coordinator: authorizationCoordinator,
    approvers: approverAuthorization,
    clock,
    identities: authorizationIdentities,
    transactions,
    delivery: approvalDelivery,
    nonceGenerator: decisionNonceGenerator,
    institutionalGovernance: institutionalGovernancePort,
  });
  const approvalExpiry = new ApprovalExpiryService({
    requests: approvalRequests,
    runs,
    coordinator: authorizationCoordinator,
    clock,
  });

  const stepExecutions = new PostgresStepExecutionRepository(db);
  const executionAttempts = new PostgresExecutionAttemptRepository(db);
  const executionArtifacts = new PostgresExecutionArtifactRepository(db);
  const executionCoordinator = new PostgresExecutionCoordinator(
    db,
    leases,
    instanceId,
  );
  const authoritySnapshots = new PostgresExecutionAuthoritySnapshotStore(db);
  const testProfiles = new TestProfileRegistry();
  const actuator = new FakeSafeActuator(testProfiles);
  const executionReadiness = new ExecutionReadinessService({
    runs,
    plans,
    objectives,
    controlPlane,
    locks: lockedRepos,
    authorizationRecords,
    approvalRequests,
    clockNowIso: () => clock.nowIso(),
  });
  const execution = new ExecutionService({
    runs,
    plans,
    objectives,
    controlPlane,
    locks: lockedRepos,
    authorizationRecords,
    approvalRequests,
    readiness: executionReadiness,
    coordinator: executionCoordinator,
    steps: stepExecutions,
    attempts: executionAttempts,
    artifacts: executionArtifacts,
    actuator,
    clock,
    dataRoot,
    events,
    identities: new UuidExecutionIdentityGenerator(),
    testProfiles,
    blobStore,
    transactions,
    authoritySnapshots,
    resourceLedgerStore,
  });

  const verificationCoordinator = new PostgresVerificationCoordinator(
    db,
    leases,
    instanceId,
  );
  const verificationEvidence = new PostgresVerificationEvidenceRepository(db);
  const outcomeVerifications = new PostgresOutcomeVerificationRepository(db);
  const completionRecords = new PostgresCompletionRecordRepository(db);
  const verificationInference = new PostgresVerificationInferenceLedger(db);
  const verificationReadiness = new VerificationReadinessService({
    runs,
    plans,
    objectives,
    authorizationRecords,
    execution,
    executionCoordinator,
    steps: stepExecutions,
    attempts: executionAttempts,
    artifacts: executionArtifacts,
  });
  const verification = new OutcomeVerificationService({
    runs,
    plans,
    objectives,
    authorizationRecords,
    execution,
    executionCoordinator,
    steps: stepExecutions,
    attempts: executionAttempts,
    artifacts: executionArtifacts,
    readiness: verificationReadiness,
    coordinator: verificationCoordinator,
    evidence: verificationEvidence,
    outcomes: outcomeVerifications,
    completions: completionRecords,
    model: new FakeVerificationModel(),
    inferenceLedger: verificationInference,
    clock,
    dataRoot,
    controlPlane,
    identities: new UuidVerificationIdentityGenerator(),
    blobStore,
    transactions,
    ...(options.completionFailpoint !== undefined
      ? { completionFailpoint: options.completionFailpoint }
      : {}),
  });

  const historicalRuns = new PostgresHistoricalRunRepository(db);
  const learningCandidates = new PostgresLearningCandidateRepository(db);
  const promotedPrecedents = new PostgresPromotedPrecedentRepository(db);
  const promotionDecisions = new PostgresPrecedentPromotionDecisionRepository(db);
  const learningLedger = new PostgresLearningLedgerRepository(db);
  const contradictions = new PostgresPrecedentContradictionRepository(db);
  const learningCoordinator = new PostgresLearningCoordinator(
    db,
    leases,
    instanceId,
  );
  const learningInference = new PostgresLearningInferenceLedger(db);
  const memory = new GovernedMemoryService({
    runs,
    objectives,
    plans,
    authorizationRecords,
    execution,
    outcomes: outcomeVerifications,
    completions: completionRecords,
    evidence: verificationEvidence,
    contexts,
    controlPlane,
    clock,
    coordinator: learningCoordinator,
    historicalRuns,
    candidates: learningCandidates,
    precedents: promotedPrecedents,
    decisions: promotionDecisions,
    ledger: learningLedger,
    contradictions,
    model: new FakeLearningModel(),
    inferenceLedger: learningInference,
    identities: new UuidMemoryIdentityGenerator(),
    transactions,
    ...(options.promotionFailpoint !== undefined
      ? { promotionFailpoint: options.promotionFailpoint }
      : {}),
  });
  planning.bindPrecedentRetriever(memory.getRetriever());

  const healthSnapshots = new PostgresSystemHealthSnapshotRepository(db);
  const observability = new ObservabilityService({
    sources: {
      runs,
      objectives,
      plans,
      planningUsage,
      planningCoordinator,
      validationDecisions,
      validationUsage,
      validationCoordinator,
      approvalRequests,
      authorizationRecords,
      executionAttempts,
      stepExecutions,
      executionCoordinator,
      outcomeVerifications,
      completionRecords,
      verificationCoordinator,
      verificationInference,
      ingestionCoordinator,
      historicalRuns,
      learningLedger,
      promotedPrecedents,
      precedentContradictions: contradictions,
      learningCandidates,
      learningInference,
    },
    clock,
    sloRegistry: new SLORegistry(),
    identities: new UuidObservabilityIdentityGenerator(),
    runTelemetry: new PostgresRunTelemetryRepository(db),
    phaseTelemetry: new PostgresPhaseTelemetryRepository(db),
    snapshots: healthSnapshots,
    sloEvaluations: new PostgresSLOEvaluationRepository(db),
    anomalies: new PostgresAnomalyFindingRepository(db),
    optimizationCandidates: new PostgresOptimizationCandidateRepository(db),
    ledger: new PostgresObservabilityLedger(db),
  });

  const recovery = new DurableRecoveryService(
    db,
    leases,
    stepExecutions,
    planningUsage,
    validationUsage,
    verificationInference,
  );

  const schedulerWorkItems = new PostgresSchedulerWorkItemRepository(db);
  const schedulerDependencies = new PostgresSchedulerDependencyRepository(db);
  const schedulerDecisions = new PostgresSchedulerDecisionRepository(db);
  const schedulerProjectConfigs = new PostgresSchedulerProjectConfigRepository(
    db,
  );
  const schedulerPauses = new PostgresSchedulerPauseRepository(db);
  const schedulerFairness = new PostgresSchedulerFairnessRepository(db);
  const schedulerArtifacts = new StackRunArtifactProbe({
    contexts,
    plans,
    validationDecisions,
    authorizationRecords,
    executionAttempts,
    completions: completionRecords,
    learningLedger,
    healthSnapshots,
  });
  const scheduler = new PortfolioSchedulerService({
    runs,
    workItems: schedulerWorkItems,
    dependencies: schedulerDependencies,
    decisions: schedulerDecisions,
    projectConfigs: schedulerProjectConfigs,
    pauses: schedulerPauses,
    fairness: schedulerFairness,
    artifacts: schedulerArtifacts,
    leases,
    nowIso: () => clock.nowIso(),
    globalMaxConcurrency: options.schedulerGlobalMaxConcurrency ?? 16,
    runtimeId: instanceId,
  });

  const programRepos = new PostgresProgramRepository(db);
  const programPlans = new PostgresProgramPlanRepository(db);
  const programBudgets = new PostgresProgramBudgetLedgerRepository(db);
  const programReservations = new PostgresProgramBudgetReservationRepository(db);
  const programLineage = new PostgresProgramLineageRepository(db);
  const programMaterializationApprovals =
    new PostgresProgramMaterializationApprovalRepository(db);
  const programCompletions = new PostgresProgramCompletionRepository(db);
  const materializationNonceStore = {
    map: new Map<string, string>(),
    async put(id: string, plaintext: string) {
      this.map.set(id, plaintext);
    },
    async take(id: string) {
      const v = this.map.get(id) ?? null;
      this.map.delete(id);
      return v;
    },
  };
  const programService = new ProgramOrchestrationService({
    nowIso: () => clock.nowIso(),
    programs: programRepos,
    plans: programPlans,
    budgets: programBudgets,
    reservations: programReservations,
    lineage: programLineage,
    materializationApprovals: programMaterializationApprovals,
    completions: programCompletions,
    controlPlane,
    decompositionModel: new FakeProgramDecompositionModel(),
    nonceGenerator: new CryptoDecisionNonceGenerator(),
    materializationNonceStore,
    isProgramMaterializer: (principalId, projectId) =>
      authorityDirectory.isProgramMaterializerEnabled(principalId, projectId),
    objectiveAdmission: admission,
    runs,
    runCompletions: completionRecords,
    outcomeVerifications,
    scheduler,
    transactions,
    authorizedRepositoryIdentities: async (projectId) => {
      const source = await sources.getByProjectId(projectId);
      if (!source || !source.enabled) {
        return [];
      }
      return [
        `${source.owner}/${source.repository}`,
        `github:${source.owner}/${source.repository}`,
        source.remoteUrl,
      ];
    },
    ...(options.programCompletionFailpoint !== undefined
      ? { completionFailpoint: options.programCompletionFailpoint }
      : {}),
    ...(options.programMaterializationFailpoint !== undefined
      ? { materializationFailpoint: options.programMaterializationFailpoint }
      : {}),
  });
  const programWorkMaterializer = new ProgramWorkMaterializer({
    nowIso: () => clock.nowIso(),
    programs: programRepos,
    plans: programPlans,
    materializationApprovals: programMaterializationApprovals,
    workItems: schedulerWorkItems,
    projectConfigs: schedulerProjectConfigs,
  });
  const programProgression = new ProgramProgressionLoop({
    programs: programRepos,
    materializer: programWorkMaterializer,
    databaseReachable: () => db.ping(),
  });

  const portfolioRepos = new PostgresPortfolioRepository(db);
  const portfolioPlans = new PostgresPortfolioPlanRepository(db);
  const portfolioBudgets = new PostgresPortfolioBudgetLedgerRepository(db);
  const portfolioReservations =
    new PostgresPortfolioBudgetReservationRepository(db);
  const portfolioLineage = new PostgresPortfolioProgramLineageRepository(db);
  const portfolioAuthRequests =
    new PostgresPortfolioAuthorizationRequestRepository(db);
  const portfolioAuthRecords =
    new PostgresPortfolioAuthorizationRecordRepository(db);
  const portfolioCompletions = new PostgresPortfolioCompletionRepository(db);
  const portfolioRebalances = new PostgresPortfolioRebalanceRepository(db);
  const authorizationNonceStore = {
    map: new Map<string, string>(),
    async put(id: string, plaintext: string) {
      this.map.set(id, plaintext);
    },
    async take(id: string) {
      const v = this.map.get(id) ?? null;
      this.map.delete(id);
      return v;
    },
  };
  const portfolioService = new PortfolioOrchestrationService({
    nowIso: () => clock.nowIso(),
    portfolios: portfolioRepos,
    plans: portfolioPlans,
    budgets: portfolioBudgets,
    reservations: portfolioReservations,
    lineage: portfolioLineage,
    authRequests: portfolioAuthRequests,
    authRecords: portfolioAuthRecords,
    completions: portfolioCompletions,
    rebalances: portfolioRebalances,
    controlPlane,
    strategyModel:
      options.portfolioStrategyModel ?? new FakePortfolioStrategyModel(),
    nonceGenerator: new CryptoDecisionNonceGenerator(),
    authorizationNonceStore,
    isPortfolioAllocator: (principalId, projectIds) =>
      authorityDirectory.isPortfolioAllocatorForAllProjects(
        principalId,
        projectIds,
      ),
    programOrchestration: programService,
    programs: programRepos,
    programCompletions: programCompletions,
    transactions,
    authorizedRepositoryIdentities: async (projectId) => {
      const source = await sources.getByProjectId(projectId);
      if (!source || !source.enabled) {
        return [];
      }
      return [
        `${source.owner}/${source.repository}`,
        `github:${source.owner}/${source.repository}`,
        source.remoteUrl,
      ];
    },
    ...(options.portfolioCompletionFailpoint !== undefined
      ? { completionFailpoint: options.portfolioCompletionFailpoint }
      : {}),
    ...(options.portfolioMaterializationFailpoint !== undefined
      ? { materializationFailpoint: options.portfolioMaterializationFailpoint }
      : {}),
    institutionalGovernance: institutionalGovernancePort,
  });
  const portfolioWorkMaterializer = new PortfolioWorkMaterializer({
    nowIso: () => clock.nowIso(),
    portfolios: portfolioRepos,
    plans: portfolioPlans,
    authorizationRecords: portfolioAuthRecords,
    workItems: schedulerWorkItems,
    projectConfigs: schedulerProjectConfigs,
  });
  const portfolioProgression = new PortfolioProgressionLoop({
    portfolios: portfolioRepos,
    materializer: portfolioWorkMaterializer,
    databaseReachable: () => db.ping(),
  });

  const decisionProblems = new PostgresDecisionProblemRepository(db);
  const scenarioSets = new PostgresScenarioSetRepository(db);
  const simulationResults = new PostgresSimulationResultRepository(db);
  const decisionPackages = new PostgresDecisionPackageRepository(db);
  const selectionRequests = new PostgresStrategySelectionRequestRepository(db);
  const selectionRecords = new PostgresStrategySelectionRecordRepository(db);
  const scenarioLineage = new PostgresScenarioPortfolioLineageRepository(db);
  const scenarioCalibration = new PostgresScenarioCalibrationRepository(db);
  const simulationUsage = new PostgresSimulationUsageLedgerRepository(db);
  const selectionNonceStore = {
    map: new Map<string, string>(),
    async put(id: string, plaintext: string) {
      this.map.set(id, plaintext);
    },
    async take(id: string) {
      const v = this.map.get(id) ?? null;
      this.map.delete(id);
      return v;
    },
  };
  const scenarioService = new ScenarioOrchestrationService({
    nowIso: () => clock.nowIso(),
    decisionProblems,
    scenarioSets,
    simulationResults,
    decisionPackages,
    selectionRequests,
    selectionRecords,
    lineage: scenarioLineage,
    usageLedger: simulationUsage,
    controlPlane,
    generationModel:
      options.scenarioGenerationModel ?? new FakeScenarioGenerationModel(),
    simulationEngine: new FakeScenarioSimulationEngine(),
    nonceGenerator: new CryptoDecisionNonceGenerator(),
    selectionNonceStore,
    isStrategySelector: (principalId, projectIds) =>
      authorityDirectory.isStrategySelectorForAllProjects(
        principalId,
        projectIds,
      ),
    portfolioAdmissionPort: new Phase15PortfolioProposalAdmissionPort(
      portfolioService,
    ),
    portfolioService,
    transactions,
    ...(options.scenarioSimulationFailpoint !== undefined
      ? { simulationFailpoint: options.scenarioSimulationFailpoint }
      : {}),
  });
  const scenarioWorkMaterializer = new ScenarioWorkMaterializer({
    nowIso: () => clock.nowIso(),
    decisionProblems,
    scenarioSets,
    decisionPackages,
    workItems: schedulerWorkItems,
    projectConfigs: schedulerProjectConfigs,
  });
  const scenarioProgression = new ScenarioProgressionLoop({
    decisionProblems,
    materializer: scenarioWorkMaterializer,
    databaseReachable: () => db.ping(),
  });

  const experimentAuthRequests =
    new PostgresExperimentAuthorizationRequestRepository(db);
  const experimentAuthRecords =
    new PostgresExperimentAuthorizationRecordRepository(db);
  const experimentResults = new PostgresExperimentResultRepository(db);
  const experimentEvidenceBundles =
    new PostgresExperimentEvidenceBundleRepository(db);
  const assumptionUpdateCandidates =
    new PostgresAssumptionEvidenceUpdateCandidateRepository(db);
  const experimentCompletions =
    new PostgresExperimentCompletionRecordRepository(db);
  const experimentUsage = new PostgresExperimentUsageLedgerRepository(db);
  const experimentAuthNonceStore = {
    map: new Map<string, string>(),
    async put(id: string, plaintext: string) {
      this.map.set(id, plaintext);
    },
    async take(id: string) {
      const v = this.map.get(id) ?? null;
      this.map.delete(id);
      return v;
    },
  };
  const experimentService = new ExperimentOrchestrationService({
    nowIso: () => clock.nowIso(),
    experiments,
    plans: experimentPlans,
    authRequests: experimentAuthRequests,
    authRecords: experimentAuthRecords,
    results: experimentResults,
    evidenceBundles: experimentEvidenceBundles,
    updateCandidates: assumptionUpdateCandidates,
    completions: experimentCompletions,
    lineage: experimentLineage,
    usageLedger: experimentUsage,
    controlPlane,
    designModel: new FakeExperimentDesignModel(),
    nonceGenerator: new CryptoDecisionNonceGenerator(),
    authNonceStore: experimentAuthNonceStore,
    isExperimentSponsor: (principalId, projectIds) =>
      authorityDirectory.isExperimentSponsorForAllProjects(
        principalId,
        projectIds,
      ),
    institutionalGovernance: institutionalGovernancePort,
    objectiveAdmissionPort: new Phase2ExperimentObjectiveAdmissionPort(
      admission,
    ),
    outcomeVerificationPort: new Phase8ExperimentOutcomeVerificationPort(
      outcomeVerifications,
    ),
    resolveRunProjectId: async (runId) => {
      const run = await runs.getById(runId);
      return run?.projectId ?? null;
    },
    transactions,
  });
  const experimentWorkMaterializer = new ExperimentWorkMaterializer({
    nowIso: () => clock.nowIso(),
    experiments,
    plans: experimentPlans,
    workItems: schedulerWorkItems,
    projectConfigs: schedulerProjectConfigs,
  });
  const experimentProgression = new ExperimentProgressionLoop({
    experiments,
    materializer: experimentWorkMaterializer,
    databaseReachable: () => db.ping(),
  });

  const causalQuestions = new PostgresCausalQuestionRepository(db);
  const causalGraphs = new PostgresCausalGraphRepository(db);
  const causalEvidenceRefs = new PostgresCausalEvidenceReferenceRepository(db);
  const causalIdentifications =
    new PostgresCausalIdentificationAnalysisRepository(db);
  const causalEstimates = new PostgresCausalEstimateRepository(db);
  const causalSyntheses = new PostgresCausalEvidenceSynthesisRepository(db);
  const causalClaims = new PostgresCausalClaimCandidateRepository(db);
  const causalReviewRequests = new PostgresCausalReviewRequestRepository(db);
  const causalReviewRecords = new PostgresCausalReviewRecordRepository(db);
  const promotedCausalClaims = new PostgresPromotedCausalClaimRepository(db);
  const causalCalibrationCandidates =
    new PostgresDecisionModelCalibrationCandidateRepository(db);
  const causalEvidenceGaps = new PostgresCausalEvidenceGapRepository(db);
  const causalUsage = new PostgresCausalUsageLedgerRepository(db);
  const postgresAuthoritativeExperimentEvidence =
    new PostgresAuthoritativeExperimentEvidencePort({
      experiments,
      experimentPlans,
      experimentEvidenceBundles,
      experimentLineage,
    });
  const authoritativeExperimentEvidence = options.testOnlyCausalEvidenceSeeds
    ? composeTestAuthoritativeExperimentEvidencePort(
        postgresAuthoritativeExperimentEvidence,
        options.testOnlyCausalEvidenceSeeds,
      )
    : postgresAuthoritativeExperimentEvidence;
  const causalService = new CausalOrchestrationService({
    nowIso: () => clock.nowIso(),
    questions: causalQuestions,
    graphs: causalGraphs,
    evidenceRefs: causalEvidenceRefs,
    identifications: causalIdentifications,
    estimates: causalEstimates,
    syntheses: causalSyntheses,
    claims: causalClaims,
    reviewRequests: causalReviewRequests,
    reviewRecords: causalReviewRecords,
    promotedClaims: promotedCausalClaims,
    calibrationCandidates: causalCalibrationCandidates,
    evidenceGaps: causalEvidenceGaps,
    usage: causalUsage,
    controlPlane,
    graphModel: new FakeCausalGraphProposalModel(),
    nonceGenerator: new CryptoDecisionNonceGenerator(),
    isCausalReviewer: (principalId, projectIds) =>
      authorityDirectory.isCausalReviewerForAllProjects(
        principalId,
        projectIds,
      ),
    authoritativeExperimentEvidence,
    transactions,
  });
  const causalWorkMaterializer = new CausalWorkMaterializer({
    nowIso: () => clock.nowIso(),
    questions: causalQuestions,
    graphs: causalGraphs,
    identifications: causalIdentifications,
    claims: causalClaims,
    workItems: schedulerWorkItems,
    projectConfigs: schedulerProjectConfigs,
  });
  const causalProgression = new CausalProgressionLoop({
    questions: causalQuestions,
    materializer: causalWorkMaterializer,
    databaseReachable: () => db.ping(),
  });

  const decisionContexts = new PostgresDecisionContextRepository(db);
  const decisionPolicies = new PostgresDecisionPolicyCandidateRepository(db);
  const decisionPolicyEvaluations = new PostgresDecisionPolicyEvaluationRepository(db);
  const decisionPolicyComparisons = new PostgresDecisionPolicyComparisonRepository(db);
  const decisionPolicyApprovalRequests =
    new PostgresDecisionPolicyApprovalRequestRepository(db);
  const decisionPolicyApprovalRecords =
    new PostgresDecisionPolicyApprovalRecordRepository(db);
  const decisionPolicyShadowRecords =
    new PostgresDecisionPolicyShadowRecordRepository(db);
  const decisionPolicyShadowEvaluations =
    new PostgresDecisionPolicyShadowEvaluationRepository(db);
  const decisionPolicyActivationRequests =
    new PostgresDecisionPolicyActivationRequestRepository(db);
  const decisionPolicyActivationRecords =
    new PostgresDecisionPolicyActivationRecordRepository(db);
  const decisionStateSnapshots = new PostgresDecisionStateSnapshotRepository(db);
  const decisionRecommendations = new PostgresDecisionRecommendationRepository(db);
  const decisionOverrides = new PostgresDecisionOverrideRecordRepository(db);
  const decisionPolicyPerformance =
    new PostgresDecisionPolicyPerformanceRecordRepository(db);
  const decisionPolicyRevisions =
    new PostgresDecisionPolicyRevisionCandidateRepository(db);
  const decisionStateSource =
    options.testOnlyDecisionStateSources ??
    new InMemoryDecisionStateSourcePort();
  const causalMemoryAdapter = new CausalGovernedMemoryAdapter({
    getPromoted: (id) => promotedCausalClaims.getById(id),
    getClaim: (id) => causalClaims.getById(id),
    getSynthesis: async (evidenceSynthesisId) => {
      const result = await db.query<{ payload: unknown }>(
        `SELECT payload FROM causal_evidence_syntheses
         WHERE evidence_synthesis_id = $1`,
        [evidenceSynthesisId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return CausalEvidenceSynthesisSchema.parse(row.payload);
    },
    resolveInterventionOutcome: async (claim) => {
      const question = await causalQuestions.getById(claim.causalQuestionId);
      return {
        intervention: question?.intervention ?? claim.interventionVariableId,
        outcome: question?.outcome ?? claim.outcomeVariableId,
      };
    },
  });
  const decisionCausalEvidence = new CausalGovernedMemoryEvidencePort({
    retrieve: (input) => causalMemoryAdapter.retrieveForPlanning(input),
    getReviewAndSourceHashes: async (promotedCausalClaimId) => {
      const promoted = await promotedCausalClaims.getById(promotedCausalClaimId);
      if (!promoted) return null;
      const claim = await causalClaims.getById(promoted.claimId);
      if (!claim) return null;
      return {
        reviewRecordId: promoted.reviewRecordId,
        sourceClaimHash: claim.claimHash,
      };
    },
  });
  const decisionMaterializationLineages =
    new InMemoryDecisionRecommendationMaterializationLineageRepository();
  const decisionPolicyService = new DecisionPolicyOrchestrationService({
    nowIso: () => clock.nowIso(),
    contexts: decisionContexts,
    policies: decisionPolicies,
    evaluations: decisionPolicyEvaluations,
    comparisons: decisionPolicyComparisons,
    approvalRequests: decisionPolicyApprovalRequests,
    approvalRecords: decisionPolicyApprovalRecords,
    shadowRecords: decisionPolicyShadowRecords,
    shadowEvaluations: decisionPolicyShadowEvaluations,
    activationRequests: decisionPolicyActivationRequests,
    activationRecords: decisionPolicyActivationRecords,
    snapshots: decisionStateSnapshots,
    recommendations: decisionRecommendations,
    overrides: decisionOverrides,
    performance: decisionPolicyPerformance,
    revisions: decisionPolicyRevisions,
    controlPlane,
    synthesisModel: new FakeDecisionPolicySynthesisModel(),
    nonceGenerator: new CryptoDecisionNonceGenerator(),
    isDecisionPolicyApprover: (principalId, projectIds) =>
      authorityDirectory.isDecisionPolicyApproverForAllProjects(
        principalId,
        projectIds,
      ),
    isDecisionPolicyActivator: (principalId, projectIds) =>
      authorityDirectory.isDecisionPolicyActivatorForAllProjects(
        principalId,
        projectIds,
      ),
    decisionStateSource,
    causalEvidence: decisionCausalEvidence,
    compilerDeps: { allowMaterialization: false },
    materializationLineages: decisionMaterializationLineages,
    institutionalGovernance: institutionalGovernancePort,
  });
  const decisionPolicyWorkMaterializer = new DecisionPolicyWorkMaterializer({
    nowIso: () => clock.nowIso(),
    policies: decisionPolicies,
    workItems: schedulerWorkItems,
    projectConfigs: schedulerProjectConfigs,
  });
  const decisionPolicyProgression = new DecisionPolicyProgressionLoop({
    policies: decisionPolicies,
    materializer: decisionPolicyWorkMaterializer,
    databaseReachable: () => db.ping(),
  });

  const governanceInstitutions = new PostgresInstitutionRepository(db);
  const governanceUnits = new PostgresOrganizationalUnitRepository(db);
  const governanceMandates = new PostgresGovernanceMandateRepository(db);
  const governanceDelegations = new PostgresAuthorityDelegationRepository(db);
  const governanceDirectGrants = new PostgresDirectAuthorityGrantRepository(db);
  const governanceCanonicalAuthority =
    new PostgresCanonicalAuthorityGrantAdapter(db);
  const governanceCases = new PostgresGovernanceCaseRepository(db);
  const governanceAttestations = new PostgresGovernanceAttestationRepository(db);
  const governanceProofs =
    new PostgresInstitutionalAuthorizationProofRepository(db);
  const governanceRevocations = new PostgresAuthorityRevocationRepository(db);
  const governanceHolds = new PostgresGovernanceHoldRepository(db);
  const governanceSnapshots =
    new PostgresInstitutionalAuthoritySnapshotRepository(db);
  const governanceAudits = new PostgresGovernanceAuditRepository(db);
  const governanceService = new GovernanceOrchestrationService({
    nowIso: () => clock.nowIso(),
    institutions: governanceInstitutions,
    units: governanceUnits,
    mandates: governanceMandates,
    delegations: governanceDelegations,
    canonicalAuthority: governanceCanonicalAuthority,
    directGrants: governanceDirectGrants,
    cases: governanceCases,
    attestations: governanceAttestations,
    proofs: governanceProofs,
    revocations: governanceRevocations,
    holds: governanceHolds,
    snapshots: governanceSnapshots,
    audits: governanceAudits,
    isGovernanceAdmin: (principalId, _institutionId, projectIds) =>
      authorityDirectory.isGovernanceAdminForAllProjects(
        principalId,
        projectIds,
      ),
    isGovernanceHoldOperator: (principalId, projectIds) =>
      authorityDirectory.isGovernanceHoldOperatorForAllProjects(
        principalId,
        projectIds,
      ),
  });
  institutionalGovernanceBridge.current = governanceService;

  const constitutionalProposals = new PostgresConstitutionalProposalRepository(db);
  const constitutionalImpactAnalyses =
    new PostgresConstitutionalImpactAnalysisRepository(db);
  const constitutionalReviewDecisions =
    new PostgresConstitutionalReviewDecisionRepository(db);
  const constitutionalActivationRecords =
    new PostgresConstitutionalActivationRecordRepository(db);
  const constitutionalAudits = new PostgresConstitutionalAuditRepository(db);
  const constitutionalService = new ConstitutionalChangeOrchestrationService({
    nowIso: () => clock.nowIso(),
    proposals: constitutionalProposals,
    impactAnalyses: constitutionalImpactAnalyses,
    reviewDecisions: constitutionalReviewDecisions,
    activationRecords: constitutionalActivationRecords,
    audits: constitutionalAudits,
    governance: governanceService,
    canonicalAuthority: governanceCanonicalAuthority,
    isGovernanceAdmin: (principalId, _institutionId, projectIds) =>
      authorityDirectory.isGovernanceAdminForAllProjects(
        principalId,
        projectIds,
      ),
    runInstitutionActivation: (institutionId, fn) =>
      db.withTransaction(async () => {
        await db.query(
          `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
          [`constitutional-activation:${institutionId}`],
        );
        await db.query(
          `SELECT institution_id FROM institutions WHERE institution_id = $1 FOR UPDATE`,
          [institutionId],
        );
        return fn();
      }),
    withTransaction: (fn) => transactions.withTransaction(fn),
    ...(options.constitutionalActivationFailpoint !== undefined
      ? { activationFailpoint: options.constitutionalActivationFailpoint }
      : {}),
  });

  const schedulerPorts = createPhaseDispatchPorts({
    runs,
    artifacts: schedulerArtifacts,
    ingestion,
    planning,
    validation,
    authorizationRouting,
    execution,
    verification,
    memory,
    observability,
    planningReadiness,
    validationReadiness,
    authorizationReadiness,
    executionReadiness,
    verificationReadiness,
    defaultEnvironment:
      options.defaultEnvironment ??
      EXAMPLE_PROJECT.allowedEnvironments[0] ??
      "local",
    programs: programRepos,
    programService,
    portfolios: portfolioRepos,
    portfolioService,
    decisionProblems,
    scenarioService,
    experiments,
    experimentService,
    causalQuestions,
    causalService,
    decisionPolicies,
    decisionPolicyService,
  });
  const schedulerDispatcher = new SchedulerDispatcher(scheduler, schedulerPorts);

  return {
    storageMode: "postgres",
    instanceId,
    db,
    clock,
    transactions,
    leases,
    blobStore,
    outbox,
    inbox,
    recovery,
    controlPlane,
    admission,
    ingestion,
    planning,
    validation,
    authorizationRouting,
    humanAuthorization,
    approvalExpiry,
    authorizationReadiness,
    execution,
    executionReadiness,
    verification,
    verificationReadiness,
    memory,
    observability,
    runs,
    objectives,
    events,
    resourceLedgerStore,
    approvalDeliveryDispatcher,
    approvalDelivery,
    actuator,
    deliverySecrets,
    authorityDirectory,
    stepExecutions,
    authorizationRecords,
    approvalRequests,
    scheduler,
    schedulerWorkItems,
    schedulerDependencies,
    schedulerDecisions,
    schedulerProjectConfigs,
    schedulerPauses,
    schedulerFairness,
    schedulerArtifacts,
    schedulerPorts,
    schedulerDispatcher,
    programs: programRepos,
    programPlans,
    programLineage,
    programCompletions,
    runCompletions: completionRecords,
    outcomeVerifications,
    repositorySources: sources,
    programService,
    programProgression,
    programWorkMaterializer,
    portfolios: portfolioRepos,
    portfolioPlans,
    portfolioService,
    portfolioProgression,
    portfolioWorkMaterializer,
    decisionProblems,
    scenarioSets,
    decisionPackages,
    scenarioCalibration,
    scenarioService,
    scenarioProgression,
    scenarioWorkMaterializer,
    experiments,
    experimentPlans,
    experimentEvidenceBundles,
    experimentService,
    experimentProgression,
    experimentWorkMaterializer,
    causalQuestions,
    causalService,
    causalProgression,
    causalWorkMaterializer,
    promotedCausalClaims,
    causalCalibrationCandidates,
    decisionContexts,
    decisionPolicies,
    decisionRecommendations,
    decisionPolicyService,
    decisionPolicyProgression,
    decisionPolicyWorkMaterializer,
    governanceService,
    governanceInstitutions,
    governanceMandates,
    governanceCases,
    governanceProofs,
    governanceHolds,
    constitutionalService,
    constitutionalProposals,
    listDiscoverableRunIds: (limit: number, projectIds?: readonly string[]) =>
      runs.listActionableDiscoverableRunIds(
        DISCOVERABLE_RUN_STATES,
        limit,
        projectIds,
      ),
    dataRoot,
    close: async () => {
      await db.close();
    },
  };
}

export function createFixedClockPostgresStack(
  db: PostgresDatabase,
  clockIso = "2026-08-14T12:00:00.000Z",
): Promise<PostgresOrchestratorStack> {
  return createPostgresOrchestratorStack({
    db,
    clock: new FixedClock(clockIso),
  });
}
