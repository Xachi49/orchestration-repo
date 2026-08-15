import { describe, expect, it } from "vitest";
import { InMemoryRepositoryIngestionCoordinator } from "./in-memory-ingestion-coordinator.js";
import { IngestionError } from "../../ingestion/errors.js";

describe("InMemoryRepositoryIngestionCoordinator", () => {
  const now = "2026-08-14T12:00:00.000Z";

  it("starts the first ingestion and fences concurrent begins", async () => {
    const coordinator = new InMemoryRepositoryIngestionCoordinator();
    const first = await coordinator.begin("run_1", now);
    expect(first.outcome).toBe("STARTED");
    if (first.outcome !== "STARTED") {
      throw new Error("expected STARTED");
    }
    expect(first.fence.status).toBe("IN_PROGRESS");
    expect(first.fence.attempt).toBe(1);

    await expect(coordinator.begin("run_1", now)).rejects.toMatchObject({
      code: "INGESTION_IN_PROGRESS",
    });
  });

  it("marks VERIFIED and returns ALREADY_VERIFIED on later begins", async () => {
    const coordinator = new InMemoryRepositoryIngestionCoordinator();
    const started = await coordinator.begin("run_1", now);
    if (started.outcome !== "STARTED") {
      throw new Error("expected STARTED");
    }
    await coordinator.markVerified("run_1", started.ownerToken, now);
    const again = await coordinator.begin("run_1", now);
    expect(again.outcome).toBe("ALREADY_VERIFIED");
  });

  it("marks FAILED and allows FAILED → IN_PROGRESS retry with incremented attempt", async () => {
    const coordinator = new InMemoryRepositoryIngestionCoordinator();
    const started = await coordinator.begin("run_1", now);
    if (started.outcome !== "STARTED") {
      throw new Error("expected STARTED");
    }
    await coordinator.markFailed("run_1", started.ownerToken, {
      failureCode: "LOCKED_SHA_MISMATCH",
      failedAt: now,
      retryable: true,
    });
    const failed = await coordinator.get("run_1");
    expect(failed?.status).toBe("FAILED");
    expect(failed?.attempt).toBe(1);
    expect(failed?.failureCode).toBe("LOCKED_SHA_MISMATCH");

    const retry = await coordinator.begin("run_1", now);
    expect(retry.outcome).toBe("STARTED");
    if (retry.outcome !== "STARTED") {
      throw new Error("expected STARTED");
    }
    expect(retry.fence.attempt).toBe(2);
    expect(retry.fence.status).toBe("IN_PROGRESS");
  });

  it("rejects ownership mismatches for markVerified/markFailed", async () => {
    const coordinator = new InMemoryRepositoryIngestionCoordinator();
    await coordinator.begin("run_1", now);
    await expect(
      coordinator.markVerified("run_1", "wrong-token", now),
    ).rejects.toBeInstanceOf(IngestionError);
  });

  it("reconciles to VERIFIED after a crash mid-fence", async () => {
    const coordinator = new InMemoryRepositoryIngestionCoordinator();
    const started = await coordinator.begin("run_1", now);
    if (started.outcome !== "STARTED") {
      throw new Error("expected STARTED");
    }
    const reconciled = await coordinator.reconcileVerified("run_1", now);
    expect(reconciled.status).toBe("VERIFIED");
  });
});
