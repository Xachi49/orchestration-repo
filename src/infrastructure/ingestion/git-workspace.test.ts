import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LocalGitWorkspaceService } from "./git-workspace.js";
import { IngestionError } from "../../ingestion/errors.js";
import { CommitShaSchema } from "../../ingestion/remote-repository.js";

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        PATH: process.env["PATH"] ?? "/usr/bin:/bin",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      if (code === 0) {
        resolve(out);
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8") || out));
    });
  });
}

describe("LocalGitWorkspaceService", () => {
  it(
    "checks out a detached SHA, disables hooks, and verifies HEAD",
    async () => {
    const root = await mkdtemp(path.join(tmpdir(), "orch-git-"));
    try {
      const origin = path.join(root, "origin");
      await mkdir(origin);
      await git(origin, ["init", "-b", "main"]);
      await git(origin, ["config", "user.email", "test@example.com"]);
      await git(origin, ["config", "user.name", "test"]);
      await git(origin, ["config", "commit.gpgsign", "false"]);
      await writeFile(path.join(origin, "README.md"), "# fixture\n");
      await git(origin, ["add", "README.md"]);
      await git(origin, ["commit", "-m", "init"]);
      const sha = CommitShaSchema.parse(await git(origin, ["rev-parse", "HEAD"]));

      const workspace = new LocalGitWorkspaceService({
        dataRoot: path.join(root, "data"),
        allowLocalRemotes: true,
      });
      const prepared = await workspace.prepareWorkspace("run_git_1", origin);
      expect(prepared.hooksDisabled).toBe(true);
      await workspace.fetchRemote(prepared);
      await workspace.checkoutDetachedCommit(prepared, sha);
      const head = await workspace.verifyHead(prepared, sha);
      expect(head.matchesLockedSha).toBe(true);
      expect(head.headSha).toBe(sha);

      const hooksPath = await git(prepared.workspaceRoot, [
        "config",
        "--get",
        "core.hooksPath",
      ]);
      expect(hooksPath.length).toBeGreaterThan(0);

      const files = await workspace.listFiles(prepared);
      expect(files).toContain("README.md");
      const content = await workspace.readFile(prepared, "README.md");
      expect(content.toString("utf8")).toContain("fixture");

      await expect(
        workspace.readFile(prepared, "../secret"),
      ).rejects.toBeInstanceOf(IngestionError);

      const otherSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      const mismatch = await workspace.verifyHead(prepared, otherSha);
      expect(mismatch.matchesLockedSha).toBe(false);

      await workspace.removeWorkspace("run_git_1");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    },
    20_000,
  );

  it("does not implement pull, merge, or a generic command API", () => {
    const workspace = new LocalGitWorkspaceService({
      dataRoot: "/tmp/unused",
    });
    expect("runCommand" in workspace).toBe(false);
    expect("pull" in workspace).toBe(false);
    expect("merge" in workspace).toBe(false);
    expect("rebase" in workspace).toBe(false);
    const source = readFileSync(new URL("./git-workspace.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/["']pull["']/);
    expect(source).not.toMatch(/["']merge["']/);
    expect(source).not.toMatch(/["']rebase["']/);
    expect(source).not.toMatch(/runCommand\(/);
    expect(source).not.toMatch("shell: true");
  });
});
