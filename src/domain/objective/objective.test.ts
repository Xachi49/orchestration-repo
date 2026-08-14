import { describe, expect, it } from "vitest";
import {
  parseObjective,
  safeParseObjective,
  type Objective,
} from "../objective/index.js";

function validObjective(overrides: Partial<Objective> = {}): Objective {
  return {
    objectiveId: "obj_1",
    objectiveVersion: "1",
    projectId: "proj_1",
    requestedOutcome: "Deliver Phase 0 foundation",
    acceptanceCriteria: ["Repository builds", "Tests pass"],
    nonGoals: ["LLM integration"],
    constraints: ["No external side effects"],
    priority: "HIGH",
    requesterId: "user_1",
    createdAt: "2026-08-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("Objective validation", () => {
  it("accepts a valid objective", () => {
    const objective = parseObjective(validObjective());
    expect(objective.objectiveId).toBe("obj_1");
    expect(objective.acceptanceCriteria).toHaveLength(2);
  });

  it("rejects missing acceptance criteria", () => {
    const result = safeParseObjective(
      validObjective({ acceptanceCriteria: [] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects malformed objective", () => {
    const result = safeParseObjective({
      objectiveId: "obj_1",
      // missing required fields
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields under strict schema", () => {
    const result = safeParseObjective({
      ...validObjective(),
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });
});
