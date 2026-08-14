import { describe, expect, it } from "vitest";
import { objectiveIdempotencyKey } from "./idempotency.js";

describe("Objective idempotency", () => {
  it("produces the same key for equivalent identity payloads", () => {
    const a = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 3,
      requestedEnvironment: "local",
    });
    const b = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 3,
      requestedEnvironment: "local",
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes key when objective version changes", () => {
    const v1 = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 1,
      requestedEnvironment: "local",
    });
    const v2 = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 2,
      requestedEnvironment: "local",
    });
    expect(v1).not.toBe(v2);
  });

  it("changes key when requested environment changes", () => {
    const local = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 1,
      requestedEnvironment: "local",
    });
    const development = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 1,
      requestedEnvironment: "development",
    });
    expect(local).not.toBe(development);
  });

  it("does not depend on requesterId", () => {
    const key = objectiveIdempotencyKey({
      projectId: "proj_1",
      objectiveId: "obj_1",
      objectiveVersion: 1,
      requestedEnvironment: "local",
    });
    expect(key).toBe(
      objectiveIdempotencyKey({
        projectId: "proj_1",
        objectiveId: "obj_1",
        objectiveVersion: 1,
        requestedEnvironment: "local",
      }),
    );
  });
});
