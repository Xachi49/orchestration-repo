import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { IngestionError } from "../../ingestion/errors.js";
import { parseGitHubRemoteUrl } from "../../ingestion/repository-source.js";
import { COMMIT_SHA_PATTERN, CommitShaSchema, type CommitSha } from "../../ingestion/remote-repository.js";
import {
  assertRealPathContained,
  hooksDisabledDirFor,
  resolveContained,
  sanitizeRunId,
  workspaceRootFor,
} from "../../ingestion/workspace-paths.js";
import type {
  HeadVerification,
  PreparedWorkspace,
  RepositoryWorkspaceService,
} from "../../ingestion/workspace.js";

export interface LocalGitWorkspaceOptions {
  dataRoot: string;
  allowLocalRemotes?: boolean;
  gitBinary?: string;
}

function isLocalRemote(remoteUrl: string): boolean {
  return remoteUrl.startsWith("file://") || remoteUrl.startsWith("/");
}

function assertRemoteUrl(
  remoteUrl: string,
  allowLocalRemotes: boolean,
): string {
  if (allowLocalRemotes && isLocalRemote(remoteUrl)) {
    if (remoteUrl.includes("\0") || remoteUrl.includes("..")) {
      throw new IngestionError(
        "WORKSPACE_PATH_VIOLATION",
        "Local remote URL is invalid",
      );
    }
    return remoteUrl;
  }
  const parsed = parseGitHubRemoteUrl(remoteUrl);
  if (!parsed) {
    throw new IngestionError(
      "REPOSITORY_NOT_CONFIGURED",
      "Remote URL is not a supported GitHub repository URL",
    );
  }
  return remoteUrl;
}

async function runGit(
  gitBinary: string,
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBinary, args, {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        HOME: cwd,
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", () => {
      reject(
        new IngestionError(
          "WORKSPACE_PREPARATION_FAILED",
          "Failed to invoke git",
        ),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      reject(
        new IngestionError(
          "WORKSPACE_PREPARATION_FAILED",
          "Git command failed",
          { gitArgs: args[0] },
        ),
      );
    });
  });
}

/**
 * Narrow git workspace. Arguments are constructed by trusted code.
   * Never uses git pull, merge, or rebase. Never exposes a generic command API.
 */
export class LocalGitWorkspaceService implements RepositoryWorkspaceService {
  private readonly dataRoot: string;
  private readonly allowLocalRemotes: boolean;
  private readonly gitBinary: string;

  constructor(options: LocalGitWorkspaceOptions) {
    this.dataRoot = options.dataRoot;
    this.allowLocalRemotes = options.allowLocalRemotes === true;
    this.gitBinary = options.gitBinary ?? "git";
  }

  async prepareWorkspace(
    runId: string,
    remoteUrl: string,
  ): Promise<PreparedWorkspace> {
    sanitizeRunId(runId);
    const validatedRemote = assertRemoteUrl(remoteUrl, this.allowLocalRemotes);
    const workspaceRoot = workspaceRootFor(this.dataRoot, runId);
    const hooksDir = hooksDisabledDirFor(this.dataRoot, runId);
    try {
      await mkdir(hooksDir, { recursive: true });
      await mkdir(workspaceRoot, { recursive: true });
      const realWorkspaceRoot = await realpath(workspaceRoot);
      const realHooksDir = await realpath(hooksDir);
      await runGit(this.gitBinary, realWorkspaceRoot, ["init"]);
      await runGit(this.gitBinary, realWorkspaceRoot, [
        "config",
        "core.hooksPath",
        realHooksDir,
      ]);
      await runGit(this.gitBinary, realWorkspaceRoot, [
        "config",
        "core.symlinks",
        "false",
      ]);
      const remotes = await runGit(this.gitBinary, realWorkspaceRoot, ["remote"]);
      if (remotes.split("\n").includes("origin")) {
        await runGit(this.gitBinary, realWorkspaceRoot, [
          "remote",
          "set-url",
          "origin",
          validatedRemote,
        ]);
      } else {
        await runGit(this.gitBinary, realWorkspaceRoot, [
          "remote",
          "add",
          "origin",
          validatedRemote,
        ]);
      }
      return {
        runId,
        workspaceRoot: realWorkspaceRoot,
        hooksDisabled: true,
      };
    } catch (error) {
      if (error instanceof IngestionError) {
        throw error;
      }
      throw new IngestionError(
        "WORKSPACE_PREPARATION_FAILED",
        "Failed to prepare immutable workspace",
      );
    }
  }

  async fetchRemote(workspace: PreparedWorkspace): Promise<void> {
    await runGit(this.gitBinary, workspace.workspaceRoot, [
      "fetch",
      "--prune",
      "origin",
    ]);
  }

  async checkoutDetachedCommit(
    workspace: PreparedWorkspace,
    commitSha: CommitSha,
  ): Promise<void> {
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
      throw new IngestionError("COMMIT_NOT_FOUND", "Commit SHA is malformed");
    }
    await runGit(this.gitBinary, workspace.workspaceRoot, [
      "checkout",
      "--detach",
      commitSha.toLowerCase(),
    ]);
  }

  async verifyHead(
    workspace: PreparedWorkspace,
    lockedSha: CommitSha,
  ): Promise<HeadVerification> {
    const raw = await runGit(this.gitBinary, workspace.workspaceRoot, [
      "rev-parse",
      "HEAD",
    ]);
    const headSha = CommitShaSchema.parse(raw);
    return {
      headSha,
      matchesLockedSha: headSha.toLowerCase() === lockedSha.toLowerCase(),
    };
  }

  async removeWorkspace(runId: string): Promise<void> {
    const safe = sanitizeRunId(runId);
    const runDir = path.resolve(this.dataRoot, "runs", safe);
    await rm(runDir, { recursive: true, force: true });
  }

  async readFile(
    workspace: PreparedWorkspace,
    relativePath: string,
  ): Promise<Buffer> {
    const target = resolveContained(workspace.workspaceRoot, relativePath);
    const real = await realpath(target);
    assertRealPathContained(workspace.workspaceRoot, real);
    return readFile(real);
  }

  async listFiles(workspace: PreparedWorkspace): Promise<readonly string[]> {
    const names: string[] = [];
    await this.walk(workspace.workspaceRoot, workspace.workspaceRoot, names);
    names.sort((a, b) => a.localeCompare(b));
    return names;
  }

  private async walk(
    root: string,
    current: string,
    names: string[],
  ): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git") {
        continue;
      }
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const real = await realpath(full);
        assertRealPathContained(root, real);
        continue;
      }
      if (entry.isDirectory()) {
        await this.walk(root, full, names);
        continue;
      }
      if (entry.isFile()) {
        names.push(path.relative(root, full).replaceAll("\\", "/"));
      }
    }
  }
}
