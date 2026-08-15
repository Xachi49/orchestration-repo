import { IngestionError } from "../../ingestion/errors.js";
import { assertSafeGitHubName } from "../../ingestion/workspace-paths.js";
import {
  COMMIT_SHA_PATTERN,
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

export interface GitHubReadOnlyAdapterOptions {
  token: string | undefined;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
}

interface GitHubRepoResponse {
  name?: string;
  default_branch?: string;
  description?: string | null;
  private?: boolean;
  owner?: { login?: string };
}

interface GitHubBranchResponse {
  commit?: { sha?: string };
}

interface GitHubCommitResponse {
  sha?: string;
  commit?: {
    message?: string;
    author?: { name?: string; date?: string };
    committer?: { name?: string; date?: string };
  };
}

interface GitHubPullResponse {
  number?: number;
  title?: string;
  state?: string;
  head?: { sha?: string };
  base?: { ref?: string };
}

interface GitHubIssueResponse {
  number?: number;
  title?: string;
  state?: string;
  pull_request?: unknown;
}

interface GitHubCombinedStatusResponse {
  sha?: string;
  state?: string;
}

function githubTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env["GITHUB_TOKEN"];
  if (token === undefined || token.trim() === "") {
    return undefined;
  }
  return token;
}

function toIsoDatetime(value: string | undefined): string {
  if (!value) {
    throw new IngestionError(
      "REMOTE_REPOSITORY_UNAVAILABLE",
      "GitHub commit is missing a timestamp",
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new IngestionError(
      "REMOTE_REPOSITORY_UNAVAILABLE",
      "GitHub commit timestamp is invalid",
    );
  }
  return date.toISOString();
}

function mapCiState(state: string | undefined): CiStatus["state"] {
  switch (state) {
    case "success":
    case "pending":
    case "failure":
      return state;
    case "error":
      return "failure";
    default:
      return "unknown";
  }
}

/**
 * Read-only GitHub adapter. Issues GET requests only.
 * Never logs the token. Never exposes generic HTTP mutation.
 */
export class GitHubReadOnlyAdapter implements RemoteRepositoryService {
  readonly writesEnabled = false as const;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly apiBaseUrl: string;
  readonly recordedMethods: string[] = [];

  constructor(options: GitHubReadOnlyAdapterOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl?: typeof fetch,
  ): GitHubReadOnlyAdapter {
    const options: GitHubReadOnlyAdapterOptions = {
      token: githubTokenFromEnv(env),
    };
    if (fetchImpl) {
      options.fetchImpl = fetchImpl;
    }
    return new GitHubReadOnlyAdapter(options);
  }

  private requireToken(): string {
    if (!this.token) {
      throw new IngestionError(
        "REMOTE_AUTHENTICATION_FAILED",
        "GitHub credentials are unavailable",
      );
    }
    return this.token;
  }

  private repoPath(ref: RemoteRepositoryRef): string {
    const owner = assertSafeGitHubName(ref.owner, "owner");
    const repository = assertSafeGitHubName(ref.repository, "repository");
    return `/repos/${owner}/${repository}`;
  }

  private async getJson<T>(
    path: string,
    notFoundCode: "BRANCH_NOT_FOUND" | "COMMIT_NOT_FOUND" | "REPOSITORY_NOT_CONFIGURED",
  ): Promise<T> {
    const token = this.requireToken();
    this.recordedMethods.push("GET");
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "orchestrator-agent-phase3",
        },
      });
    } catch {
      throw new IngestionError(
        "REMOTE_REPOSITORY_UNAVAILABLE",
        "GitHub request failed",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new IngestionError(
        "REMOTE_AUTHENTICATION_FAILED",
        "GitHub authentication failed",
      );
    }
    if (response.status === 404) {
      throw new IngestionError(notFoundCode, "GitHub resource was not found");
    }
    if (!response.ok) {
      throw new IngestionError(
        "REMOTE_REPOSITORY_UNAVAILABLE",
        `GitHub request failed with status ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  async getRepositoryMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<RepositoryMetadata> {
    const body = await this.getJson<GitHubRepoResponse>(
      this.repoPath(ref),
      "REPOSITORY_NOT_CONFIGURED",
    );
    const owner = body.owner?.login ?? ref.owner;
    const repository = body.name ?? ref.repository;
    const defaultBranch = body.default_branch;
    if (!defaultBranch) {
      throw new IngestionError(
        "REMOTE_REPOSITORY_UNAVAILABLE",
        "GitHub repository is missing a default branch",
      );
    }
    const metadata: RepositoryMetadata = {
      identity: {
        provider: "GITHUB",
        owner,
        repository,
      },
      defaultBranch,
      isPrivate: body.private === true,
    };
    if (typeof body.description === "string" && body.description.length > 0) {
      metadata.description = body.description;
    }
    return metadata;
  }

  async resolveBranchHead(
    ref: RemoteRepositoryRef,
    branch: string,
  ): Promise<CommitSha> {
    if (branch.includes("..") || branch.includes("\0") || branch.trim() === "") {
      throw new IngestionError("BRANCH_NOT_FOUND", "Branch name is invalid");
    }
    const encoded = encodeURIComponent(branch);
    const body = await this.getJson<GitHubBranchResponse>(
      `${this.repoPath(ref)}/branches/${encoded}`,
      "BRANCH_NOT_FOUND",
    );
    const sha = body.commit?.sha;
    if (!sha || !COMMIT_SHA_PATTERN.test(sha)) {
      throw new IngestionError(
        "BRANCH_NOT_FOUND",
        "Branch head SHA is missing or not a full commit SHA",
      );
    }
    return CommitShaSchema.parse(sha);
  }

  async getPullRequestMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<readonly PullRequestMetadata[]> {
    const body = await this.getJson<GitHubPullResponse[]>(
      `${this.repoPath(ref)}/pulls?state=open&per_page=30`,
      "REPOSITORY_NOT_CONFIGURED",
    );
    const result: PullRequestMetadata[] = [];
    for (const item of body) {
      if (
        typeof item.number !== "number" ||
        typeof item.title !== "string" ||
        (item.state !== "open" && item.state !== "closed") ||
        typeof item.head?.sha !== "string" ||
        !COMMIT_SHA_PATTERN.test(item.head.sha) ||
        typeof item.base?.ref !== "string"
      ) {
        continue;
      }
      result.push({
        number: item.number,
        title: item.title,
        state: item.state,
        headSha: CommitShaSchema.parse(item.head.sha),
        baseRef: item.base.ref,
      });
    }
    return result;
  }

  async getIssueMetadata(
    ref: RemoteRepositoryRef,
  ): Promise<readonly IssueMetadata[]> {
    const body = await this.getJson<GitHubIssueResponse[]>(
      `${this.repoPath(ref)}/issues?state=open&per_page=30`,
      "REPOSITORY_NOT_CONFIGURED",
    );
    const result: IssueMetadata[] = [];
    for (const item of body) {
      if (item.pull_request !== undefined) {
        continue;
      }
      if (
        typeof item.number !== "number" ||
        typeof item.title !== "string" ||
        (item.state !== "open" && item.state !== "closed")
      ) {
        continue;
      }
      result.push({
        number: item.number,
        title: item.title,
        state: item.state,
      });
    }
    return result;
  }

  async getCommitMetadata(
    ref: RemoteRepositoryRef,
    sha: string,
  ): Promise<CommitMetadata> {
    if (!COMMIT_SHA_PATTERN.test(sha)) {
      throw new IngestionError("COMMIT_NOT_FOUND", "Commit SHA is malformed");
    }
    const body = await this.getJson<GitHubCommitResponse>(
      `${this.repoPath(ref)}/commits/${sha.toLowerCase()}`,
      "COMMIT_NOT_FOUND",
    );
    const resolved = body.sha;
    if (!resolved || !COMMIT_SHA_PATTERN.test(resolved)) {
      throw new IngestionError(
        "COMMIT_NOT_FOUND",
        "GitHub commit SHA is missing or not a full commit SHA",
      );
    }
    const authorName =
      body.commit?.author?.name || body.commit?.committer?.name || "unknown";
    return {
      sha: CommitShaSchema.parse(resolved),
      message: body.commit?.message ?? "",
      authorName,
      committedAt: toIsoDatetime(
        body.commit?.committer?.date ?? body.commit?.author?.date,
      ),
    };
  }

  async getCiStatus(ref: RemoteRepositoryRef, sha: string): Promise<CiStatus> {
    if (!COMMIT_SHA_PATTERN.test(sha)) {
      throw new IngestionError("COMMIT_NOT_FOUND", "Commit SHA is malformed");
    }
    const body = await this.getJson<GitHubCombinedStatusResponse>(
      `${this.repoPath(ref)}/commits/${sha.toLowerCase()}/status`,
      "COMMIT_NOT_FOUND",
    );
    const resolved = body.sha && COMMIT_SHA_PATTERN.test(body.sha) ? body.sha : sha;
    return {
      sha: CommitShaSchema.parse(resolved),
      state: mapCiState(body.state),
    };
  }
}

export { githubTokenFromEnv };
