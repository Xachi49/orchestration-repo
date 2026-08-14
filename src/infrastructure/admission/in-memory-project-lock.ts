import type {
  AcquireLockCommand,
  LockAcquireResult,
  ProjectLock,
  ProjectLockService,
} from "../../admission/project-lock.js";

function isWellFormedLock(value: ProjectLock): boolean {
  return (
    value.projectId.length > 0 &&
    value.runId.length > 0 &&
    value.lockOwner.length > 0 &&
    value.acquiredAt.length > 0 &&
    value.expiresAt.length > 0
  );
}

/**
 * In-memory project lock.
 * Not distributed. Future durable implementations must use compare-and-set.
 * Lookup failure is never treated as an acquired lock.
 */
export class InMemoryProjectLockService implements ProjectLockService {
  private readonly locks = new Map<string, ProjectLock>();
  private failLookups = false;
  failNextRelease = false;

  failNextLookups(fail: boolean): void {
    this.failLookups = fail;
  }

  async getActiveLock(projectId: string): Promise<ProjectLock | null> {
    if (this.failLookups) {
      throw new Error("Lock lookup failed");
    }
    return this.locks.get(projectId) ?? null;
  }

  async acquire(command: AcquireLockCommand): Promise<LockAcquireResult> {
    let existing: ProjectLock | null;
    try {
      existing = await this.getActiveLock(command.projectId);
    } catch {
      return { result: "RESOURCE_CONFLICT", lock: null };
    }

    if (existing) {
      if (!isWellFormedLock(existing)) {
        return { result: "RESOURCE_CONFLICT", lock: existing };
      }
      if (existing.runId === command.runId) {
        return { result: "LOCK_ALREADY_OWNED", lock: existing };
      }
      return { result: "RESOURCE_CONFLICT", lock: existing };
    }

    const lock: ProjectLock = {
      projectId: command.projectId,
      runId: command.runId,
      lockOwner: command.lockOwner,
      acquiredAt: command.acquiredAt,
      expiresAt: command.expiresAt,
    };
    if (command.resourceScope !== undefined) {
      lock.resourceScope = command.resourceScope;
    }
    if (!isWellFormedLock(lock)) {
      return { result: "RESOURCE_CONFLICT", lock: null };
    }
    this.locks.set(command.projectId, lock);
    return { result: "LOCK_ACQUIRED", lock };
  }

  async release(projectId: string, runId: string): Promise<void> {
    if (this.failNextRelease) {
      this.failNextRelease = false;
      throw new Error("simulated lock release failure");
    }
    const existing = this.locks.get(projectId);
    if (!existing) {
      return;
    }
    if (existing.runId !== runId) {
      return;
    }
    this.locks.delete(projectId);
  }
}
