import { describe, expect, it } from "vitest";
import { InMemoryProjectLockService } from "../infrastructure/admission/in-memory-project-lock.js";

describe("Project locking", () => {
  const base = {
    projectId: "proj_1",
    lockOwner: "user_1",
    acquiredAt: "2026-08-14T12:00:00.000Z",
    expiresAt: "2026-08-14T13:00:00.000Z",
  };

  it("acquires a lock on a free project", async () => {
    const locks = new InMemoryProjectLockService();
    const result = await locks.acquire({ ...base, runId: "run_1" });
    expect(result.result).toBe("LOCK_ACQUIRED");
    expect(await locks.getActiveLock("proj_1")).toMatchObject({ runId: "run_1" });
  });

  it("recognizes a lock already owned by the same run", async () => {
    const locks = new InMemoryProjectLockService();
    await locks.acquire({ ...base, runId: "run_1" });
    const again = await locks.acquire({ ...base, runId: "run_1" });
    expect(again.result).toBe("LOCK_ALREADY_OWNED");
  });

  it("conflicts when a different run holds the lock", async () => {
    const locks = new InMemoryProjectLockService();
    await locks.acquire({ ...base, runId: "run_1" });
    const conflict = await locks.acquire({ ...base, runId: "run_2" });
    expect(conflict.result).toBe("RESOURCE_CONFLICT");
  });

  it("does not treat a failed lock lookup as permission to acquire", async () => {
    const locks = new InMemoryProjectLockService();
    locks.failNextLookups(true);
    const result = await locks.acquire({ ...base, runId: "run_1" });
    expect(result.result).not.toBe("LOCK_ACQUIRED");
    expect(result.result).toBe("RESOURCE_CONFLICT");
    locks.failNextLookups(false);
    expect(await locks.getActiveLock("proj_1")).toBeNull();
  });
});
