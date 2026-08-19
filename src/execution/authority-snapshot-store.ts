import type { ExecutionAuthoritySnapshot } from "../domain/execution/index.js";

export interface ExecutionAuthoritySnapshotStore {
  save(
    snapshot: ExecutionAuthoritySnapshot,
    executionAttemptId: string,
  ): Promise<ExecutionAuthoritySnapshot>;
  getById(authoritySnapshotId: string): Promise<ExecutionAuthoritySnapshot | null>;
  getByAttempt(
    executionAttemptId: string,
  ): Promise<ExecutionAuthoritySnapshot | null>;
}
