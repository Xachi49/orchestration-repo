import { describe, expect, it } from "vitest";
import {
  INITIAL_PLAN_VERSION,
  PlanVersionSchema,
  parseExecutionPlan,
} from "./execution-plan.js";
import type { ExecutionPlanForHash } from "./execution-plan.js";
import { Sha256PlanHasher } from "./plan-hasher.js";

describe("PlanVersionSchema", () => {
  it("accepts positive integers starting at 1", () => {
    expect(PlanVersionSchema.parse(1)).toBe(1);
    expect(PlanVersionSchema.parse(2)).toBe(2);
    expect(INITIAL_PLAN_VERSION).toBe(1);
  });

  it("rejects string, semver, decimals, zero, negatives, and text", () => {
    for (const value of ["1", "1.0.0", 1.5, 0, -1, "v1", true, null]) {
      expect(() => PlanVersionSchema.parse(value)).toThrow();
    }
  });

  it("changes plan hash when planVersion changes numerically", () => {
    const hasher = new Sha256PlanHasher();
    const base: ExecutionPlanForHash = {
      planId: "plan_1",
      planVersion: 1,
      objectiveId: "obj_1",
      objectiveVersion: 1,
      repositoryCommitSha: "abc123",
      repositoryFingerprint: "fp_1",
      policyBundleId: "pol_1",
      policyBundleHash: "polhash_1",
      schemaVersion: "1.0.0",
      assumptions: [],
      unknowns: [],
      successDefinition: ["ok"],
      resourceTotals: {},
      criticalPath: [],
      workstreams: [],
      steps: [],
      approvalRequirements: [],
      failurePolicy: { onStepFailure: "FAIL_RUN", maxRetries: 0 },
    };
    const v1 = hasher.hash(base);
    const v2 = hasher.hash({ ...base, planVersion: 2 });
    expect(v1).not.toBe(v2);
    expect(() =>
      parseExecutionPlan({ ...base, planHash: v1, planVersion: "1" }),
    ).toThrow();
  });
});
