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
  it("fails closed when credentials are unavailable", async () => {
    const adapter = new GitHubReadOnlyAdapter({ token: undefined });
    await expect(adapter.getRepositoryMetadata(REF)).rejects.toMatchObject({
      code: "REMOTE_AUTHENTICATION_FAILED",
    });
  });

  it("issues GET requests only and never includes the token in errors", async () => {
    const token = "ghs_test_token_do_not_log";
    const methods: string[] = [];
    const adapter = new GitHubReadOnlyAdapter({
      token,
      fetchImpl: async (_url, init) => {
        methods.push(String(init?.method));
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
    expect(methods).toEqual(["GET"]);
    expect(adapter.writesEnabled).toBe(false);
  });

  it("resolves a full branch head SHA", async () => {
    const adapter = new GitHubReadOnlyAdapter({
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
      token: "token",
      fetchImpl: async () => jsonResponse(404, { message: "Not Found" }),
    });
    await expect(adapter.resolveBranchHead(REF, "missing")).rejects.toMatchObject({
      code: "BRANCH_NOT_FOUND",
    });
  });

  it("does not expose mutation methods", () => {
    const adapter = new GitHubReadOnlyAdapter({ token: "token" });
    expect("createPullRequest" in adapter).toBe(false);
    expect("createIssue" in adapter).toBe(false);
    expect("push" in adapter).toBe(false);
    expect("mergePullRequest" in adapter).toBe(false);
    expect("executeRequest" in adapter).toBe(false);
  });
});
