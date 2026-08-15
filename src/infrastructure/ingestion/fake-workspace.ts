import { IngestionError } from "../../ingestion/errors.js";
import { CommitShaSchema, type CommitSha } from "../../ingestion/remote-repository.js";
import {
  resolveContained,
  sanitizeRunId,
  workspaceRootFor,
} from "../../ingestion/workspace-paths.js";
import type {
  HeadVerification,
  PreparedWorkspace,
  RepositoryWorkspaceService,
} from "../../ingestion/workspace.js";

export class FakeRepositoryWorkspace implements RepositoryWorkspaceService {
  readonly dataRoot: string;
  private readonly filesBySha: Map<string, ReadonlyArray<{ relativePath: string; content: Buffer }>>;
  private readonly checkedOut = new Map<string, CommitSha>();
  private readonly mismatchNextVerify = new Set<string>();

  constructor(options: {
    dataRoot?: string;
    filesBySha: ReadonlyMap<string, ReadonlyArray<{ relativePath: string; content: Buffer }>>;
  }) {
    this.dataRoot = options.dataRoot ?? "/app-data";
    this.filesBySha = new Map(options.filesBySha);
  }

  forceHeadMismatch(runId: string): void {
    this.mismatchNextVerify.add(runId);
  }

  async prepareWorkspace(
    runId: string,
    _remoteUrl: string,
  ): Promise<PreparedWorkspace> {
    sanitizeRunId(runId);
    return {
      runId,
      workspaceRoot: workspaceRootFor(this.dataRoot, runId),
      hooksDisabled: true,
    };
  }

  async fetchRemote(_workspace: PreparedWorkspace): Promise<void> {
    return;
  }

  async checkoutDetachedCommit(
    workspace: PreparedWorkspace,
    commitSha: CommitSha,
  ): Promise<void> {
    const sha = CommitShaSchema.parse(commitSha);
    if (!this.filesBySha.has(sha.toLowerCase()) && !this.filesBySha.has(sha)) {
      throw new IngestionError("COMMIT_NOT_FOUND", "Workspace has no files for SHA", {
        sha,
      });
    }
    this.checkedOut.set(workspace.runId, sha);
  }

  async verifyHead(
    workspace: PreparedWorkspace,
    lockedSha: CommitSha,
  ): Promise<HeadVerification> {
    const expected = CommitShaSchema.parse(lockedSha);
    if (this.mismatchNextVerify.has(workspace.runId)) {
      this.mismatchNextVerify.delete(workspace.runId);
      return { headSha: expected, matchesLockedSha: false };
    }
    const headSha = this.checkedOut.get(workspace.runId);
    if (!headSha) {
      throw new IngestionError(
        "WORKSPACE_PREPARATION_FAILED",
        "Workspace has not been checked out",
      );
    }
    return {
      headSha,
      matchesLockedSha: headSha.toLowerCase() === expected.toLowerCase(),
    };
  }

  async removeWorkspace(runId: string): Promise<void> {
    this.checkedOut.delete(runId);
  }

  async readFile(
    workspace: PreparedWorkspace,
    relativePath: string,
  ): Promise<Buffer> {
    resolveContained(workspace.workspaceRoot, relativePath);
    const sha = this.checkedOut.get(workspace.runId);
    if (!sha) {
      throw new IngestionError(
        "WORKSPACE_PREPARATION_FAILED",
        "Workspace has not been checked out",
      );
    }
    const files =
      this.filesBySha.get(sha) ?? this.filesBySha.get(sha.toLowerCase()) ?? [];
    const found = files.find((file) => file.relativePath === relativePath);
    if (!found) {
      throw new IngestionError(
        "INDEXING_FAILED",
        `File not found in workspace: ${relativePath}`,
      );
    }
    return found.content;
  }

  async listFiles(workspace: PreparedWorkspace): Promise<readonly string[]> {
    const sha = this.checkedOut.get(workspace.runId);
    if (!sha) {
      throw new IngestionError(
        "WORKSPACE_PREPARATION_FAILED",
        "Workspace has not been checked out",
      );
    }
    const files =
      this.filesBySha.get(sha) ?? this.filesBySha.get(sha.toLowerCase()) ?? [];
    return files.map((file) => file.relativePath);
  }
}
