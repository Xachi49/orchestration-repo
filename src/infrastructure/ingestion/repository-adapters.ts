/**
 * Repository infrastructure selection.
 *
 * PRODUCTION != FAKE REPOSITORY TRUTH
 * FAKE ADAPTER != PRODUCTION FALLBACK
 * REMOTE METADATA != VERIFIED WORKSPACE
 * SYNTHESIZED SOURCE != SYNTHESIZED REPOSITORY TRUTH
 *
 * Production must never silently fall back to FakeRemote / FakeWorkspace.
 */
import {
  EXAMPLE_COMMIT_METADATA,
  EXAMPLE_COMMIT_SHA,
  EXAMPLE_DRIFT_SHA,
  EXAMPLE_REPOSITORY_SOURCE,
  EXAMPLE_WORKSPACE_FILES,
} from "../../ingestion/fixtures.js";
import type { RemoteRepositoryService } from "../../ingestion/remote-repository.js";
import type { RepositoryWorkspaceService } from "../../ingestion/workspace.js";
import { FakeRemoteRepository } from "./fake-remote.js";
import { FakeRepositoryWorkspace } from "./fake-workspace.js";
import {
  GitHubReadOnlyAdapter,
  githubAuthModeFromEnv,
  githubTokenFromEnv,
  type GitHubAuthMode,
} from "./github-readonly.js";
import { LocalGitWorkspaceService } from "./git-workspace.js";

export const REPOSITORY_REMOTE_ADAPTERS = ["GITHUB", "FAKE"] as const;
export type RepositoryRemoteAdapterKind =
  (typeof REPOSITORY_REMOTE_ADAPTERS)[number];

export const REPOSITORY_WORKSPACE_ADAPTERS = ["LOCAL_GIT", "FAKE"] as const;
export type RepositoryWorkspaceAdapterKind =
  (typeof REPOSITORY_WORKSPACE_ADAPTERS)[number];

/** Explicit narrow mode. Production defaults to REAL and rejects FAKE. */
export const REPOSITORY_ADAPTER_MODES = ["REAL", "FAKE"] as const;
export type RepositoryAdapterMode = (typeof REPOSITORY_ADAPTER_MODES)[number];

export class RepositoryAdapterSelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RepositoryAdapterSelectionError";
    this.code = code;
  }
}

export function isRepositoryAdapterSelectionError(
  error: unknown,
): error is RepositoryAdapterSelectionError {
  return error instanceof RepositoryAdapterSelectionError;
}

export interface RepositoryInfrastructureSelection {
  remote: RemoteRepositoryService;
  workspace: RepositoryWorkspaceService;
  remoteAdapter: RepositoryRemoteAdapterKind;
  workspaceAdapter: RepositoryWorkspaceAdapterKind;
  mode: RepositoryAdapterMode;
  /** Present when remoteAdapter is GITHUB; null for FAKE. */
  githubAuthenticationMode: GitHubAuthMode | null;
}

export interface SelectRepositoryInfrastructureInput {
  runtimeEnvironment: string;
  dataRoot: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit mode override. When omitted:
   * PRODUCTION → REAL; otherwise → FAKE (deterministic fixtures).
   */
  mode?: RepositoryAdapterMode;
  /** Explicit GitHub HTTP auth mode for REAL adapters. */
  githubAuthMode?: GitHubAuthMode;
  /** Test seam — injected GitHub token (never logged). */
  githubToken?: string;
  /** Test seam — deterministic GitHub transport. */
  githubFetchImpl?: typeof fetch;
  /**
   * Test-only: allow file:// remotes for LocalGitWorkspaceService.
   * Forbidden when resolving PRODUCTION REAL adapters for live runtime.
   */
  allowLocalRemotes?: boolean;
}

function modeFromEnv(
  env: NodeJS.ProcessEnv,
): RepositoryAdapterMode | undefined {
  const raw = env["ORCHESTRATOR_REPOSITORY_ADAPTER_MODE"]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "REAL" || raw === "FAKE") return raw;
  throw new RepositoryAdapterSelectionError(
    "REPOSITORY_ADAPTER_MODE_INVALID",
    `ORCHESTRATOR_REPOSITORY_ADAPTER_MODE must be REAL or FAKE, got ${raw}`,
  );
}

/**
 * Resolve REAL vs FAKE repository adapters.
 * PRODUCTION may never select FAKE. There is no GitHub→Fake fallback.
 */
export function resolveRepositoryAdapterMode(input: {
  runtimeEnvironment: string;
  mode?: RepositoryAdapterMode;
  env?: NodeJS.ProcessEnv;
}): RepositoryAdapterMode {
  const env = input.env ?? process.env;
  const fromEnv = modeFromEnv(env);
  const defaultMode: RepositoryAdapterMode =
    input.runtimeEnvironment === "PRODUCTION" ? "REAL" : "FAKE";
  const mode = input.mode ?? fromEnv ?? defaultMode;

  if (input.runtimeEnvironment === "PRODUCTION" && mode === "FAKE") {
    throw new RepositoryAdapterSelectionError(
      "PRODUCTION_FAKE_REPOSITORY_FORBIDDEN",
      "PRODUCTION != FAKE REPOSITORY TRUTH; FAKE ADAPTER != PRODUCTION FALLBACK",
    );
  }
  return mode;
}

/**
 * Resolve GitHub auth mode. Never infers PUBLIC_ANONYMOUS from missing token.
 * PRODUCTION REAL requires an explicit mode (env or option).
 */
export function resolveGitHubAuthMode(input: {
  runtimeEnvironment: string;
  githubAuthMode?: GitHubAuthMode;
  env?: NodeJS.ProcessEnv;
}): GitHubAuthMode {
  const env = input.env ?? process.env;
  if (input.githubAuthMode !== undefined) {
    return input.githubAuthMode;
  }
  try {
    const fromEnv = githubAuthModeFromEnv(env);
    if (fromEnv) return fromEnv;
  } catch (error) {
    if (error instanceof Error && error.name === "IngestionError") {
      throw new RepositoryAdapterSelectionError(
        "GITHUB_AUTH_MODE_INVALID",
        error.message,
      );
    }
    throw error;
  }
  if (input.runtimeEnvironment === "PRODUCTION") {
    throw new RepositoryAdapterSelectionError(
      "GITHUB_AUTH_MODE_REQUIRED",
      "PRODUCTION requires explicit ORCHESTRATOR_GITHUB_AUTH_MODE (TOKEN or PUBLIC_ANONYMOUS); never inferred from token presence",
    );
  }
  // Non-production REAL tests default to TOKEN (token still required separately).
  return "TOKEN";
}

export function selectRepositoryInfrastructure(
  input: SelectRepositoryInfrastructureInput,
): RepositoryInfrastructureSelection {
  const env = input.env ?? process.env;
  const mode = resolveRepositoryAdapterMode({
    runtimeEnvironment: input.runtimeEnvironment,
    ...(input.mode !== undefined ? { mode: input.mode } : {}),
    env,
  });

  if (mode === "REAL") {
    const githubAuthMode = resolveGitHubAuthMode({
      runtimeEnvironment: input.runtimeEnvironment,
      ...(input.githubAuthMode !== undefined
        ? { githubAuthMode: input.githubAuthMode }
        : {}),
      env,
    });
    const token =
      input.githubToken !== undefined
        ? input.githubToken.trim() || undefined
        : githubTokenFromEnv(env);

    if (githubAuthMode === "TOKEN" && !token) {
      throw new RepositoryAdapterSelectionError(
        "GITHUB_TOKEN_REQUIRED",
        "TOKEN GitHub auth mode requires GITHUB_TOKEN. Missing credentials fail closed; FAKE and PUBLIC_ANONYMOUS are not fallbacks.",
      );
    }

    const githubOptions: ConstructorParameters<typeof GitHubReadOnlyAdapter>[0] =
      {
        authMode: githubAuthMode,
        ...(githubAuthMode === "TOKEN" && token ? { token } : {}),
      };
    if (input.githubFetchImpl) {
      githubOptions.fetchImpl = input.githubFetchImpl;
    }
    const remote = new GitHubReadOnlyAdapter(githubOptions);
    // allowLocalRemotes is a test seam only. Live PRODUCTION bootstrap never sets it.
    const workspace = new LocalGitWorkspaceService({
      dataRoot: input.dataRoot,
      ...(input.allowLocalRemotes === true ? { allowLocalRemotes: true } : {}),
    });
    return {
      remote,
      workspace,
      remoteAdapter: "GITHUB",
      workspaceAdapter: "LOCAL_GIT",
      mode,
      githubAuthenticationMode: githubAuthMode,
    };
  }

  const remote = new FakeRemoteRepository({
    identity: {
      provider: "GITHUB",
      owner: EXAMPLE_REPOSITORY_SOURCE.owner,
      repository: EXAMPLE_REPOSITORY_SOURCE.repository,
    },
    defaultBranch: EXAMPLE_REPOSITORY_SOURCE.defaultBranch,
    branches: {
      [EXAMPLE_REPOSITORY_SOURCE.defaultBranch]: EXAMPLE_COMMIT_SHA,
    },
    commits: {
      [EXAMPLE_COMMIT_SHA]: EXAMPLE_COMMIT_METADATA,
      [EXAMPLE_DRIFT_SHA]: {
        ...EXAMPLE_COMMIT_METADATA,
        sha: EXAMPLE_DRIFT_SHA,
        message: "later commit",
      },
    },
  });
  const filesBySha = new Map([
    [EXAMPLE_COMMIT_SHA, EXAMPLE_WORKSPACE_FILES],
    [EXAMPLE_DRIFT_SHA, EXAMPLE_WORKSPACE_FILES],
  ]);
  const workspace = new FakeRepositoryWorkspace({ filesBySha });
  return {
    remote,
    workspace,
    remoteAdapter: "FAKE",
    workspaceAdapter: "FAKE",
    mode,
    githubAuthenticationMode: null,
  };
}

/** Stable data root for production workspaces (writable; run-scoped under runs/). */
export function resolveRepositoryDataRoot(
  env: NodeJS.ProcessEnv = process.env,
  explicit?: string,
): string | undefined {
  if (explicit !== undefined && explicit.trim() !== "") {
    return explicit;
  }
  const fromEnv = env["ORCHESTRATOR_DATA_ROOT"]?.trim();
  if (fromEnv) return fromEnv;
  return undefined;
}
