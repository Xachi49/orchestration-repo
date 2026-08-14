export interface ProjectLock {
  projectId: string;
  runId: string;
  lockOwner: string;
  acquiredAt: string;
  expiresAt: string;
  resourceScope?: string;
}

export type LockAcquireResult =
  | { result: "LOCK_ACQUIRED"; lock: ProjectLock }
  | { result: "LOCK_ALREADY_OWNED"; lock: ProjectLock }
  | { result: "RESOURCE_CONFLICT"; lock: ProjectLock | null };

export interface AcquireLockCommand {
  projectId: string;
  runId: string;
  lockOwner: string;
  acquiredAt: string;
  expiresAt: string;
  resourceScope?: string;
}

/**
 * Admission-scoped project lock.
 * Held only during the admission transaction; released on success and on
 * compensation. Later planning/execution phases will acquire their own locks.
 * Future durable stores must use compare-and-set; lookup failure must not
 * be treated as an acquired lock. In-memory adapters are not distributed.
 */
export interface ProjectLockService {
  acquire(command: AcquireLockCommand): Promise<LockAcquireResult>;
  release(projectId: string, runId: string): Promise<void>;
  getActiveLock(projectId: string): Promise<ProjectLock | null>;
}
