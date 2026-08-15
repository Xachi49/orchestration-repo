import { describe, expect, it } from "vitest";
import {
  ValidationDecisionClassSchema,
  parseValidationDecision,
} from "./validation-decision.js";

const sampleFinding = {
  findingId: "f1",
  validatorType: "POLICY" as const,
  category: "policy",
  severity: "WARNING" as const,
  ruleId: "POLICY_REVIEW",
  message: "Budget threshold requires human approval",
  evidenceRefs: [],
  affectedStepIds: [],
  repairable: false,
  approvalEligible: true,
  blocking: false,
  semanticFingerprint: "policy:POLICY_REVIEW",
  metadata: {},
};

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
      validationDecisionId: "vd_1",
      decision: "HUMAN_APPROVAL_REQUIRED",
      findings: [sampleFinding],
      decidedAt: "2026-08-13T00:00:00.000Z",
      validatorId: "validator_rules_v1",
      runId: "run_1",
      planId: "plan_1",
      planVersion: 1,
      planHash: "abc",
      policyBundleHash: "polhash",
      repositoryFingerprint: "fp",
      validationAttempt: 1,
      requiresHumanAction: true,
    });
    expect(decision.findings).toHaveLength(1);
    expect(decision.findings[0]?.ruleId).toBe("POLICY_REVIEW");
  });

  it("rejects non-positive-integer planVersion", () => {
    const base = {
      validationDecisionId: "vd_1",
      decision: "PASS" as const,
      findings: [],
      decidedAt: "2026-08-13T00:00:00.000Z",
      validatorId: "validator_rules_v1",
      runId: "run_1",
      planId: "plan_1",
      planHash: "abc",
      policyBundleHash: "polhash",
      repositoryFingerprint: "fp",
      validationAttempt: 1,
      requiresHumanAction: false,
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
