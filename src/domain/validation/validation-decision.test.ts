import { describe, expect, it } from "vitest";
import {
  ValidationDecisionClassSchema,
  parseValidationDecision,
} from "./validation-decision.js";

describe("Validation contract", () => {
  it("accepts only the four approved decision classes", () => {
    expect(ValidationDecisionClassSchema.options).toEqual([
      "PASS",
      "BLOCK",
      "HUMAN_APPROVAL_REQUIRED",
      "REVISE",
    ]);

    for (const decision of ValidationDecisionClassSchema.options) {
      expect(ValidationDecisionClassSchema.parse(decision)).toBe(decision);
    }

    expect(() => ValidationDecisionClassSchema.parse("MAYBE")).toThrow();
    expect(() => ValidationDecisionClassSchema.parse("FAIL")).toThrow();
  });

  it("requires structured findings on a decision", () => {
    const decision = parseValidationDecision({
      decision: "HUMAN_APPROVAL_REQUIRED",
      findings: [
        {
          findingId: "f1",
          code: "POLICY_REVIEW",
          severity: "WARNING",
          message: "Budget threshold requires human approval",
        },
      ],
      decidedAt: "2026-08-13T00:00:00.000Z",
      validatorId: "validator_rules_v1",
      planId: "plan_1",
      planVersion: 1,
      planHash: "abc",
    });
    expect(decision.findings).toHaveLength(1);
  });

  it("rejects non-positive-integer planVersion", () => {
    const base = {
      decision: "PASS" as const,
      findings: [],
      decidedAt: "2026-08-13T00:00:00.000Z",
      validatorId: "validator_rules_v1",
      planId: "plan_1",
      planHash: "abc",
    };
    expect(() =>
      parseValidationDecision({ ...base, planVersion: "1" }),
    ).toThrow();
    expect(() =>
      parseValidationDecision({ ...base, planVersion: 1.5 }),
    ).toThrow();
    expect(() =>
      parseValidationDecision({ ...base, planVersion: 0 }),
    ).toThrow();
    expect(() =>
      parseValidationDecision({ ...base, planVersion: -1 }),
    ).toThrow();
  });
});
