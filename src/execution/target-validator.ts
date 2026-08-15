import path from "node:path";
import { ExecutionError } from "./errors.js";

const PROTECTED_PATH_PREFIXES = [
  ".git",
  ".env",
  "credentials",
  "secrets",
] as const;

const PROTECTED_EXACT = new Set([
  ".env",
  ".gitignore",
  "policy-authority.json",
  "capability-authority.json",
  "approval-records.json",
  "authorization-records.json",
  "run-state.json",
]);

const PROTECTED_SEGMENTS = new Set([
  ".git",
  "node_modules",
]);

/**
 * Path containment + protected-target rules for Phase 7.
 * Rejects absolute paths, traversal, symlink-style escapes, and authority files.
 */
export class ExecutionTargetValidator {
  normalizeRelative(raw: string): string {
    const normalized = raw.replaceAll("\\", "/").replace(/^\.\//, "");
    if (
      normalized.length === 0 ||
      normalized.includes("\0") ||
      path.isAbsolute(normalized) ||
      normalized.startsWith("/") ||
      normalized.split("/").includes("..")
    ) {
      throw new ExecutionError(
        "EXECUTION_TARGET_INVALID",
        `Target path is not a contained relative path: ${raw}`,
        { path: raw },
      );
    }
    return normalized;
  }

  assertNotProtected(relativePath: string): void {
    const normalized = this.normalizeRelative(relativePath);
    const lower = normalized.toLowerCase();
    const base = path.posix.basename(lower);
    const segments = lower.split("/");

    if (PROTECTED_EXACT.has(base) || PROTECTED_EXACT.has(lower)) {
      throw new ExecutionError(
        "EXECUTION_TARGET_PROTECTED",
        `Target path is protected: ${relativePath}`,
        { path: relativePath },
      );
    }
    if (base.startsWith(".env.")) {
      throw new ExecutionError(
        "EXECUTION_TARGET_PROTECTED",
        `Environment credential path is protected: ${relativePath}`,
        { path: relativePath },
      );
    }
    for (const prefix of PROTECTED_PATH_PREFIXES) {
      if (lower === prefix || lower.startsWith(`${prefix}/`) || lower.startsWith(`${prefix}.`)) {
        throw new ExecutionError(
          "EXECUTION_TARGET_PROTECTED",
          `Target path is protected: ${relativePath}`,
          { path: relativePath },
        );
      }
    }
    for (const segment of segments) {
      if (PROTECTED_SEGMENTS.has(segment)) {
        throw new ExecutionError(
          "EXECUTION_TARGET_PROTECTED",
          `Target path contains a protected segment: ${relativePath}`,
          { path: relativePath },
        );
      }
    }
  }

  resolveContained(workspaceRoot: string, relativePath: string): string {
    const normalized = this.normalizeRelative(relativePath);
    this.assertNotProtected(normalized);
    const rootResolved = path.resolve(workspaceRoot);
    const resolved = path.resolve(rootResolved, normalized);
    if (
      resolved !== rootResolved &&
      !resolved.startsWith(rootResolved + path.sep)
    ) {
      throw new ExecutionError(
        "EXECUTION_TARGET_INVALID",
        `Path escapes the workspace: ${relativePath}`,
        { path: relativePath },
      );
    }
    return resolved;
  }

  validateTargets(
    workspaceRoot: string,
    targets: readonly string[],
  ): string[] {
    return targets.map((target) => {
      this.resolveContained(workspaceRoot, target);
      return this.normalizeRelative(target);
    });
  }
}
