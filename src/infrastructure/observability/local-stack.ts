import {
  createLocalMemoryStack,
  type LocalMemoryStack,
} from "../memory/local-stack.js";
import {
  ObservabilityService,
  SLORegistry,
  SequenceObservabilityIdentityGenerator,
  InMemoryRunTelemetryRepository,
  InMemoryPhaseTelemetryRepository,
  InMemorySystemHealthSnapshotRepository,
  InMemorySLOEvaluationRepository,
  InMemoryAnomalyFindingRepository,
  InMemoryOptimizationCandidateRepository,
  InMemoryObservabilityLedger,
  type TelemetrySources,
} from "../../observability/index.js";

export interface LocalObservabilityStack extends LocalMemoryStack {
  observability: ObservabilityService;
  telemetrySources: TelemetrySources;
  sloRegistry: SLORegistry;
  observabilityIdentities: SequenceObservabilityIdentityGenerator;
}

export function createLocalObservabilityStack(
  options?: Parameters<typeof createLocalMemoryStack>[0],
): LocalObservabilityStack {
  const base = createLocalMemoryStack(options);

  const telemetrySources: TelemetrySources = {
    runs: base.runs,
    objectives: base.objectives,
    plans: base.plans,
    planningUsage: base.usage,
    planningCoordinator: base.planningCoordinator,
    validationDecisions: base.validationDecisions,
    validationUsage: base.validationUsage,
    validationCoordinator: base.validationCoordinator,
    approvalRequests: base.approvalRequests,
    authorizationRecords: base.authorizationRecords,
    executionAttempts: base.executionAttempts,
    stepExecutions: base.stepExecutions,
    executionCoordinator: base.executionCoordinator,
    outcomeVerifications: base.outcomeVerifications,
    completionRecords: base.completionRecords,
    verificationCoordinator: base.verificationCoordinator,
    verificationInference: base.verificationInference,
    ingestionCoordinator: base.coordinator,
    historicalRuns: base.historicalRuns,
    learningLedger: base.learningLedger,
    promotedPrecedents: base.promotedPrecedents,
    precedentContradictions: base.precedentContradictions,
    learningCandidates: base.learningCandidates,
    learningInference: base.learningInference,
  };

  const sloRegistry = new SLORegistry();
  const observabilityIdentities = new SequenceObservabilityIdentityGenerator();

  const observability = new ObservabilityService({
    sources: telemetrySources,
    clock: base.clock,
    sloRegistry,
    identities: observabilityIdentities,
    runTelemetry: new InMemoryRunTelemetryRepository(),
    phaseTelemetry: new InMemoryPhaseTelemetryRepository(),
    snapshots: new InMemorySystemHealthSnapshotRepository(),
    sloEvaluations: new InMemorySLOEvaluationRepository(),
    anomalies: new InMemoryAnomalyFindingRepository(),
    optimizationCandidates: new InMemoryOptimizationCandidateRepository(),
    ledger: new InMemoryObservabilityLedger(),
  });

  return {
    ...base,
    observability,
    telemetrySources,
    sloRegistry,
    observabilityIdentities,
  };
}
