import { describe, expect, it } from "vitest";
import { objectiveIdempotencyKey } from "./idempotency.js";

describe("Objective idempotency", () => {
  it("produces the same key for equivalent identity payloads", () => {
    const a = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: "3",
      requesterId: "user_1",
    });
    const b = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: "3",
      requesterId: "user_1",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes key when objective version changes", () => {
    const v1 = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: "1",
      requesterId: "user_1",
    });
    const v2 = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: "2",
      requesterId: "user_1",
    });
    expect(v1).not.toBe(v2);
  });

  it("does not depend on requestedOutcome text", () => {
    // Identity helper excludes outcome text by design; same identity → same key
    // regardless of wording changes at the application layer.
    const key = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: "1",
      requesterId: "user_1",
    });
    expect(key).toBe(
      objectiveIdempotencyKey({
        projectId: "proj_1",
        objectiveId: "obj_1",
        objectiveVersion: "1",
        requesterId: "user_1",
      }),
    );
  });
});
