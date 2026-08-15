import { describe, expect, it } from "vitest";
import { InMemoryLockedRepositoryStore } from "./in-memory-locked-store.js";
import { EXAMPLE_COMMIT_SHA } from "../../ingestion/fixtures.js";
import { EXAMPLE_PROJECT_ID } from "../../control-plane/fixtures.js";
import { EXAMPLE_REPOSITORY_SOURCE } from "../../ingestion/fixtures.js";

describe("InMemoryLockedRepositoryStore", () => {
  it("rejects malformed locked state", async () => {
    const store = new InMemoryLockedRepositoryStore();
    await expect(
      store.save({
        runId: "run_1",
        projectId: EXAMPLE_PROJECT_ID,
        repositoryIdentity: {
          provider: "GITHUB",
          owner: EXAMPLE_REPOSITORY_SOURCE.owner,
          repository: EXAMPLE_REPOSITORY_SOURCE.repository,
        },
        branch: "main",
        commitSha: "short",
        lockedAt: "2026-08-14T12:00:00.000Z",
        remoteSnapshotHash: "hash",
        status: "LOCKED",
      }),
    ).rejects.toThrow();
  });

  it("persists a first lock", async () => {
    const store = new InMemoryLockedRepositoryStore();
    const saved = await store.save({
      runId: "run_1",
      projectId: EXAMPLE_PROJECT_ID,
      repositoryIdentity: {
        provider: "GITHUB",
        owner: EXAMPLE_REPOSITORY_SOURCE.owner,
        repository: EXAMPLE_REPOSITORY_SOURCE.repository,
      },
      branch: "main",
      commitSha: EXAMPLE_COMMIT_SHA,
      lockedAt: "2026-08-14T12:00:00.000Z",
      remoteSnapshotHash: "hash",
      status: "LOCKED",
    });
    expect((await store.getByRunId("run_1"))?.commitSha).toBe(saved.commitSha);
  });
});
