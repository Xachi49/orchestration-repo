import { describe, expect, it } from "vitest";
import { compareLockedToRemote } from "./drift.js";
import { EXAMPLE_COMMIT_SHA, EXAMPLE_DRIFT_SHA } from "./fixtures.js";

describe("compareLockedToRemote", () => {
  it("returns CURRENT when SHAs match", () => {
    expect(compareLockedToRemote(EXAMPLE_COMMIT_SHA, EXAMPLE_COMMIT_SHA)).toEqual({
      result: "CURRENT",
      lockedSha: EXAMPLE_COMMIT_SHA,
      remoteSha: EXAMPLE_COMMIT_SHA,
    });
  });

  it("returns DRIFT_DETECTED when SHAs differ", () => {
    expect(compareLockedToRemote(EXAMPLE_COMMIT_SHA, EXAMPLE_DRIFT_SHA)).toEqual({
      result: "DRIFT_DETECTED",
      lockedSha: EXAMPLE_COMMIT_SHA,
      remoteSha: EXAMPLE_DRIFT_SHA,
    });
  });

  it("returns INVALID_STATE for a malformed locked SHA", () => {
    expect(compareLockedToRemote("not-a-sha", EXAMPLE_COMMIT_SHA).result).toBe(
      "INVALID_STATE",
    );
  });
});
