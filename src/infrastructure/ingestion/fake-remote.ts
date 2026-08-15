import { IngestionError } from "../../ingestion/errors.js";
import {
  CommitShaSchema,
  type CiStatus,
  type CommitMetadata,
  type CommitSha,
  type IssueMetadata,
  type PullRequestMetadata,
  type RemoteRepositoryRef,
  type RemoteRepositoryService,
  type RepositoryMetadata,
} from "../../ingestion/remote-repository.js";
import type { RepositoryIdentity } from "../../ingestion/repository-source.js";

export interface FakeRemoteRepositoryState {
  identity: RepositoryIdentity;
  defaultBranch: string;
  description?: string;
  isPrivate?: boolean;
  branches: Record<string, CommitSha>;
  commits: Record<string, CommitMetadata>;
  pullRequests?: readonly PullRequestMetadata[];
  issues?: readonly IssueMetadata[];
  ci?: Record<string, CiStatus>;
  unavailable?: boolean;
  authFailed?: boolean;
}

function refKey(ref: RemoteRepositoryRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repository.toLowerCase()}`;
}

/**
 * In-process remote repository. Never contacts GitHub.
 */
export class FakeRemoteRepository implements RemoteRepositoryService {
  constructor(private state: FakeRemoteRepositoryState) {}

  setBranchHead(branch: string, sha: CommitSha): void {
    this.state = {
      ...this.state,
      branches: { ...this.state.branches, [branch]: sha },
    };
  }

  setUnavailable(unavailable: boolean): void {
    this.state = { ...this.state, unavailable };
  }

  setAuthFailed(authFailed: boolean): void {
    this.state = { ...this.state, authFailed };
  }

  private assertReachable(ref: RemoteRepositoryRef): void {
    if (this.state.authFailed) {
      throw new IngestionError(
        "REMOTE_AUTHENTICATION_FAILED",
        "GitHub authentication failed",
      );
    }
    if (this.state.unavailable) {
      throw new IngestionError(
        "REMOTE_REPOSITORY_UNAVAILABLE",
        "Remote repository is unavailable",
      );
    }
    const expected = `${this.state.identity.owner.toLowerCase()}/${this.state.identity.repository.toLowerCase()}`;
    if (refKey(ref) !== expected) {
      throw new IngestionError(
        "REPOSITORY_NOT_CONFIGURED",
        "Unknown repository",
        { owner: ref.owner, repository: ref.repository },
      );
    }
  }

  async getRepositoryMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<RepositoryMetadata> {
    this.assertReachable(ref);
    const metadata: RepositoryMetadata = {
      identity: this.state.identity,
      defaultBranch: this.state.defaultBranch,
      isPrivate: this.state.isPrivate ?? false,
    };
    if (this.state.description !== undefined) {
      metadata.description = this.state.description;
    }
    return metadata;
  }

  async resolveBranchHead(
    ref: RemoteRepositoryRef,
    branch: string,
  ): Promise<CommitSha> {
    this.assertReachable(ref);
    const sha = this.state.branches[branch];
    if (!sha) {
      throw new IngestionError("BRANCH_NOT_FOUND", `Branch not found: ${branch}`, {
        branch,
      });
    }
    return CommitShaSchema.parse(sha);
  }

  async getPullRequestMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<readonly PullRequestMetadata[]> {
    this.assertReachable(ref);
    return this.state.pullRequests ?? [];
  }

  async getIssueMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<readonly IssueMetadata[]> {
    this.assertReachable(ref);
    return this.state.issues ?? [];
  }

  async getCommitMetadata(
    ref: RemoteRepositoryRef,
    sha: string,
  ): Promise<CommitMetadata> {
    this.assertReachable(ref);
    const parsed = CommitShaSchema.safeParse(sha);
    if (!parsed.success) {
      throw new IngestionError("COMMIT_NOT_FOUND", "Commit SHA is malformed", {
        sha,
      });
    }
    const commit = this.state.commits[parsed.data.toLowerCase()] ??
      this.state.commits[parsed.data];
    if (!commit) {
      throw new IngestionError("COMMIT_NOT_FOUND", `Commit not found: ${sha}`, {
        sha,
      });
    }
    return commit;
  }

  async getCiStatus(ref: RemoteRepositoryRef, sha: string): Promise<CiStatus> {
    this.assertReachable(ref);
    const parsed = CommitShaSchema.parse(sha);
    return (
      this.state.ci?.[parsed.toLowerCase()] ??
      this.state.ci?.[parsed] ?? {
        sha: parsed,
        state: "unknown",
      }
    );
  }
}
