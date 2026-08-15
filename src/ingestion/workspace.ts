import type { CommitSha } from "./remote-repository.js";

export interface PreparedWorkspace {
  runId: string;
  workspaceRoot: string;
  hooksDisabled: true;
}

export interface HeadVerification {
  headSha: CommitSha;
  matchesLockedSha: boolean;
}

/**
 * Narrow Git/workspace port. No generic command execution.
 * Arguments must come from validated repository metadata.
 */
export interface RepositoryWorkspaceService {
  prepareWorkspace(runId: string, remoteUrl: string): Promise<PreparedWorkspace>;
  fetchRemote(workspace: PreparedWorkspace): Promise<void>;
  checkoutDetachedCommit(
    workspace: PreparedWorkspace,
    commitSha: CommitSha,
  ): Promise<void>;
  verifyHead(
    workspace: PreparedWorkspace,
    lockedSha: CommitSha,
  ): Promise<HeadVerification>;
  removeWorkspace(runId: string): Promise<void>;
  readFile(workspace: PreparedWorkspace, relativePath: string): Promise<Buffer>;
  listFiles(workspace: PreparedWorkspace): Promise<readonly string[]>;
}
