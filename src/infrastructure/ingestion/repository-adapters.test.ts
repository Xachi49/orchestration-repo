import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  resolveGitHubAuthMode,
  resolveRepositoryAdapterMode,
  selectRepositoryInfrastructure,
  RepositoryAdapterSelectionError,
} from "./repository-adapters.js";
import { FakeRemoteRepository } from "./fake-remote.js";
import { FakeRepositoryWorkspace } from "./fake-workspace.js";
import { GitHubReadOnlyAdapter } from "./github-readonly.js";
import { LocalGitWorkspaceService } from "./git-workspace.js";
import { EXAMPLE_COMMIT_SHA } from "../../ingestion/fixtures.js";

describe("repository adapter selection", () => {
  const dataRoot = mkdtempSync(path.join(tmpdir(), "orch-repo-adapters-"));

  it("PRODUCTION defaults to REAL and rejects FAKE", () => {
    expect(
      resolveRepositoryAdapterMode({
        runtimeEnvironment: "PRODUCTION",
        env: {},
      }),
    ).toBe("REAL");
    expect(() =>
      resolveRepositoryAdapterMode({
        runtimeEnvironment: "PRODUCTION",
        mode: "FAKE",
        env: {},
      }),
    ).toThrow(RepositoryAdapterSelectionError);
    expect(() =>
      resolveRepositoryAdapterMode({
        runtimeEnvironment: "PRODUCTION",
        env: { ORCHESTRATOR_REPOSITORY_ADAPTER_MODE: "FAKE" },
      }),
    ).toThrow(/FAKE REPOSITORY/);
  });

  it("non-production defaults to FAKE fixtures", () => {
    expect(
      resolveRepositoryAdapterMode({
        runtimeEnvironment: "TEST",
        env: {},
      }),
    ).toBe("FAKE");
    const selected = selectRepositoryInfrastructure({
      runtimeEnvironment: "TEST",
      dataRoot,
      env: {},
    });
    expect(selected.remoteAdapter).toBe("FAKE");
    expect(selected.workspaceAdapter).toBe("FAKE");
    expect(selected.githubAuthenticationMode).toBeNull();
    expect(selected.remote).toBeInstanceOf(FakeRemoteRepository);
    expect(selected.workspace).toBeInstanceOf(FakeRepositoryWorkspace);
  });

  it("PRODUCTION requires explicit GitHub auth mode", () => {
    expect(() =>
      resolveGitHubAuthMode({
        runtimeEnvironment: "PRODUCTION",
        env: {},
      }),
    ).toThrow(/ORCHESTRATOR_GITHUB_AUTH_MODE/);
    expect(() =>
      selectRepositoryInfrastructure({
        runtimeEnvironment: "PRODUCTION",
        dataRoot,
        env: { GITHUB_TOKEN: "ghs_fixture_token" },
      }),
    ).toThrow(/ORCHESTRATOR_GITHUB_AUTH_MODE/);
  });

  it("TOKEN mode requires GITHUB_TOKEN; PUBLIC_ANONYMOUS does not", () => {
    expect(() =>
      selectRepositoryInfrastructure({
        runtimeEnvironment: "PRODUCTION",
        dataRoot,
        env: { ORCHESTRATOR_GITHUB_AUTH_MODE: "TOKEN" },
      }),
    ).toThrow(/GITHUB_TOKEN/);

    const tokenSelected = selectRepositoryInfrastructure({
      runtimeEnvironment: "PRODUCTION",
      dataRoot,
      env: {
        ORCHESTRATOR_GITHUB_AUTH_MODE: "TOKEN",
        GITHUB_TOKEN: "ghs_fixture_token",
      },
    });
    expect(tokenSelected.remoteAdapter).toBe("GITHUB");
    expect(tokenSelected.workspaceAdapter).toBe("LOCAL_GIT");
    expect(tokenSelected.githubAuthenticationMode).toBe("TOKEN");
    expect(tokenSelected.remote).toBeInstanceOf(GitHubReadOnlyAdapter);
    expect(tokenSelected.workspace).toBeInstanceOf(LocalGitWorkspaceService);
    expect(tokenSelected.remote).not.toBeInstanceOf(FakeRemoteRepository);

    const anon = selectRepositoryInfrastructure({
      runtimeEnvironment: "PRODUCTION",
      dataRoot,
      env: { ORCHESTRATOR_GITHUB_AUTH_MODE: "PUBLIC_ANONYMOUS" },
    });
    expect(anon.githubAuthenticationMode).toBe("PUBLIC_ANONYMOUS");
    expect(anon.remote).toBeInstanceOf(GitHubReadOnlyAdapter);
    expect(anon.remote).not.toBeInstanceOf(FakeRemoteRepository);
  });

  it("never falls back from GitHub failure to FakeRemote", async () => {
    const selected = selectRepositoryInfrastructure({
      runtimeEnvironment: "PRODUCTION",
      dataRoot,
      githubAuthMode: "TOKEN",
      githubToken: "token",
      githubFetchImpl: async () =>
        new Response(JSON.stringify({ message: "boom" }), { status: 500 }),
      env: { ORCHESTRATOR_GITHUB_AUTH_MODE: "TOKEN" },
    });
    await expect(
      selected.remote.getRepositoryMetadata({
        owner: "Xachi49",
        repository: "orchestration-repo",
      }),
    ).rejects.toMatchObject({ code: "REMOTE_REPOSITORY_UNAVAILABLE" });
    expect(selected.remote).toBeInstanceOf(GitHubReadOnlyAdapter);
  });

  it("pilot identity reaches GitHub adapter with exact owner/repository", async () => {
    const seen: string[] = [];
    const selected = selectRepositoryInfrastructure({
      runtimeEnvironment: "PRODUCTION",
      dataRoot,
      githubAuthMode: "PUBLIC_ANONYMOUS",
      githubFetchImpl: async (url) => {
        seen.push(String(url));
        if (String(url).endsWith("/repos/Xachi49/orchestration-repo")) {
          return new Response(
            JSON.stringify({
              name: "orchestration-repo",
              default_branch: "main",
              private: false,
              owner: { login: "Xachi49" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (String(url).includes("/branches/main")) {
          return new Response(
            JSON.stringify({ commit: { sha: EXAMPLE_COMMIT_SHA } }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 404 });
      },
      env: { ORCHESTRATOR_GITHUB_AUTH_MODE: "PUBLIC_ANONYMOUS" },
    });
    expect(selected.githubAuthenticationMode).toBe("PUBLIC_ANONYMOUS");
    const meta = await selected.remote.getRepositoryMetadata({
      owner: "Xachi49",
      repository: "orchestration-repo",
    });
    expect(meta.identity).toEqual({
      provider: "GITHUB",
      owner: "Xachi49",
      repository: "orchestration-repo",
    });
    const sha = await selected.remote.resolveBranchHead(
      { owner: "Xachi49", repository: "orchestration-repo" },
      "main",
    );
    expect(sha).toBe(EXAMPLE_COMMIT_SHA);
    expect(seen.some((u) => u.includes("/repos/Xachi49/orchestration-repo"))).toBe(
      true,
    );
  });
});
