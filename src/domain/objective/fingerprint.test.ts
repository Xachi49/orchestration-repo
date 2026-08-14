import { describe, expect, it } from "vitest";
import { objectiveFingerprint } from "./fingerprint.js";

const content = {
  requestedOutcome: "Admit a local patch-only objective",
  acceptanceCriteria: ["Run is ADMITTED", "Event envelope is persisted"],
  nonGoals: ["Execution", "LLM planning"],
  constraints: ["No external side effects"],
  priority: "HIGH" as const,
};

describe("Objective fingerprint", () => {
  it("is deterministic for identical content", () => {
    expect(objectiveFingerprint(content)).toBe(objectiveFingerprint(content));
  });

  it("treats unordered acceptanceCriteria as equivalent", () => {
    const a = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["A", "B"],
    });
    const b = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["B", "A"],
    });
    expect(a).toBe(b);
  });

  it("ignores duplicate collection entries after normalization", () => {
    const unique = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["A", "B"],
      constraints: ["C"],
      nonGoals: ["D"],
    });
    const duplicated = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["A", "B", "A"],
      constraints: ["C", "C"],
      nonGoals: ["D", "D"],
    });
    expect(duplicated).toBe(unique);
  });

  it("ignores leading and trailing whitespace in collections", () => {
    const trimmed = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["A", "B"],
      constraints: ["limit"],
      nonGoals: ["scope"],
    });
    const padded = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["  A", "B  "],
      constraints: [" limit "],
      nonGoals: ["\tscope\t"],
    });
    expect(padded).toBe(trimmed);
  });

  it("changes when genuinely different criteria are supplied", () => {
    const original = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["A", "B"],
    });
    const different = objectiveFingerprint({
      ...content,
      acceptanceCriteria: ["A", "C"],
    });
    expect(different).not.toBe(original);
  });

  it("changes when requestedOutcome changes", () => {
    const changed = objectiveFingerprint({
      ...content,
      requestedOutcome: "Different outcome",
    });
    expect(changed).not.toBe(objectiveFingerprint(content));
  });

  it("does not mutate the original collections", () => {
    const acceptanceCriteria = [" B ", "A", "A"];
    const snapshot = [...acceptanceCriteria];
    objectiveFingerprint({
      ...content,
      acceptanceCriteria,
    });
    expect(acceptanceCriteria).toEqual(snapshot);
  });
});
