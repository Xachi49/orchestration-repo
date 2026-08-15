import { describe, expect, it } from "vitest";
import { createLocalIngestionStack } from "../infrastructure/ingestion/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_COMMIT_SHA,
  EXAMPLE_DRIFT_SHA,
  EXAMPLE_REPOSITORY_SOURCE,
} from "./fixtures.js";
import { EXAMPLE_ENVIRONMENT, EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";
import { IngestionError } from "./errors.js";
import { DeterministicProjectIndexer } from "./indexer.js";
import { DeterministicRepositoryFingerprintService } from "./fingerprint.js";
import { InMemoryRepositorySourceRegistry } from "../infrastructure/ingestion/in-memory-source-registry.js";
import { RepositoryTruthService } from "./service.js";
import { FakeRemoteRepository } from "../infrastructure/ingestion/fake-remote.js";
import type { ProjectIndexer } from "./index-model.js";
import { isVerifiedReadyForPlanning } from "./context.js";

async function admitRun() {
  const stack = createLocalIngestionStack();
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  return { stack, runId: admitted.runId };
}

describe("RepositoryTruthService", () => {
  it("resolves the repository, locks the exact SHA, and verifies context", async () => {
    const { stack, runId } = await admitRun();
    const context = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(context.status).toBe("VERIFIED");
    expect(context.verifiedAt).toBe(stack.clock.nowIso());
    expect(context.lockedRepository.commitSha).toBe(EXAMPLE_COMMIT_SHA);
    expect(context.remoteSnapshot.resolvedCommitSha).toBe(EXAMPLE_COMMIT_SHA);
    expect(context.lockedRepository.status).toBe("VERIFIED");
    expect(context.projectIndex.commitSha).toBe(EXAMPLE_COMMIT_SHA);
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("INGESTING");
    const fence = await stack.coordinator.get(runId);
    expect(fence?.status).toBe("VERIFIED");
  });

  it("does not silently replace a locked SHA when the branch moves", async () => {
    const { stack, runId } = await admitRun();
    await stack.locks.save({
      runId,
      projectId: EXAMPLE_PROJECT_ID,
      repositoryIdentity: {
        provider: "GITHUB",
        owner: EXAMPLE_REPOSITORY_SOURCE.owner,
        repository: EXAMPLE_REPOSITORY_SOURCE.repository,
      },
      branch: "main",
      commitSha: EXAMPLE_COMMIT_SHA,
      lockedAt: stack.clock.nowIso(),
      remoteSnapshotHash: "prelocked",
      status: "LOCKED",
    });
    stack.remote.setBranchHead("main", EXAMPLE_DRIFT_SHA);
    const context = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(context.lockedRepository.commitSha).toBe(EXAMPLE_COMMIT_SHA);
    expect(context.remoteSnapshot.resolvedCommitSha).toBe(EXAMPLE_COMMIT_SHA);
  });

  it("reports drift without replacing the locked SHA and STALE is not planning-ready", async () => {
    const { stack, runId } = await admitRun();
    const context = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(
      isVerifiedReadyForPlanning({
        context,
        liveLockedState: await stack.locks.getByRunId(runId),
      }),
    ).toBe(true);

    stack.remote.setBranchHead("main", EXAMPLE_DRIFT_SHA);
    const drift = await stack.ingestion.detectDrift(runId);
    expect(drift.result).toBe("DRIFT_DETECTED");
    const locked = await stack.locks.getByRunId(runId);
    expect(locked?.commitSha).toBe(EXAMPLE_COMMIT_SHA);
    expect(locked?.status).toBe("STALE");
    expect(context.lockedRepository.commitSha).toBe(EXAMPLE_COMMIT_SHA);
    expect(
      isVerifiedReadyForPlanning({
        context: await stack.ingestion.getContext(runId),
        liveLockedState: locked,
      }),
    ).toBe(false);
  });

  it("returns CURRENT when the remote head still matches the lock", async () => {
    const { stack, runId } = await admitRun();
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    const drift = await stack.ingestion.detectDrift(runId);
    expect(drift).toEqual({
      result: "CURRENT",
      lockedSha: EXAMPLE_COMMIT_SHA,
      remoteSha: EXAMPLE_COMMIT_SHA,
    });
  });

  it("fails closed when the repository source is disabled", async () => {
    const stack = createLocalIngestionStack();
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    const ingestion = new RepositoryTruthService({
      runs: stack.runs,
      controlPlane: stack.controlPlane,
      sources: new InMemoryRepositorySourceRegistry([
        { ...EXAMPLE_REPOSITORY_SOURCE, enabled: false },
      ]),
      remote: stack.remote,
      locks: stack.locks,
      workspace: stack.workspace,
      indexer: new DeterministicProjectIndexer(),
      fingerprints: new DeterministicRepositoryFingerprintService(),
      indexStore: stack.indexStore,
      evidence: stack.evidence,
      contexts: stack.contexts,
      coordinator: stack.coordinator,
      clock: stack.clock,
    });
    await expect(
      ingestion.ingest(admitted.runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "REPOSITORY_NOT_CONFIGURED" });
  });

  it("fails closed when the branch is missing", async () => {
    const stack = createLocalIngestionStack({
      remote: new FakeRemoteRepository({
        identity: {
          provider: "GITHUB",
          owner: EXAMPLE_REPOSITORY_SOURCE.owner,
          repository: EXAMPLE_REPOSITORY_SOURCE.repository,
        },
        defaultBranch: "main",
        branches: {},
        commits: {},
      }),
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    await expect(
      stack.ingestion.ingest(admitted.runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "BRANCH_NOT_FOUND" });
    const fence = await stack.coordinator.get(admitted.runId);
    expect(fence?.status).toBe("FAILED");
    expect(await stack.contexts.getByRunId(admitted.runId)).toBeNull();
  });

  it("fails closed on remote authentication failure", async () => {
    const { stack, runId } = await admitRun();
    stack.remote.setAuthFailed(true);
    await expect(
      stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "REMOTE_AUTHENTICATION_FAILED" });
  });

  it("fails closed when the remote is unavailable", async () => {
    const { stack, runId } = await admitRun();
    stack.remote.setUnavailable(true);
    await expect(
      stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "REMOTE_REPOSITORY_UNAVAILABLE" });
  });

  it("fails closed from an ineligible run state", async () => {
    const { stack, runId } = await admitRun();
    const run = await stack.runs.getById(runId);
    if (!run) {
      throw new Error("missing run");
    }
    await stack.runs.save({ ...run, state: "PLANNING" });
    await expect(
      stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toBeInstanceOf(IngestionError);
  });

  it("records repository evidence as verified, never SYSTEM_AUTHORITY", async () => {
    const { stack, runId } = await admitRun();
    const context = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    const records = await stack.evidence.listByRunId(runId);
    expect(records.length).toBe(context.evidenceIds.length);
    expect(records.every((record) => record.commitSha === EXAMPLE_COMMIT_SHA)).toBe(
      true,
    );
    expect(
      records.every(
        (record) =>
          record.trustLevel === "REMOTE_VERIFIED" ||
          record.trustLevel === "LOCAL_VERIFIED",
      ),
    ).toBe(true);
    expect(records.some((record) => record.trustLevel === "SYSTEM_AUTHORITY")).toBe(
      false,
    );
    const readme = records.find(
      (record) => record.sourcePath === "README.md",
    );
    const indexed = context.projectIndex.fileManifest.entries.find(
      (entry) => entry.relativePath === "README.md",
    );
    expect(readme?.contentHash).toBe(indexed?.contentHash);
  });

  it("reuses a cached index for the same commit and index configuration", async () => {
    const inner = new DeterministicProjectIndexer();
    const counting: ProjectIndexer & { calls: number } = {
      calls: 0,
      index(input) {
        this.calls += 1;
        return inner.index(input);
      },
    };
    const stack = createLocalIngestionStack({ indexer: counting });
    const first = await stack.admission.admit(exampleAdmissionRequest());
    const second = await stack.admission.admit(
      exampleAdmissionRequest({ objectiveId: "obj_phase3_second" }),
    );
    if (first.outcome !== "ADMITTED" || second.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    await stack.ingestion.ingest(first.runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.ingestion.ingest(second.runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    expect(counting.calls).toBe(1);
  });

  it("fails HEAD verification when the workspace does not match the lock", async () => {
    const { stack, runId } = await admitRun();
    stack.workspace.forceHeadMismatch(runId);
    await expect(
      stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "LOCKED_SHA_MISMATCH" });
  });

  it("rejects a concurrent ingestion while IN_PROGRESS", async () => {
    const { stack, runId } = await admitRun();
    await stack.coordinator.begin(runId, stack.clock.nowIso());
    await expect(
      stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "INGESTION_IN_PROGRESS" });
  });

  it("creates exactly one VERIFIED context and reuses it without duplicate evidence", async () => {
    const { stack, runId } = await admitRun();
    const first = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    const evidenceAfterFirst = (await stack.evidence.listByRunId(runId)).length;
    const second = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(second).toEqual(first);
    expect(second.status).toBe("VERIFIED");
    expect((await stack.evidence.listByRunId(runId)).length).toBe(
      evidenceAfterFirst,
    );
    const fence = await stack.coordinator.get(runId);
    expect(fence?.status).toBe("VERIFIED");
    expect(fence?.attempt).toBe(1);
  });

  it("marks FAILED without VERIFIED context and allows an explicit retry", async () => {
    const { stack, runId } = await admitRun();
    stack.workspace.forceHeadMismatch(runId);
    await expect(
      stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
    ).rejects.toMatchObject({ code: "LOCKED_SHA_MISMATCH" });

    const failedFence = await stack.coordinator.get(runId);
    expect(failedFence?.status).toBe("FAILED");
    expect(failedFence?.attempt).toBe(1);
    expect(failedFence?.failureCode).toBe("LOCKED_SHA_MISMATCH");
    expect(failedFence?.retryable).toBe(true);
    expect(await stack.contexts.getByRunId(runId)).toBeNull();
    expect(await stack.ingestion.getContext(runId)).toBeNull();

    const context = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(context.status).toBe("VERIFIED");
    const fence = await stack.coordinator.get(runId);
    expect(fence?.status).toBe("VERIFIED");
    expect(fence?.attempt).toBe(2);
  });

  it("reconciles the fence to VERIFIED when a verified context already exists", async () => {
    const { stack, runId } = await admitRun();
    const context = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    const fences = (
      stack.coordinator as unknown as {
        byRun: Map<string, { runId: string; status: string; attempt: number; ownerToken?: string; lastUpdatedAt: string; retryable?: boolean }>;
      }
    ).byRun;
    fences.set(runId, {
      runId,
      status: "IN_PROGRESS",
      attempt: 1,
      ownerToken: "stale-owner",
      lastUpdatedAt: stack.clock.nowIso(),
      retryable: true,
    });
    const again = await stack.ingestion.ingest(
      runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(again).toEqual(context);
    expect((await stack.coordinator.get(runId))?.status).toBe("VERIFIED");
  });
});
