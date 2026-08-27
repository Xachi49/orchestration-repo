export { SchedulingError, isSchedulingError, SCHEDULING_ERROR_CODES } from "./errors.js";
export type { SchedulingErrorCode } from "./errors.js";
export {
  SCHEDULER_WORK_KINDS,
  WORKER_CAPABILITY_LABELS,
  workKindToCapability,
  workerSupportsKind,
  EXPERIMENT_SCHEDULER_WORK_KINDS,
  isExperimentSchedulerWorkKind,
  type SchedulerWorkKind,
  type WorkerCapabilityLabel,
  type ExperimentSchedulerWorkKind,
} from "./work-kind.js";
export {
  PRIORITY_CLASSES,
  PRIORITY_RANK,
  parsePriorityClass,
  type PriorityClass,
} from "./priority.js";
export {
  WORK_ITEM_STATUSES,
  TERMINAL_WORK_STATUSES,
  isTerminalWorkStatus,
  SchedulerWorkItemSchema,
  parseSchedulerWorkItem,
  DEFAULT_WORK_MAX_ATTEMPTS,
  type WorkItemStatus,
  type TerminalWorkStatus,
  type SchedulerWorkItem,
} from "./work-item.js";
export {
  DEPENDENCY_MILESTONES,
  CrossRunDependencySchema,
  parseCrossRunDependency,
  detectDependencyCycle,
  type DependencyMilestone,
  type CrossRunDependency,
} from "./dependency.js";
export {
  candidateWorkKinds,
  bindingHashForWorkKind,
  DISCOVERABLE_RUN_STATES,
  type DiscoveryContext,
} from "./discovery-map.js";
export {
  candidateExperimentWorkKinds,
  experimentWorkBindingHash,
} from "./experiment-discovery-map.js";
export {
  candidateScenarioWorkKinds,
  scenarioWorkBindingHash,
} from "./scenario-discovery-map.js";
export {
  discoveryMaterializationKinds,
  isDiscoverableRunState,
} from "./discovery-actionable.js";
export {
  evaluateEligibility,
  type EligibilityInput,
  type EligibilityResult,
} from "./eligibility.js";
export {
  computeSchedulingScore,
  compareCandidates,
  SCHEDULING_REASON_CODES,
  type ScoreInputs,
  type SchedulingReasonCode,
} from "./score.js";
export {
  createFairnessState,
  applyFairnessCharge,
  getProjectDeficit,
  projectWeightClamp,
  nextFairnessRowsAfterService,
  fairnessSnapshot,
  parseProjectFairnessState,
  ProjectFairnessStateSchema,
  type FairnessState,
  type ProjectFairnessState,
} from "./fairness.js";
export {
  PortfolioSchedulerService,
  admitPriorityFromRequest,
  type RunArtifactProbe,
  type PortfolioSchedulerDeps,
  type SelectWorkOptions,
  type SelectAndClaimOptions,
  type MaterializeResult,
} from "./service.js";
export {
  SchedulerDispatcher,
  type PhaseDispatchPorts,
  type SchedulerWorkStateWriter,
  type WorkFailureInput,
} from "./dispatcher.js";
export {
  StackRunArtifactProbe,
  buildDiscoveryContext,
  buildRunBindingFingerprints,
  type RunArtifactProbeDeps,
  type RunBindingFingerprints,
} from "./artifact-probe.js";
export {
  createPhaseDispatchPorts,
  type PhaseDispatchPortsDeps,
  type PhaseDispatchServices,
  type PhaseReadinessProbe,
} from "./dispatch-ports.js";
export {
  SchedulerDiscoveryLoop,
  SchedulerClaimLoop,
  LeaseFencedWorkStateWriter,
  SCHEDULER_LEASE_PHASE,
  schedulerWorkCoordinationKey,
  type SchedulerLoopPorts,
  type SchedulerLeaseStorePort,
} from "./loops.js";
export {
  InMemorySchedulerWorkItemRepository,
  InMemorySchedulerDependencyRepository,
  InMemorySchedulerDecisionRepository,
  InMemorySchedulerProjectConfigRepository,
  InMemorySchedulerPauseRepository,
  InMemorySchedulerFairnessRepository,
  InMemorySchedulerLeaseStore,
} from "./memory-repositories.js";
export type {
  SchedulerWorkItemRepository,
  SchedulerDependencyRepository,
  SchedulerDecisionRepository,
  SchedulerProjectConfigRepository,
  SchedulerPauseRepository,
  SchedulerFairnessRepository,
  FairnessAllocationApi,
  SchedulableProjectSummary,
  PortfolioSnapshotPort,
} from "./repositories.js";
export {
  SchedulerDecisionRecordSchema,
  SchedulerProjectConfigSchema,
  SchedulerPauseRecordSchema,
  parseSchedulerDecisionRecord,
  parseSchedulerProjectConfig,
  parseSchedulerPauseRecord,
  type SchedulerDecisionRecord,
  type SchedulerProjectConfig,
  type SchedulerPauseRecord,
  type SchedulerPauseScope,
  type PortfolioSnapshot,
} from "./records.js";
export {
  workLogicalIdentityKey,
  workItemIdFromIdentity,
  hashSchedulingMetadata,
  hashDependencySet,
  emptyDependencySetHash,
} from "./identity.js";
