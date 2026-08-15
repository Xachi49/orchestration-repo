import { createHash } from "node:crypto";
import {
  IngestionFenceSchema,
  type BeginIngestionResult,
  type IngestionFence,
  type RepositoryIngestionCoordinator,
} from "../../ingestion/coordinator.js";
import { IngestionError } from "../../ingestion/errors.js";

/**
 * Process-local ingestion fence. Not distributed.
 * Durable stores must CAS status transitions uniquely per runId.
 */
export class InMemoryRepositoryIngestionCoordinator
  implements RepositoryIngestionCoordinator
{
  private readonly byRun = new Map<string, IngestionFence>();
  private tokenCounter = 0;

  async get(runId: string): Promise<IngestionFence | null> {
    return this.byRun.get(runId) ?? null;
  }

  async begin(runId: string, nowIso: string): Promise<BeginIngestionResult> {
    const current = this.byRun.get(runId);
    if (current?.status === "IN_PROGRESS") {
      throw new IngestionError(
        "INGESTION_IN_PROGRESS",
        `Ingestion is already in progress for run ${runId}`,
        { runId, attempt: current.attempt },
      );
    }
    if (current?.status === "VERIFIED") {
      return { outcome: "ALREADY_VERIFIED", fence: current };
    }
    if (current?.status === "FAILED" && current.retryable === false) {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Ingestion for run ${runId} failed and is not retryable`,
        { runId, failureCode: current.failureCode },
      );
    }

    this.tokenCounter += 1;
    const ownerToken = createHash("sha256")
      .update(`${runId}:${this.tokenCounter}:${nowIso}`)
      .digest("hex")
      .slice(0, 32);

    const attempt =
      current?.status === "FAILED" ? current.attempt + 1 : 1;

    const fence = IngestionFenceSchema.parse({
      runId,
      status: "IN_PROGRESS",
      attempt,
      ownerToken,
      lastUpdatedAt: nowIso,
      retryable: true,
    });
    this.byRun.set(runId, fence);
    return { outcome: "STARTED", fence, ownerToken };
  }

  async markVerified(
    runId: string,
    ownerToken: string,
    nowIso: string,
  ): Promise<IngestionFence> {
    const current = this.requireOwnedInProgress(runId, ownerToken);
    const fence = IngestionFenceSchema.parse({
      runId,
      status: "VERIFIED",
      attempt: current.attempt,
      lastUpdatedAt: nowIso,
      verifiedAt: nowIso,
      retryable: false,
    });
    this.byRun.set(runId, fence);
    return fence;
  }

  async markFailed(
    runId: string,
    ownerToken: string,
    failure: {
      failureCode: string;
      failedAt: string;
      retryable: boolean;
    },
  ): Promise<IngestionFence> {
    const current = this.requireOwnedInProgress(runId, ownerToken);
    const fence = IngestionFenceSchema.parse({
      runId,
      status: "FAILED",
      attempt: current.attempt,
      lastUpdatedAt: failure.failedAt,
      failureCode: failure.failureCode,
      failedAt: failure.failedAt,
      retryable: failure.retryable,
    });
    this.byRun.set(runId, fence);
    return fence;
  }

  async reconcileVerified(
    runId: string,
    nowIso: string,
  ): Promise<IngestionFence> {
    const current = this.byRun.get(runId);
    if (current?.status === "VERIFIED") {
      return current;
    }
    const fence = IngestionFenceSchema.parse({
      runId,
      status: "VERIFIED",
      attempt: current?.attempt ?? 1,
      lastUpdatedAt: nowIso,
      verifiedAt: nowIso,
      retryable: false,
    });
    this.byRun.set(runId, fence);
    return fence;
  }

  private requireOwnedInProgress(
    runId: string,
    ownerToken: string,
  ): IngestionFence {
    const current = this.byRun.get(runId);
    if (!current || current.status !== "IN_PROGRESS") {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Ingestion fence for run ${runId} is not IN_PROGRESS`,
        { runId, status: current?.status },
      );
    }
    if (current.ownerToken !== ownerToken) {
      throw new IngestionError(
        "INVALID_INGESTION_STATE",
        `Ingestion ownership mismatch for run ${runId}`,
        { runId },
      );
    }
    return current;
  }
}
