import { describe, expect, it } from "vitest";
import {
  assertTransition,
  isTerminalRunState,
  transitionRunState,
  type RunState,
} from "./run-state.js";

describe("Run state machine", () => {
  it("accepts valid primary transitions", () => {
    const path: RunState[] = [
      "RECEIVED",
      "ADMITTED",
      "INGESTING",
      "PLANNING",
      "VALIDATING",
      "AWAITING_APPROVAL",
      "APPROVED",
      "EXECUTING",
      "VERIFYING",
      "COMPLETED",
    ];

    let current = path[0]!;
    for (let i = 1; i < path.length; i += 1) {
      const next = path[i]!;
      const result = transitionRunState(current, next);
      expect(result.ok).toBe(true);
      if (result.ok) {
        current = result.state;
      }
    }
    expect(current).toBe("COMPLETED");
  });

  it("rejects illegal transitions", () => {
    const result = transitionRunState("RECEIVED", "EXECUTING");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ILLEGAL_RUN_TRANSITION");
      expect(result.error.from).toBe("RECEIVED");
      expect(result.error.to).toBe("EXECUTING");
    }
  });

  it("does not allow terminal states to silently restart", () => {
    for (const terminal of [
      "COMPLETED",
      "ADMISSION_REJECTED",
      "REJECTED",
      "EXPIRED",
      "SUPERSEDED",
      "CANCELLED",
      "CONTAINED",
    ] as const) {
      expect(isTerminalRunState(terminal)).toBe(true);
      const result = transitionRunState(terminal, "RECEIVED");
      expect(result.ok).toBe(false);
    }
  });

  it("throws via assertTransition on illegal moves", () => {
    expect(() => assertTransition("RECEIVED", "COMPLETED")).toThrow(
      /Illegal run-state transition/,
    );
  });
});
