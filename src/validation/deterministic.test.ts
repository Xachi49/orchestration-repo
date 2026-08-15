import { describe, expect, it } from "vitest";
import { createLocalValidationStack } from "../infrastructure/validation/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ProjectControlContext } from "../control-plane/context.js";
import { DeterministicValidationService } from "./deterministic.js";
import { PlanPolicyValidator } from "./policy-validator.js";
import { IndependentCapabilityValidator } from "./capability-validator.js";
import { PlanSecurityValidator } from "./security-validator.js";
import { PlanResourceValidator } from "./resource-validator.js";
import { PlanDependencyValidator } from "./dependency-validator.js";

async function plannedFixture() {
  const stack = createLocalValidationStack();
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  const record = (await stack.plans.getByRunId(runId))!;
  const objective = (await stack.objectives.getById(
    (await stack.runs.getById(runId))!.objectiveId,
    (await stack.runs.getById(runId))!.objectiveVersion,
  ))!;
  const control = await stack.controlPlane.resolve(
    EXAMPLE_PROJECT_ID,
    EXAMPLE_ENVIRONMENT,
  );
  const liveLock = await stack.locks.getByRunId(runId);
  const repositoryContext = await stack.contexts.getByRunId(runId);
  const deterministic = new DeterministicValidationService({
    capabilities: stack.capabilities,
  });
  const input = {
    runId,
    record,
    control,
    environment: EXAMPLE_ENVIRONMENT,
    liveLock,
    repositoryContext,
    objective,
  };
  return { stack, runId, record, control, input, deterministic };
}

function withStep(plan: ExecutionPlan, index: number, patch: object): ExecutionPlan {
  const steps = plan.steps.map((step, position) =>
    position === index ? { ...step, ...patch } : step,
  );
  return { ...plan, steps } as ExecutionPlan;
}

describe("DeterministicValidationService", () => {
  it("runs the full ladder in order for a clean plan", async () => {
    const { deterministic, input } = await plannedFixture();
    const result = await deterministic.evaluate(input);
    expect(result.validatorsRun).toEqual([
      "SCHEMA",
      "STATE",
      "FRESHNESS",
      "POLICY",
      "CAPABILITY",
      "DEPENDENCY",
      "RESOURCE",
      "SECURITY",
      "VERIFICATION_BINDING",
    ]);
    expect(result.haltedAt).toBeNull();
    expect(result.contextualEligible).toBe(true);
    expect(result.findings.filter((finding) => finding.blocking)).toEqual([]);
    expect(result.plan).not.toBeNull();
    expect(result.graph).not.toBeNull();
    expect(result.resourceEstimate).not.toBeNull();
  });

  it("halts on a plan hash mismatch without consulting later validators", async () => {
    const { deterministic, input } = await plannedFixture();
    const result = await deterministic.evaluate({
      ...input,
      record: { ...input.record, planHash: "sha256:tampered" },
    });
    expect(result.haltedAt).toBe("STATE");
    expect(result.validatorsRun).not.toContain("POLICY");
    expect(result.contextualEligible).toBe(false);
    const hashFinding = result.findings.find(
      (finding) => finding.ruleId === "PLAN_RECORD_HASH_MISMATCH",
    );
    expect(hashFinding?.blocking).toBe(true);
    expect(hashFinding?.repairable).toBe(false);
    expect(hashFinding?.approvalEligible).toBe(false);
  });

  it("recomputes the plan hash and blocks a tampered plan body", async () => {
    const { deterministic, input } = await plannedFixture();
    const tampered = {
      ...input.record,
      plan: {
        ...input.record.plan,
        assumptions: ["tampered after compilation"],
      },
    };
    const result = await deterministic.evaluate({ ...input, record: tampered });
    expect(
      result.findings.some((finding) => finding.ruleId === "PLAN_HASH_MISMATCH"),
    ).toBe(true);
    expect(result.contextualEligible).toBe(false);
  });

  it("halts at FRESHNESS when the live lock is STALE", async () => {
    const { deterministic, input } = await plannedFixture();
    const result = await deterministic.evaluate({
      ...input,
      liveLock: { ...input.liveLock!, status: "STALE" },
    });
    expect(result.haltedAt).toBe("FRESHNESS");
    expect(result.validatorsRun).toEqual(["SCHEMA", "STATE", "FRESHNESS"]);
    expect(result.contextualEligible).toBe(false);
    expect(
      result.findings.some(
        (finding) =>
          finding.validatorType === "FRESHNESS" &&
          finding.blocking &&
          !finding.repairable,
      ),
    ).toBe(true);
  });

  it("halts at FRESHNESS when the active policy bundle rotated", async () => {
    const { deterministic, input, control } = await plannedFixture();
    const rotated: ProjectControlContext = {
      ...control,
      activePolicyBundle: {
        ...control.activePolicyBundle,
        policyHash: "sha256:rotated-policy",
      },
    };
    const result = await deterministic.evaluate({ ...input, control: rotated });
    expect(result.haltedAt).toBe("FRESHNESS");
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "PLAN_POLICY_BUNDLE_HASH_MISMATCH",
      ),
    ).toBe(true);
  });

  it("blocks plans that are no longer in a validatable state", async () => {
    const { deterministic, input } = await plannedFixture();
    const result = await deterministic.evaluate({
      ...input,
      record: { ...input.record, status: "VALIDATED_PASS" },
    });
    expect(result.haltedAt).toBe("STATE");
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "PLAN_STATUS_NOT_VALIDATABLE",
      ),
    ).toBe(true);
  });

  it("fails closed on a missing live lock", async () => {
    const { deterministic, input } = await plannedFixture();
    const result = await deterministic.evaluate({ ...input, liveLock: null });
    expect(result.contextualEligible).toBe(false);
    expect(result.haltedAt).toBe("FRESHNESS");
  });
});

describe("PlanPolicyValidator", () => {
  it("denies production-mutating actions with a hard blocking finding", async () => {
    const { record, control } = await plannedFixture();
    const plan = withStep(record.plan, 1, { actionType: "DEPLOY_PRODUCTION" });
    const result = new PlanPolicyValidator().validate({
      plan,
      control,
      environment: EXAMPLE_ENVIRONMENT,
    });
    const deny = result.findings.find(
      (finding) => finding.ruleId === "POLICY_DENY",
    );
    expect(deny?.blocking).toBe(true);
    expect(deny?.repairable).toBe(false);
    expect(deny?.approvalEligible).toBe(false);
    expect(
      result.evaluations.find((evaluation) => evaluation.effect === "DENY"),
    ).toBeDefined();
  });

  it("treats an unmatched action as not permitted", async () => {
    const { record, control } = await plannedFixture();
    const plan = withStep(record.plan, 0, { actionType: "CREATE_TASK" });
    const result = new PlanPolicyValidator().validate({
      plan,
      control,
      environment: EXAMPLE_ENVIRONMENT,
    });
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "POLICY_NO_MATCHING_RULE",
      ),
    ).toBe(true);
  });

  it("allows the fixture plan under the active bundle", async () => {
    const { record, control } = await plannedFixture();
    const result = new PlanPolicyValidator().validate({
      plan: record.plan,
      control,
      environment: EXAMPLE_ENVIRONMENT,
    });
    expect(result.findings.filter((finding) => finding.blocking)).toEqual([]);
    expect(
      result.evaluations.every(
        (evaluation) => evaluation.effect === "ALLOW",
      ),
    ).toBe(true);
  });
});

describe("independent validators", () => {
  it("rejects unknown action types at the capability gate", async () => {
    const { record, stack } = await plannedFixture();
    const plan = withStep(record.plan, 0, { actionType: "REFACTOR_MODULE" });
    const findings = await new IndependentCapabilityValidator(
      stack.capabilities,
    ).validate({ plan, environment: EXAMPLE_ENVIRONMENT });
    expect(
      findings.some(
        (finding) => finding.ruleId === "CAPABILITY_ACTION_UNKNOWN",
      ),
    ).toBe(true);
  });

  it("rejects disabled capabilities even when policy would allow them", async () => {
    const { record, stack } = await plannedFixture();
    const plan = withStep(record.plan, 0, { actionType: "PUSH_TO_MAIN" });
    const findings = await new IndependentCapabilityValidator(
      stack.capabilities,
    ).validate({ plan, environment: EXAMPLE_ENVIRONMENT });
    expect(findings.some((finding) => finding.blocking)).toBe(true);
  });

  it("flags forbidden actions in the security validator", async () => {
    const { record, control } = await plannedFixture();
    const plan = withStep(record.plan, 1, { actionType: "DELETE_REPOSITORY" });
    const findings = new PlanSecurityValidator().validate({
      plan,
      control,
      environment: EXAMPLE_ENVIRONMENT,
    });
    const forbidden = findings.find(
      (finding) => finding.ruleId === "SECURITY_FORBIDDEN_ACTION",
    );
    expect(forbidden?.blocking).toBe(true);
    expect(forbidden?.repairable).toBe(false);
  });

  it("treats hard budget dimensions as non-repairable", async () => {
    const { record, control } = await plannedFixture();
    const result = new PlanResourceValidator().validate({
      plan: record.plan,
      budget: { ...control.resourceBudget, maximumPlanSteps: 1 },
    });
    const finding = result.findings.find((entry) => entry.blocking);
    expect(finding?.repairable).toBe(false);
    expect(finding?.approvalEligible).toBe(false);
  });

  it("returns dependency findings instead of throwing on a cycle", async () => {
    const { record } = await plannedFixture();
    const plan = withStep(record.plan, 0, { dependsOn: ["step_test"] });
    const result = new PlanDependencyValidator().validate(plan);
    expect(result.graph).toBeNull();
    const cycle = result.findings.find(
      (finding) => finding.ruleId === "DEPENDENCY_CYCLE",
    );
    expect(cycle?.blocking).toBe(true);
    expect(cycle?.repairable).toBe(true);
  });
});
