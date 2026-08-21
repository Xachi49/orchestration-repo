import type { CoordinatorLease } from "../domain/durability/index.js";
import { DurabilityError } from "../durability/errors.js";
import type { CrossRunDependency } from "./dependency.js";
import { SchedulingError } from "./errors.js";
import {
  nextFairnessRowsAfterService,
  type ProjectFairnessState,
} from "./fairness.js";
import type { SchedulerLeaseStorePort } from "./lease-port.js";
import type {
  SchedulerDecisionRecord,
  SchedulerPauseRecord,
  SchedulerProjectConfig,
} from "./records.js";
import type {
  FairnessAllocationApi,
  SchedulableProjectSummary,
  SchedulerDecisionRepository,
  SchedulerDependencyRepository,
  SchedulerFairnessRepository,
  SchedulerPauseRepository,
  SchedulerProjectConfigRepository,
  SchedulerWorkItemRepository,
} from "./repositories.js";
import type { SchedulerWorkItem, WorkItemStatus } from "./work-item.js";
import { isTerminalWorkStatus } from "./work-item.js";

function activeStatuses(): WorkItemStatus[] {
  return ["CLAIMED", "RUNNING"];
}

export class InMemorySchedulerWorkItemRepository
  implements SchedulerWorkItemRepository
{
  private readonly byId = new Map<string, SchedulerWorkItem>();
  private readonly byIdentity = new Map<string, string>();
  private leaseLiveCheck: ((coordinationKey: string) => boolean) | null = null;

  /** Wire Phase 11 lease liveness for active-capacity accounting. */
  bindLeaseLiveCheck(check: (coordinationKey: string) => boolean): void {
    this.leaseLiveCheck = check;
  }

  private isLiveClaim(workItemId: string): boolean {
    if (!this.leaseLiveCheck) {
      return false;
    }
    return this.leaseLiveCheck(`scheduler:work:${workItemId}`);
  }

  async getById(workItemId: string): Promise<SchedulerWorkItem | null> {
    return this.byId.get(workItemId) ?? null;
  }

  async getByLogicalIdentity(
    logicalIdentityKey: string,
  ): Promise<SchedulerWorkItem | null> {
    const id = this.byIdentity.get(logicalIdentityKey);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async listByRun(runId: string): Promise<readonly SchedulerWorkItem[]> {
    return [...this.byId.values()].filter((item) => item.runId === runId);
  }

  async listByProject(projectId: string): Promise<readonly SchedulerWorkItem[]> {
    return [...this.byId.values()].filter((item) => item.projectId === projectId);
  }

  async listByStatus(
    statuses: readonly WorkItemStatus[],
    limit: number,
  ): Promise<readonly SchedulerWorkItem[]> {
    const set = new Set(statuses);
    return [...this.byId.values()]
      .filter((item) => set.has(item.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  async listSchedulableProjectSummaries(
    nowIso: string,
  ): Promise<readonly SchedulableProjectSummary[]> {
    const nowMs = Date.parse(nowIso);
    const oldestByProject = new Map<string, string>();
    for (const item of this.byId.values()) {
      if (item.status !== "ELIGIBLE") {
        continue;
      }
      if (Date.parse(item.eligibleAt) > nowMs) {
        continue;
      }
      const prior = oldestByProject.get(item.projectId);
      if (!prior || item.eligibleAt < prior) {
        oldestByProject.set(item.projectId, item.eligibleAt);
      }
    }
    return [...oldestByProject.entries()]
      .map(([projectId, oldestEligibleAt]) => ({
        projectId,
        oldestEligibleAt,
      }))
      .sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  async listCandidateWorkByProject(
    projectId: string,
    statuses: readonly WorkItemStatus[],
    limit: number,
  ): Promise<readonly SchedulerWorkItem[]> {
    const set = new Set(statuses);
    return [...this.byId.values()]
      .filter((item) => item.projectId === projectId && set.has(item.status))
      .sort((a, b) => {
        const byEligible = a.eligibleAt.localeCompare(b.eligibleAt);
        if (byEligible !== 0) {
          return byEligible;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .slice(0, limit);
  }

  async save(item: SchedulerWorkItem): Promise<SchedulerWorkItem> {
    const existing = this.byIdentity.get(item.logicalIdentityKey);
    if (existing && existing !== item.workItemId) {
      throw new SchedulingError(
        "INVALID_WORK_ITEM",
        "Logical identity already bound to another work item",
      );
    }
    this.byId.set(item.workItemId, item);
    this.byIdentity.set(item.logicalIdentityKey, item.workItemId);
    return item;
  }

  async updateCas(
    item: SchedulerWorkItem,
    expectedRevision: number,
  ): Promise<SchedulerWorkItem> {
    const current = this.byId.get(item.workItemId);
    if (!current || current.recordRevision !== expectedRevision) {
      throw new SchedulingError(
        "SCHEDULER_CAS_CONFLICT",
        "Work item revision conflict",
        { workItemId: item.workItemId },
      );
    }
    const next = { ...item, recordRevision: expectedRevision + 1 };
    this.byId.set(next.workItemId, next);
    return next;
  }

  async countActiveByProject(projectId: string): Promise<number> {
    const active = new Set(activeStatuses());
    return [...this.byId.values()].filter(
      (item) =>
        item.projectId === projectId &&
        active.has(item.status) &&
        this.isLiveClaim(item.workItemId),
    ).length;
  }

  async countActiveGlobal(): Promise<number> {
    const active = new Set(activeStatuses());
    return [...this.byId.values()].filter(
      (item) => active.has(item.status) && this.isLiveClaim(item.workItemId),
    ).length;
  }

  async listExpiredClaimed(limit: number): Promise<readonly SchedulerWorkItem[]> {
    return [...this.byId.values()]
      .filter(
        (item) => item.status === "CLAIMED" && !this.isLiveClaim(item.workItemId),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }
}

export class InMemorySchedulerDependencyRepository
  implements SchedulerDependencyRepository
{
  private readonly byId = new Map<string, CrossRunDependency>();

  async getById(dependencyId: string): Promise<CrossRunDependency | null> {
    return this.byId.get(dependencyId) ?? null;
  }

  async listByDependentRun(
    dependentRunId: string,
  ): Promise<readonly CrossRunDependency[]> {
    return [...this.byId.values()].filter(
      (item) => item.dependentRunId === dependentRunId,
    );
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly CrossRunDependency[]> {
    return [...this.byId.values()].filter((item) => item.projectId === projectId);
  }

  async listAll(): Promise<readonly CrossRunDependency[]> {
    return [...this.byId.values()];
  }

  async save(dependency: CrossRunDependency): Promise<CrossRunDependency> {
    this.byId.set(dependency.dependencyId, dependency);
    return dependency;
  }
}

export class InMemorySchedulerDecisionRepository
  implements SchedulerDecisionRepository
{
  private readonly items: SchedulerDecisionRecord[] = [];

  async append(decision: SchedulerDecisionRecord): Promise<void> {
    this.items.push(decision);
  }

  async listByWorkItem(
    workItemId: string,
    limit = 50,
  ): Promise<readonly SchedulerDecisionRecord[]> {
    return this.items
      .filter(
        (item) =>
          item.selectedWorkId === workItemId ||
          item.candidateWorkIds.includes(workItemId),
      )
      .slice(-limit);
  }

  all(): readonly SchedulerDecisionRecord[] {
    return this.items;
  }
}

export class InMemorySchedulerProjectConfigRepository
  implements SchedulerProjectConfigRepository
{
  private readonly byId = new Map<string, SchedulerProjectConfig>();

  async getByProjectId(
    projectId: string,
  ): Promise<SchedulerProjectConfig | null> {
    return this.byId.get(projectId) ?? null;
  }

  async save(config: SchedulerProjectConfig): Promise<SchedulerProjectConfig> {
    this.byId.set(config.projectId, config);
    return config;
  }

  async list(): Promise<readonly SchedulerProjectConfig[]> {
    return [...this.byId.values()];
  }
}

export class InMemorySchedulerPauseRepository
  implements SchedulerPauseRepository
{
  private global: SchedulerPauseRecord | null = null;
  private readonly projects = new Map<string, SchedulerPauseRecord>();

  async getGlobal(): Promise<SchedulerPauseRecord | null> {
    return this.global;
  }

  async getProject(projectId: string): Promise<SchedulerPauseRecord | null> {
    return this.projects.get(projectId) ?? null;
  }

  async save(pause: SchedulerPauseRecord): Promise<SchedulerPauseRecord> {
    if (pause.scope === "GLOBAL") {
      this.global = pause;
    } else if (pause.projectId) {
      this.projects.set(pause.projectId, pause);
    }
    return pause;
  }
}

export class InMemorySchedulerFairnessRepository
  implements SchedulerFairnessRepository
{
  private readonly byProject = new Map<string, ProjectFairnessState>();
  private locked = false;

  async listAll(): Promise<readonly ProjectFairnessState[]> {
    return [...this.byProject.values()].sort((a, b) =>
      a.projectId.localeCompare(b.projectId),
    );
  }

  async getByProjectId(
    projectId: string,
  ): Promise<ProjectFairnessState | null> {
    return this.byProject.get(projectId) ?? null;
  }

  async runSerializedAllocation<T>(
    fn: (api: FairnessAllocationApi) => Promise<T>,
  ): Promise<T> {
    if (this.locked) {
      throw new SchedulingError(
        "SCHEDULER_CAS_CONFLICT",
        "Fairness lock already held",
      );
    }
    this.locked = true;
    try {
      const api: FairnessAllocationApi = {
        loadState: () => this.listAll(),
        applyCharge: async (input) => {
          const before = await this.listAll();
          const after = nextFairnessRowsAfterService({
            existing: before,
            selectedProjectId: input.selectedProjectId,
            weights: input.weights,
            servedAt: input.servedAt,
          });
          await this.persistCas(after, before, input.decisionId);
          return { before, after };
        },
      };
      return await fn(api);
    } finally {
      this.locked = false;
    }
  }

  async applyServiceCharge(input: {
    selectedProjectId: string;
    weights: ReadonlyMap<string, number>;
    servedAt: string;
    decisionId: string;
  }): Promise<{
    before: readonly ProjectFairnessState[];
    after: readonly ProjectFairnessState[];
  }> {
    return this.runSerializedAllocation((api) => api.applyCharge(input));
  }

  async writeRowsCas(input: {
    rows: readonly ProjectFairnessState[];
    expectedRevisions: ReadonlyMap<string, number>;
    decisionId: string;
  }): Promise<void> {
    await this.runSerializedAllocation(async () => {
      for (const row of input.rows) {
        const expected = input.expectedRevisions.get(row.projectId);
        if (expected === undefined) {
          throw new SchedulingError(
            "SCHEDULER_CAS_CONFLICT",
            "Missing expected fairness revision",
            { projectId: row.projectId },
          );
        }
        const current = this.byProject.get(row.projectId);
        if (!current || current.recordRevision !== expected) {
          throw new SchedulingError(
            "SCHEDULER_CAS_CONFLICT",
            "Stale fairness revision rejected",
            {
              projectId: row.projectId,
              expectedRevision: expected,
              actualRevision: current?.recordRevision,
            },
          );
        }
        this.byProject.set(row.projectId, {
          ...row,
        });
      }
    });
  }

  private async persistCas(
    after: readonly ProjectFairnessState[],
    before: readonly ProjectFairnessState[],
    _decisionId: string,
  ): Promise<void> {
    const beforeById = new Map(before.map((row) => [row.projectId, row]));
    for (const row of after) {
      const prior = beforeById.get(row.projectId);
      const expected = prior?.recordRevision ?? 0;
      const current = this.byProject.get(row.projectId);
      if (expected === 0) {
        if (current) {
          throw new SchedulingError(
            "SCHEDULER_CAS_CONFLICT",
            "Fairness insert lost race",
            { projectId: row.projectId },
          );
        }
        this.byProject.set(row.projectId, row);
        continue;
      }
      if (!current || current.recordRevision !== expected) {
        throw new SchedulingError(
          "SCHEDULER_CAS_CONFLICT",
          "Stale fairness revision rejected",
          {
            projectId: row.projectId,
            expectedRevision: expected,
            actualRevision: current?.recordRevision,
          },
        );
      }
      this.byProject.set(row.projectId, row);
    }
  }
}

/**
 * Process-local lease store for unit tests. Production uses PostgresLeaseStore.
 */
export class InMemorySchedulerLeaseStore implements SchedulerLeaseStorePort {
  private readonly byKey = new Map<string, CoordinatorLease>();
  private fence = 0;

  async acquire(input: {
    coordinationKey: string;
    phase: string;
    ownerId: string;
  }): Promise<CoordinatorLease> {
    const current = this.byKey.get(input.coordinationKey);
    const now = new Date().toISOString();
    if (
      current &&
      current.status === "HELD" &&
      current.ownerId !== input.ownerId &&
      Date.parse(current.leaseExpiresAt) > Date.now()
    ) {
      throw new DurabilityError(
        "LEASE_ALREADY_HELD",
        `Lease already held for ${input.coordinationKey}`,
        { coordinationKey: input.coordinationKey },
      );
    }
    this.fence += 1;
    const lease: CoordinatorLease = {
      coordinationKey: input.coordinationKey,
      phase: input.phase,
      ownerId: input.ownerId,
      fenceToken: this.fence,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      acquiredAt: now,
      lastHeartbeatAt: now,
      status: "HELD",
    };
    this.byKey.set(input.coordinationKey, lease);
    return lease;
  }

  async release(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<void> {
    const current = this.byKey.get(input.coordinationKey);
    if (
      current &&
      current.ownerId === input.ownerId &&
      current.fenceToken === input.fenceToken
    ) {
      this.byKey.delete(input.coordinationKey);
    }
  }

  async assertWritable(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<void> {
    const current = this.byKey.get(input.coordinationKey);
    if (
      !current ||
      current.ownerId !== input.ownerId ||
      current.fenceToken !== input.fenceToken ||
      current.status !== "HELD"
    ) {
      throw new DurabilityError(
        "STALE_FENCE_TOKEN",
        "Stale scheduler fence",
        { coordinationKey: input.coordinationKey },
      );
    }
  }

  async isLiveHeld(coordinationKey: string): Promise<boolean> {
    return this.isLiveHeldSync(coordinationKey);
  }

  isLiveHeldSync(coordinationKey: string): boolean {
    const current = this.byKey.get(coordinationKey);
    return Boolean(
      current &&
        current.status === "HELD" &&
        Date.parse(current.leaseExpiresAt) > Date.now(),
    );
  }
}

export function countNonTerminal(
  items: readonly SchedulerWorkItem[],
): number {
  return items.filter((item) => !isTerminalWorkStatus(item.status)).length;
}
