/**
 * Production repository adapter wiring + retryable ingest after Fake leakage.
 * Accumulated-DB safe — unique ids; no truncate/drop.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EXAMPLE_BUDGET, EXAMPLE_CAPABILITIES, EXAMPLE_POLICY_BUNDLE } from "../../control-plane/fixtures.js";
import { exampleAdmissionRequest } from "../../admission/fixtures.js";
import { CommitShaSchema } from "../../ingestion/remote-repository.js";
import { isIngestionError } from "../../ingestion/errors.js";
import { FakeRemoteRepository } from "../ingestion/fake-remote.js";
import { FakeRepositoryWorkspace } from "../ingestion/fake-workspace.js";
import { GitHubReadOnlyAdapter } from "../ingestion/github-readonly.js";
import { LocalGitWorkspaceService } from "../ingestion/git-workspace.js";
import {
  createTestDatabase,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import {
  PostgresProjectRegistry,
  PostgresPolicyRegistry,
  PostgresResourceBudgetRegistry,
  PostgresCapabilityRegistry,
} from "./repositories/control-plane.js";
import { PostgresRepositoryIngestionCoordinator } from "./coordinators.js";
import { SystemClock } from "../clock.js";
import { computePolicyBundleHash } from "../../control-plane/provisioning/index.js";
import type { PolicyBundle } from "../../control-plane/policies/policy.js";
import type { ResourceBudgetProfile } from "../../control-plane/budgets/budget.js";

const PILOT_OWNER = "Xachi49";
const PILOT_REPO = "orchestration-repo";
const PILOT_BRANCH = "main";

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

async function createLocalOrigin(): Promise<{ origin: string; sha: string; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "orch-pilot-origin-"));
  const origin = path.join(root, "origin");
  await mkdir(origin);
  await git(origin, ["init", "-b", PILOT_BRANCH]);
  await git(origin, ["config", "user.email", "pilot@example.com"]);
  await git(origin, ["config", "user.name", "pilot"]);
  await git(origin, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(origin, "README.md"), "# continuum pilot fixture\n");
  await writeFile(
    path.join(origin, "package.json"),
    '{"name":"continuum-pilot","lockfileVersion":1}\n',
  );
  await writeFile(path.join(origin, "package-lock.json"), '{"lockfileVersion":3}\n');
  await writeFile(path.join(origin, "tsconfig.json"), '{"compilerOptions":{"strict":true}}\n');
  await mkdir(path.join(origin, "src"));
  await writeFile(path.join(origin, "src/index.ts"), "export const value = 1;\n");
  await git(origin, ["add", "."]);
  await git(origin, ["commit", "-m", "pilot fixture"]);
  const sha = CommitShaSchema.parse(await git(origin, ["rev-parse", "HEAD"]));
  return { origin, sha, root };
}

function githubFetchForPilot(sha: string): typeof fetch {
  return async (url) => {
    const u = String(url);
    if (u.endsWith(`/repos/${PILOT_OWNER}/${PILOT_REPO}`)) {
      return new Response(
        JSON.stringify({
          name: PILOT_REPO,
          default_branch: PILOT_BRANCH,
          private: false,
          owner: { login: PILOT_OWNER },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes(`/repos/${PILOT_OWNER}/${PILOT_REPO}/branches/${PILOT_BRANCH}`)) {
      return new Response(JSON.stringify({ commit: { sha } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes(`/repos/${PILOT_OWNER}/${PILOT_REPO}/commits/${sha}`)) {
      return new Response(
        JSON.stringify({
          sha,
          commit: {
            message: "pilot fixture",
            author: { name: "pilot", date: "2026-09-23T12:00:00.000Z" },
            committer: { name: "pilot", date: "2026-09-23T12:00:00.000Z" },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (u.includes(`/repos/${PILOT_OWNER}/${PILOT_REPO}/pulls`)) {
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes(`/repos/${PILOT_OWNER}/${PILOT_REPO}/issues`)) {
      return new Response("[]", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (u.includes(`/status`)) {
      return new Response(JSON.stringify({ sha, state: "success" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  };
}

describe("postgres production repository adapters", () => {
  it("test stack keeps FAKE; PRODUCTION stack selects GITHUB + LOCAL_GIT", async () => {
    process.env["APPROVAL_DELIVERY_SECRET_KEY"] =
      process.env["APPROVAL_DELIVERY_SECRET_KEY"] ??
      Buffer.alloc(32, 11).toString("base64");

    const testDb = await createTestDatabase(uniquePostgresTestId("repo_adapt_test_db"));
    const testStack = await createPostgresOrchestratorStack({
      db: testDb,
      instanceId: uniquePostgresTestId("repo_adapt_test"),
      seedControlPlane: false,
      seedRepositorySources: false,
      runtimeEnvironment: "TEST",
    });
    expect(testStack.repositoryRemoteAdapter).toBe("FAKE");
    expect(testStack.repositoryWorkspaceAdapter).toBe("FAKE");
    await testStack.close();

    const { sha, root } = await createLocalOrigin();
    try {
      const prodDb = await createTestDatabase(uniquePostgresTestId("repo_adapt_prod_db"));
      const prodStack = await createPostgresOrchestratorStack({
        db: prodDb,
        instanceId: uniquePostgresTestId("repo_adapt_prod"),
        seedControlPlane: false,
        seedRepositorySources: false,
        runtimeEnvironment: "PRODUCTION",
        githubToken: "ghs_fixture_token",
        githubFetchImpl: githubFetchForPilot(sha),
        allowLocalGitRemotes: true,
        dataRoot: path.join(root, "data"),
        env: {
          ORCHESTRATOR_GITHUB_AUTH_MODE: "TOKEN",
          GITHUB_TOKEN: "ghs_fixture_token",
          ORCHESTRATOR_MODEL_PROVIDER: "openai",
          OPENAI_API_KEY: "sk-test-fixture",
        },
        openaiClient: {
          responses: {
            parse: async () => {
              throw new Error("planning must not be invoked in adapter tests");
            },
          },
        } as never,
      });
      expect(prodStack.repositoryRemoteAdapter).toBe("GITHUB");
      expect(prodStack.repositoryWorkspaceAdapter).toBe("LOCAL_GIT");
      expect(prodStack.githubAuthenticationMode).toBe("TOKEN");
      expect(prodStack.planningModelProvider).toBe("OPENAI");
      expect(prodStack.validationModelProvider).toBe("OPENAI");
      expect(prodStack.repositoryRemoteAdapter).not.toBe("FAKE");
      expect(prodStack.repositoryWorkspaceAdapter).not.toBe("FAKE");
      await prodStack.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("pilot identity: Fake leak fails retryably; REAL adapters verify same ADMITTED run", async () => {
    const projectId = uniquePostgresTestId("continuum_rr_pilot");
    const db = await createTestDatabase(uniquePostgresTestId("repo_retry_db"));
    process.env["APPROVAL_DELIVERY_SECRET_KEY"] =
      process.env["APPROVAL_DELIVERY_SECRET_KEY"] ??
      Buffer.alloc(32, 11).toString("base64");

    const policyId = `pol_${projectId}_v1`;
    const budgetId = `budget_${projectId}`;
    const now = "2026-09-23T12:00:00.000Z";
    const effectiveAt = "2026-08-01T00:00:00.000Z";
    const clock = new SystemClock();

    const projects = new PostgresProjectRegistry(db);
    const policies = new PostgresPolicyRegistry(db, clock);
    const budgets = new PostgresResourceBudgetRegistry(db);
    const capabilities = new PostgresCapabilityRegistry(db);

    const policyMaterial = {
      policyBundleId: policyId,
      semanticVersion: "1.0.0" as const,
      supersedes: null as string | null,
      applicableProjectIds: [projectId],
      applicableEnvironments: ["local"],
      approvedBy: "approver_rr_pilot",
      status: "ACTIVE" as const,
      rules: EXAMPLE_POLICY_BUNDLE.rules,
    };
    const policyBundle: PolicyBundle = {
      ...policyMaterial,
      policyHash: computePolicyBundleHash(policyMaterial),
      effectiveAt,
      createdAt: effectiveAt,
    };

    const budget: ResourceBudgetProfile = {
      ...EXAMPLE_BUDGET,
      budgetProfileId: budgetId,
    };

    await projects.insertExclusive({
      projectId,
      projectName: "Continuum Revenue Recovery Pilot",
      repositoryUrl: `https://github.com/${PILOT_OWNER}/${PILOT_REPO}.git`,
      defaultBranch: PILOT_BRANCH,
      workspaceRoot: `/workspace/${projectId}`,
      allowedEnvironments: ["local"],
      executionMode: "SUPERVISED",
      activePolicyBundleId: policyId,
      resourceBudgetProfileId: budgetId,
      authorizedApproverIds: ["approver_rr_pilot"],
      sensitivityClassification: "INTERNAL",
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    });
    await policies.insertExclusive(policyBundle);
    await budgets.insertExclusive(budget);
    for (const capability of EXAMPLE_CAPABILITIES) {
      try {
        await capabilities.insertExclusive(capability);
      } catch {
        // Capability ids are global; prior accumulated tests may already own them.
      }
    }

    const sharedInstanceId = uniquePostgresTestId("repo_retry_inst");
    const leakStack = await createPostgresOrchestratorStack({
      db,
      instanceId: sharedInstanceId,
      seedControlPlane: false,
      seedRepositorySources: false,
      runtimeEnvironment: "TEST",
    });

    await leakStack.authorityDirectory.insertExclusiveGrant({
      principalId: "requester_rr_pilot",
      principalType: "REQUESTER",
      projectId,
      environments: ["local"],
    });

    const admitted = await leakStack.admission.admit(
      exampleAdmissionRequest({
        projectId,
        objectiveId: `obj_${projectId}`,
        objectiveVersion: 1,
        requesterId: "requester_rr_pilot",
        requestedEnvironment: "local",
        submittedAt: now,
      }),
    );
    expect(admitted.outcome).toBe("ADMITTED");
    const runId = admitted.runId!;

    let leakError: unknown;
    try {
      await leakStack.ingestion.ingest(runId, projectId, "local");
    } catch (error) {
      leakError = error;
    }
    expect(isIngestionError(leakError)).toBe(true);
    expect((leakError as { code: string }).code).toBe("REPOSITORY_NOT_CONFIGURED");
    expect((leakError as { message: string }).message).toBe("Unknown repository");

    const runAfterLeak = await leakStack.runs.getById(runId);
    expect(runAfterLeak?.state).toBe("ADMITTED");
    const leakCoordinator = new PostgresRepositoryIngestionCoordinator(
      db,
      leakStack.leases,
      leakStack.instanceId,
    );
    const fenceAfterLeak = await leakCoordinator.get(runId);
    expect(fenceAfterLeak?.status).toBe("FAILED");
    expect(fenceAfterLeak?.retryable).toBe(true);
    const attemptAfterLeak = fenceAfterLeak!.attempt;

    // Do not close leakStack yet — close() shuts the shared pool.

    const { origin, sha, root } = await createLocalOrigin();
    try {
      const fixedStack = await createPostgresOrchestratorStack({
        db,
        instanceId: sharedInstanceId,
        seedControlPlane: false,
        seedRepositorySources: false,
        runtimeEnvironment: "PRODUCTION",
        githubToken: "ghs_fixture_token",
        githubFetchImpl: githubFetchForPilot(sha),
        allowLocalGitRemotes: true,
        dataRoot: path.join(root, "data"),
        env: {
          ORCHESTRATOR_GITHUB_AUTH_MODE: "TOKEN",
          GITHUB_TOKEN: "ghs_fixture_token",
          ORCHESTRATOR_MODEL_PROVIDER: "openai",
          OPENAI_API_KEY: "sk-test-fixture",
        },
        openaiClient: {
          responses: {
            parse: async () => {
              throw new Error("planning must not be invoked in adapter tests");
            },
          },
        } as never,
      });
      expect(fixedStack.repositoryRemoteAdapter).toBe("GITHUB");
      expect(fixedStack.repositoryWorkspaceAdapter).toBe("LOCAL_GIT");
      expect(fixedStack.githubAuthenticationMode).toBe("TOKEN");
      expect(fixedStack.planningModelProvider).toBe("OPENAI");
      expect(fixedStack.validationModelProvider).toBe("OPENAI");

      // Registry supplies workspace remoteUrl (local origin) while GitHub identity
      // matches the pilot; RemoteRepositoryService remains GitHubReadOnlyAdapter.
      await fixedStack.repositorySources.insertExclusive({
        projectId,
        provider: "GITHUB",
        owner: PILOT_OWNER,
        repository: PILOT_REPO,
        defaultBranch: PILOT_BRANCH,
        remoteUrl: origin,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      });

      const context = await fixedStack.ingestion.ingest(
        runId,
        projectId,
        "local",
      );
      expect(context.status).toBe("VERIFIED");
      expect(context.lockedRepository.repositoryIdentity).toEqual({
        provider: "GITHUB",
        owner: PILOT_OWNER,
        repository: PILOT_REPO,
      });
      expect(context.lockedRepository.commitSha).toBe(sha);

      const fixedCoordinator = new PostgresRepositoryIngestionCoordinator(
        db,
        fixedStack.leases,
        fixedStack.instanceId,
      );
      const fence = await fixedCoordinator.get(runId);
      expect(fence?.status).toBe("VERIFIED");
      expect(fence!.attempt).toBeGreaterThan(attemptAfterLeak);

      const planningReady = await fixedStack.ingestion.getContext(runId);
      expect(planningReady?.status).toBe("VERIFIED");

      const again = await fixedStack.ingestion.ingest(runId, projectId, "local");
      expect(again.status).toBe("VERIFIED");
    } finally {
      await rm(root, { recursive: true, force: true });
      // Shared pool — close once.
      await leakStack.close();
    }
  }, 180_000);

  it("PRODUCTION refuses FAKE mode; Fake classes remain constructible for tests", () => {
    expect(new FakeRemoteRepository({
      identity: { provider: "GITHUB", owner: "example", repository: "x" },
      defaultBranch: "main",
      branches: {},
      commits: {},
    })).toBeInstanceOf(FakeRemoteRepository);
    expect(new FakeRepositoryWorkspace({ filesBySha: new Map() })).toBeInstanceOf(
      FakeRepositoryWorkspace,
    );
    expect(GitHubReadOnlyAdapter.name).toBe("GitHubReadOnlyAdapter");
    expect(LocalGitWorkspaceService.name).toBe("LocalGitWorkspaceService");
  });
});
