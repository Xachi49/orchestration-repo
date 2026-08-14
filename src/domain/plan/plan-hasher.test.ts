import { describe, expect, it } from "vitest";
import type { ExecutionPlanForHash } from "./execution-plan.js";
import { Sha256PlanHasher, canonicalizePlan } from "./plan-hasher.js";

function basePlan(
  overrides: Partial<ExecutionPlanForHash> = {},
): ExecutionPlanForHash {
  return {
    planId: "plan_1",
    planVersion: "1",
    objectiveId: "obj_1",
    objectiveVersion: "1",
    repositoryCommitSha: "abc123",
    repositoryFingerprint: "fp_1",
    policyBundleId: "pol_1",
    policyBundleHash: "polhash_1",
    schemaVersion: "1.0.0",
    assumptions: ["repo is readable"],
    unknowns: ["exact CI latency"],
    successDefinition: ["all acceptance criteria verified"],
    resourceTotals: { costEstimateUsd: 10 },
    criticalPath: ["step_1"],
    workstreams: [
      { workstreamId: "ws_1", name: "foundation", stepIds: ["step_1"] },
    ],
    steps: [
      {
        stepId: "step_1",
        actionType: "CREATE_FILE",
        description: "Add domain contracts",
        targetIds: ["src/domain"],
        evidenceRefs: [],
        dependsOn: [],
        preconditions: ["repo empty"],
        expectedPostconditions: ["contracts exist"],
        resourceEstimate: { durationMs: 1000 },
        risk: { level: "LOW", categories: ["change-management"] },
        validation: { checks: ["typecheck"] },
        rollback: { strategy: "NONE" },
        idempotencyKey: "step_1_v1",
      },
    ],
    approvalRequirements: [],
    failurePolicy: { onStepFailure: "FAIL_RUN", maxRetries: 0 },
    ...overrides,
  };
}

describe("PlanHasher", () => {
  const hasher = new Sha256PlanHasher();

  it("produces identical hashes for identical plans", () => {
    const a = hasher.hash(basePlan());
    const b = hasher.hash(basePlan());
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it("changes hash when plan contents change meaningfully", () => {
    const original = hasher.hash(basePlan());
    const changed = hasher.hash(
      basePlan({ assumptions: ["repo is readable", "ci is green"] }),
    );
    expect(changed).not.toBe(original);
  });

  it("is unaffected by object key insertion order", () => {
    const planA = basePlan();
    const planB = {
      schemaVersion: planA.schemaVersion,
      planId: planA.planId,
      planVersion: planA.planVersion,
      objectiveId: planA.objectiveId,
      objectiveVersion: planA.objectiveVersion,
      repositoryCommitSha: planA.repositoryCommitSha,
      repositoryFingerprint: planA.repositoryFingerprint,
      policyBundleId: planA.policyBundleId,
      policyBundleHash: planA.policyBundleHash,
      assumptions: planA.assumptions,
      unknowns: planA.unknowns,
      successDefinition: planA.successDefinition,
      resourceTotals: planA.resourceTotals,
      criticalPath: planA.criticalPath,
      workstreams: planA.workstreams,
      steps: planA.steps,
      approvalRequirements: planA.approvalRequirements,
      failurePolicy: planA.failurePolicy,
    } satisfies ExecutionPlanForHash;

    expect(hasher.hash(planA)).toBe(hasher.hash(planB));
  });

  it("does not include planHash in the canonical form or hash input", () => {
    const plan = basePlan();
    const canonical = canonicalizePlan(plan);
    expect(canonical.includes("planHash")).toBe(false);

    const withStrayHash = {
      ...plan,
      planHash: "should-be-ignored",
    } as ExecutionPlanForHash & { planHash: string };

    expect(hasher.hash(withStrayHash)).toBe(hasher.hash(plan));
  });
});
