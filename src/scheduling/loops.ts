import type { CoordinatorLease } from "../domain/durability/index.js";
import { DurabilityError } from "../durability/errors.js";
import type {
  SchedulerDispatcher,
  SchedulerWorkStateWriter,
  WorkFailureInput,
} from "./dispatcher.js";
import { SchedulingError } from "./errors.js";
import {
  schedulerWorkCoordinationKey,
  type SchedulerLeaseStorePort,
} from "./lease-port.js";
import type { PortfolioSchedulerService } from "./service.js";
import type { SchedulerWorkItem } from "./work-item.js";
import type { WorkerCapabilityLabel } from "./work-kind.js";

export {
  SCHEDULER_LEASE_PHASE,
  schedulerWorkCoordinationKey,
  type SchedulerLeaseStorePort,
} from "./lease-port.js";

/**
 * Refuses terminal scheduler writes when the Phase 11 lease/fence is lost.
 */
export class LeaseFencedWorkStateWriter implements SchedulerWorkStateWriter {
  constructor(
    private readonly inner: SchedulerWorkStateWriter,
    private readonly leases: Pick<SchedulerLeaseStorePort, "assertWritable">,
    private readonly coordinationKey: string,
    private readonly ownerId: string,
    private readonly fenceToken: number,
  ) {}

  private async assertFence(): Promise<void> {
    try {
      await this.leases.assertWritable({
        coordinationKey: this.coordinationKey,
        ownerId: this.ownerId,
        fenceToken: this.fenceToken,
      });
    } catch (error) {
      if (error instanceof DurabilityError) {
        throw new SchedulingError(
          "STALE_SCHEDULER_FENCE",
          "Scheduler fence lost; refusing work settle",
          { coordinationKey: this.coordinationKey },
        );
      }
      throw error;
    }
  }

  async markStale(
    work: SchedulerWorkItem,
    reasonCode: string,
  ): Promise<SchedulerWorkItem> {
    await this.assertFence();
    return this.inner.markStale(work, reasonCode);
  }

  async markRunning(work: SchedulerWorkItem): Promise<SchedulerWorkItem> {
    await this.assertFence();
    return this.inner.markRunning(work);
  }

  async markSucceeded(
    work: SchedulerWorkItem,
    resultRef?: string,
  ): Promise<SchedulerWorkItem> {
    await this.assertFence();
    return this.inner.markSucceeded(work, resultRef);
  }

  async markFailed(
    work: SchedulerWorkItem,
    input: WorkFailureInput,
  ): Promise<SchedulerWorkItem> {
    await this.assertFence();
    return this.inner.markFailed(work, input);
  }
}

export interface SchedulerLoopPorts {
  scheduler: PortfolioSchedulerService;
  /** Base dispatcher; claim loop wraps work-state writer with lease fencing. */
  createDispatcher: (writer: SchedulerWorkStateWriter) => SchedulerDispatcher;
  leases: SchedulerLeaseStorePort;
  listDiscoverableRunIds: (limit: number) => Promise<readonly string[]>;
  databaseReachable: () => Promise<boolean>;
  isAccepting: () => boolean;
  runtimeId: string;
  workerCapabilities: readonly WorkerCapabilityLabel[];
  discoveryBatchSize: number;
  claimBatchSize: number;
  /** Optional project allowlist for selectAndClaimWork (shared-DB fixtures). */
  projectIds?: readonly string[];
  onMetric?: (name: string, delta?: number) => void;
}

/**
 * Periodically inspects durable runs and idempotently materializes work.
 * No full-table busy loop; batch-bounded.
 */
export class SchedulerDiscoveryLoop {
  constructor(private readonly ports: SchedulerLoopPorts) {}

  async tick(): Promise<{ discovered: number }> {
    if (!this.ports.isAccepting()) {
      return { discovered: 0 };
    }
    const reachable = await this.ports.databaseReachable();
    if (!reachable) {
      this.ports.onMetric?.("scheduler_database_unavailable");
      return { discovered: 0 };
    }
    const runIds = await this.ports.listDiscoverableRunIds(
      this.ports.discoveryBatchSize,
    );
    const result = await this.ports.scheduler.discoverBatch(runIds);
    this.ports.onMetric?.(
      "scheduler_discovery_created",
      result.created.length,
    );
    return { discovered: result.created.length + result.reused.length };
  }
}

/**
 * Selects, claims (via Phase 11 leases), and dispatches work.
 * Stale fence owners must not write terminal scheduler results.
 */
export class SchedulerClaimLoop {
  constructor(private readonly ports: SchedulerLoopPorts) {}

  async tick(): Promise<{ claimed: number; dispatched: number }> {
    if (!this.ports.isAccepting()) {
      return { claimed: 0, dispatched: 0 };
    }
    const reachable = await this.ports.databaseReachable();
    if (!reachable) {
      this.ports.onMetric?.("scheduler_database_unavailable");
      return { claimed: 0, dispatched: 0 };
    }

    let claimed = 0;
    let dispatched = 0;
    for (let i = 0; i < this.ports.claimBatchSize; i++) {
      if (!this.ports.isAccepting()) {
        break;
      }
      const { claimed: claimedWork, lease } =
        await this.ports.scheduler.selectAndClaimWork({
          workerCapabilities: this.ports.workerCapabilities,
          ownerId: this.ports.runtimeId,
          ...(this.ports.projectIds
            ? { projectIds: this.ports.projectIds }
            : {}),
        });
      if (!claimedWork || !lease) {
        break;
      }
      claimed += 1;
      this.ports.onMetric?.("scheduler_work_claimed");

      const coordinationKey = schedulerWorkCoordinationKey(
        claimedWork.workItemId,
      );
      const fenced = new LeaseFencedWorkStateWriter(
        this.ports.scheduler,
        this.ports.leases,
        coordinationKey,
        this.ports.runtimeId,
        lease.fenceToken,
      );
      const dispatcher = this.ports.createDispatcher(fenced);
      try {
        await dispatcher.dispatch(claimedWork);
        dispatched += 1;
        this.ports.onMetric?.("scheduler_dispatch_total");
      } catch (error) {
        this.ports.onMetric?.("scheduler_dispatch_failures");
        // Readiness failures mark work STALE inside the dispatcher. Continue
        // claiming — orphaned/stale rows must not abort the whole claim tick.
        if (
          error instanceof SchedulingError &&
          error.code === "DISPATCH_READINESS_FAILED"
        ) {
          continue;
        }
        throw error;
      } finally {
        try {
          await this.ports.leases.release({
            coordinationKey,
            ownerId: this.ports.runtimeId,
            fenceToken: lease.fenceToken,
          });
        } catch {
          // best-effort release
        }
      }
    }
    return { claimed, dispatched };
  }
}
