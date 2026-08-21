import type { CrossRunDependency } from "./dependency.js";
import type { ProjectFairnessState } from "./fairness.js";
import type {
  PortfolioSnapshot,
  SchedulerDecisionRecord,
  SchedulerPauseRecord,
  SchedulerProjectConfig,
} from "./records.js";
import type { SchedulerWorkItem, WorkItemStatus } from "./work-item.js";

/** Currently schedulable project contender (not a historical census). */
export interface SchedulableProjectSummary {
  projectId: string;
  /** Oldest ELIGIBLE work eligible_at for aging at project level. */
  oldestEligibleAt: string;
}

export interface SchedulerWorkItemRepository {
  getById(workItemId: string): Promise<SchedulerWorkItem | null>;
  getByLogicalIdentity(
    logicalIdentityKey: string,
  ): Promise<SchedulerWorkItem | null>;
  listByRun(runId: string): Promise<readonly SchedulerWorkItem[]>;
  listByProject(projectId: string): Promise<readonly SchedulerWorkItem[]>;
  listByStatus(
    statuses: readonly WorkItemStatus[],
    limit: number,
  ): Promise<readonly SchedulerWorkItem[]>;
  /**
   * Distinct projects with currently ELIGIBLE, due work.
   * Fairness contender set — not every project ever created.
   */
  listSchedulableProjectSummaries(
    nowIso: string,
  ): Promise<readonly SchedulableProjectSummary[]>;
  /**
   * Bounded work lookup inside one project (avoids noisy-project page monopoly).
   */
  listCandidateWorkByProject(
    projectId: string,
    statuses: readonly WorkItemStatus[],
    limit: number,
  ): Promise<readonly SchedulerWorkItem[]>;
  save(item: SchedulerWorkItem): Promise<SchedulerWorkItem>;
  updateCas(
    item: SchedulerWorkItem,
    expectedRevision: number,
  ): Promise<SchedulerWorkItem>;
  countActiveByProject(projectId: string): Promise<number>;
  countActiveGlobal(): Promise<number>;
  /**
   * CLAIMED rows without a live Phase 11 lease. RUNNING is excluded —
   * lost RUNNING leases use Phase 11/12 recovery, not blind requeue.
   */
  listExpiredClaimed(limit: number): Promise<readonly SchedulerWorkItem[]>;
}

export interface SchedulerDependencyRepository {
  getById(dependencyId: string): Promise<CrossRunDependency | null>;
  listByDependentRun(
    dependentRunId: string,
  ): Promise<readonly CrossRunDependency[]>;
  listByProject(projectId: string): Promise<readonly CrossRunDependency[]>;
  listAll(): Promise<readonly CrossRunDependency[]>;
  save(dependency: CrossRunDependency): Promise<CrossRunDependency>;
}

export interface SchedulerDecisionRepository {
  append(decision: SchedulerDecisionRecord): Promise<void>;
  listByWorkItem(
    workItemId: string,
    limit?: number,
  ): Promise<readonly SchedulerDecisionRecord[]>;
}

export interface SchedulerProjectConfigRepository {
  getByProjectId(projectId: string): Promise<SchedulerProjectConfig | null>;
  save(config: SchedulerProjectConfig): Promise<SchedulerProjectConfig>;
  list(): Promise<readonly SchedulerProjectConfig[]>;
}

export interface SchedulerPauseRepository {
  getGlobal(): Promise<SchedulerPauseRecord | null>;
  getProject(projectId: string): Promise<SchedulerPauseRecord | null>;
  save(pause: SchedulerPauseRecord): Promise<SchedulerPauseRecord>;
}

export interface FairnessAllocationApi {
  loadState(): Promise<readonly ProjectFairnessState[]>;
  applyCharge(input: {
    selectedProjectId: string;
    weights: ReadonlyMap<string, number>;
    servedAt: string;
    decisionId: string;
  }): Promise<{
    before: readonly ProjectFairnessState[];
    after: readonly ProjectFairnessState[];
  }>;
}

/**
 * Durable deficit-round-robin state. Process memory is not authority.
 *
 * Writers must observe prior committed allocations: selection+claim+charge
 * run under runSerializedAllocation (fairness lock + short transaction).
 */
export interface SchedulerFairnessRepository {
  listAll(): Promise<readonly ProjectFairnessState[]>;
  getByProjectId(projectId: string): Promise<ProjectFairnessState | null>;
  /**
   * Hold fairness coordination lock for one short allocation callback.
   * Nested applyCharge persists with revision CAS (no last-writer-wins).
   */
  runSerializedAllocation<T>(
    fn: (api: FairnessAllocationApi) => Promise<T>,
  ): Promise<T>;
  /**
   * Atomically lock, load, charge, persist. Prefer selectAndClaimWork for
   * production paths that also establish the Phase 11 lease claim.
   */
  applyServiceCharge(input: {
    selectedProjectId: string;
    weights: ReadonlyMap<string, number>;
    servedAt: string;
    decisionId: string;
  }): Promise<{
    before: readonly ProjectFairnessState[];
    after: readonly ProjectFairnessState[];
  }>;
  /**
   * Attempt to persist rows only when each project's durable revision matches
   * expectedRevisions. Stale writers must fail closed (no last-writer-wins).
   */
  writeRowsCas(input: {
    rows: readonly ProjectFairnessState[];
    expectedRevisions: ReadonlyMap<string, number>;
    decisionId: string;
  }): Promise<void>;
}

export interface PortfolioSnapshotPort {
  build(): Promise<PortfolioSnapshot>;
}
