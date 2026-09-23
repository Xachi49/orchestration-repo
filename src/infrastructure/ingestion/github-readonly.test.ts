import { describe, expect, it } from "vitest";
import { GitHubReadOnlyAdapter } from "./github-readonly.js";
import { IngestionError } from "../../ingestion/errors.js";
import { EXAMPLE_COMMIT_SHA } from "../../ingestion/fixtures.js";

const REF = { owner: "example", repository: "discord-scale-architect" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GitHubReadOnlyAdapter", () => {
  it("TOKEN mode fails closed when credentials are unavailable", () => {
    expect(
      () => new GitHubReadOnlyAdapter({ authMode: "TOKEN", token: undefined }),
    ).toThrow(IngestionError);
  });

  it("TOKEN mode sends Authorization and never includes the token in errors", async () => {
    const token = "ghs_test_token_do_not_log";
    const authHeaders: Array<string | null> = [];
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "TOKEN",
      token,
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        authHeaders.push(headers.get("Authorization"));
        return jsonResponse(401, { message: "bad credentials" });
      },
    });
    await expect(adapter.resolveBranchHead(REF, "main")).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof IngestionError &&
        error.code === "REMOTE_AUTHENTICATION_FAILED" &&
        !error.message.includes(token) &&
        !JSON.stringify(error).includes(token),
    );
    expect(authHeaders).toEqual([`Bearer ${token}`]);
    expect(adapter.recordedAuthorizationPresent).toEqual([true]);
    expect(adapter.recordedMethods).toEqual(["GET"]);
    expect(adapter.writesEnabled).toBe(false);
  });

  it("TOKEN mode 401/403 never falls back anonymously", async () => {
    let calls = 0;
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "TOKEN",
      token: "token",
      fetchImpl: async (_url, init) => {
        calls += 1;
        const headers = new Headers(init?.headers);
        expect(headers.has("Authorization")).toBe(true);
        return jsonResponse(403, {
          message: "Resource not accessible by personal access token",
        });
      },
    });
    await expect(adapter.getRepositoryMetadata(REF)).rejects.toMatchObject({
      code: "REMOTE_AUTHENTICATION_FAILED",
    });
    expect(calls).toBe(1);
    expect(adapter.recordedAuthorizationPresent).toEqual([true]);
  });

  it("PUBLIC_ANONYMOUS sends no Authorization header", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "PUBLIC_ANONYMOUS",
      token: "should-not-be-sent",
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.has("Authorization")).toBe(false);
        return jsonResponse(200, {
          name: REF.repository,
          default_branch: "main",
          private: false,
          owner: { login: REF.owner },
        });
      },
    });
    await adapter.getRepositoryMetadata(REF);
    expect(adapter.recordedAuthorizationPresent).toEqual([false]);
  });

  it("PUBLIC_ANONYMOUS succeeds for a public repository and continues snapshot reads", async () => {
    const paths: string[] = [];
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "PUBLIC_ANONYMOUS",
      fetchImpl: async (url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.has("Authorization")).toBe(false);
        paths.push(String(url));
        if (String(url).endsWith(`/repos/${REF.owner}/${REF.repository}`)) {
          return jsonResponse(200, {
            name: REF.repository,
            default_branch: "main",
            private: false,
            owner: { login: REF.owner },
          });
        }
        if (String(url).includes("/branches/main")) {
          return jsonResponse(200, { commit: { sha: EXAMPLE_COMMIT_SHA } });
        }
        return jsonResponse(404, { message: "Not Found" });
      },
    });
    const meta = await adapter.getRepositoryMetadata(REF);
    expect(meta.isPrivate).toBe(false);
    await expect(adapter.resolveBranchHead(REF, "main")).resolves.toBe(
      EXAMPLE_COMMIT_SHA,
    );
    expect(adapter.recordedAuthorizationPresent.every((v) => v === false)).toBe(
      true,
    );
    expect(paths.length).toBe(2);
  });

  it("PUBLIC_ANONYMOUS rejects a private repository", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "PUBLIC_ANONYMOUS",
      fetchImpl: async () =>
        jsonResponse(200, {
          name: REF.repository,
          default_branch: "main",
          private: true,
          owner: { login: REF.owner },
        }),
    });
    await expect(adapter.getRepositoryMetadata(REF)).rejects.toMatchObject({
      code: "REPOSITORY_NOT_CONFIGURED",
    });
  });

  it("PUBLIC_ANONYMOUS rejects when private field is missing", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "PUBLIC_ANONYMOUS",
      fetchImpl: async () =>
        jsonResponse(200, {
          name: REF.repository,
          default_branch: "main",
          owner: { login: REF.owner },
        }),
    });
    await expect(adapter.getRepositoryMetadata(REF)).rejects.toMatchObject({
      code: "REPOSITORY_NOT_CONFIGURED",
    });
  });

  it("resolves a full branch head SHA in TOKEN mode", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "TOKEN",
      token: "token",
      fetchImpl: async () =>
        jsonResponse(200, { commit: { sha: EXAMPLE_COMMIT_SHA } }),
    });
    await expect(adapter.resolveBranchHead(REF, "main")).resolves.toBe(
      EXAMPLE_COMMIT_SHA,
    );
  });

  it("fails closed when the branch is missing", async () => {
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "TOKEN",
      token: "token",
      fetchImpl: async () => jsonResponse(404, { message: "Not Found" }),
    });
    await expect(adapter.resolveBranchHead(REF, "missing")).rejects.toMatchObject({
      code: "BRANCH_NOT_FOUND",
    });
  });

  it("does not expose mutation methods", () => {
    const adapter = new GitHubReadOnlyAdapter({
      authMode: "TOKEN",
      token: "token",
    });
    expect("createPullRequest" in adapter).toBe(false);
    expect("createIssue" in adapter).toBe(false);
    expect("push" in adapter).toBe(false);
    expect("mergePullRequest" in adapter).toBe(false);
    expect("executeRequest" in adapter).toBe(false);
  });
});
