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
  promotionFailpoint?: import("../../memory/promotion.js").PromotionFailpoint;
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

  const planningCoordinator = new PostgresPlanningCoordinator(
    db,
    leases,
    instanceId,
  );
  const plans = new PostgresPlanRepository(db);
  const planningUsage = new PostgresPlanningUsageLedger(db);
  const planningModel = createExecutionFriendlyPlanningModel();
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
    nonceGenerator: new SequenceDecisionNonceGenerator(),
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
    snapshots: new PostgresSystemHealthSnapshotRepository(db),
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
