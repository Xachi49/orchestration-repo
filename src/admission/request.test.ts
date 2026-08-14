import { describe, expect, it } from "vitest";
import {
  parseAdmissionRequest,
  safeParseAdmissionRequest,
} from "./request.js";
import { exampleAdmissionRequest } from "./fixtures.js";

describe("Admission request validation", () => {
  it("accepts a valid request", () => {
    const request = parseAdmissionRequest(exampleAdmissionRequest());
    expect(request.objectiveId).toBe("obj_phase2_example");
    expect(request.objectiveVersion).toBe(1);
    expect(request.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("rejects missing acceptance criteria", () => {
    const result = safeParseAdmissionRequest(
      exampleAdmissionRequest({ acceptanceCriteria: [] }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects invalid objective versions", () => {
    expect(
      safeParseAdmissionRequest({
        ...exampleAdmissionRequest(),
        objectiveVersion: 0,
      }).success,
    ).toBe(false);
    expect(
      safeParseAdmissionRequest({
        ...exampleAdmissionRequest(),
        objectiveVersion: -1,
      }).success,
    ).toBe(false);
    expect(
      safeParseAdmissionRequest({
        ...exampleAdmissionRequest(),
        objectiveVersion: 1.5,
      }).success,
    ).toBe(false);
    expect(
      safeParseAdmissionRequest({
        ...exampleAdmissionRequest(),
        objectiveVersion: "1",
      }).success,
    ).toBe(false);
    expect(
      safeParseAdmissionRequest({
        ...exampleAdmissionRequest(),
        objectiveVersion: "1.0.0",
      }).success,
    ).toBe(false);
  });

  it("rejects a malformed environment", () => {
    const result = safeParseAdmissionRequest(
      exampleAdmissionRequest({ requestedEnvironment: "" }),
    );
    expect(result.success).toBe(false);
  });
});
