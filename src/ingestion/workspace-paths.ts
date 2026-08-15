import path from "node:path";
import { IngestionError } from "./errors.js";

const SAFE_RUN_ID = /^[A-Za-z0-9_-]+$/;
const SAFE_GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

export function sanitizeRunId(runId: string): string {
  if (!SAFE_RUN_ID.test(runId)) {
    throw new IngestionError(
      "WORKSPACE_PATH_VIOLATION",
      "runId is not a safe workspace identifier",
      { runId },
    );
  }
  return runId;
}

export function assertSafeGitHubName(value: string, field: string): string {
  if (!SAFE_GITHUB_NAME.test(value)) {
    throw new IngestionError(
      "WORKSPACE_PATH_VIOLATION",
      `${field} contains unsupported characters`,
      { field },
    );
  }
  return value;
}

export function workspaceRootFor(dataRoot: string, runId: string): string {
  return path.resolve(dataRoot, "runs", sanitizeRunId(runId), "workspace");
}

export function hooksDisabledDirFor(dataRoot: string, runId: string): string {
  return path.resolve(dataRoot, "runs", sanitizeRunId(runId), "hooks-disabled");
}

/**
 * Resolve a relative path inside root. Rejects absolute paths, NUL, and `..`.
 * Does not follow symlinks; callers must realpath-check after IO.
 */
export function resolveContained(root: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    path.isAbsolute(normalized) ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..")
  ) {
    throw new IngestionError(
      "WORKSPACE_PATH_VIOLATION",
      `Path is not contained in the workspace: ${relativePath}`,
    );
  }
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, normalized);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new IngestionError(
      "WORKSPACE_PATH_VIOLATION",
      `Path escapes the workspace: ${relativePath}`,
    );
  }
  return resolved;
}

export function assertRealPathContained(
  root: string,
  realPath: string,
): void {
  const rootResolved = path.resolve(root);
  const normalized = path.resolve(realPath);
  if (
    normalized !== rootResolved &&
    !normalized.startsWith(rootResolved + path.sep)
  ) {
    throw new IngestionError(
      "WORKSPACE_PATH_VIOLATION",
      "Resolved path escapes the workspace",
    );
  }
}
