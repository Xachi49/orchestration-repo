import type { CoordinatorLease } from "../domain/durability/index.js";

/**
 * Durable lease operations scheduling needs. Structural so scheduling depends
 * on a port rather than on the PostgreSQL adapter.
 */
export interface SchedulerLeaseStorePort {
  acquire(input: {
    coordinationKey: string;
    phase: string;
    ownerId: string;
  }): Promise<CoordinatorLease>;
  release(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<void>;
  assertWritable(input: {
    coordinationKey: string;
    ownerId: string;
    fenceToken: number;
  }): Promise<void>;
  /**
   * True when coordinator_leases shows HELD and lease_expires_at >= DB/now
   * for this coordination key (Phase 11 live-lease interpretation).
   */
  isLiveHeld(coordinationKey: string): Promise<boolean>;
}

export const SCHEDULER_LEASE_PHASE = "SCHEDULER";

export function schedulerWorkCoordinationKey(workItemId: string): string {
  return `scheduler:work:${workItemId}`;
}
