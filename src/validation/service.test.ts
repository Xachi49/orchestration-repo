import { describe, expect, it } from "vitest";
import { createLocalValidationStack } from "../infrastructure/validation/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { assertTransition } from "../domain/run/run-state.js";
import { ValidationError } from "./errors.js";
import { FakeValidationModel } from "./fake-validation-model.js";
import type { ContextualValidationAssessment } from "./model.js";
import {
  aggregateValidationUsage,
  FixedValidationTokenEstimator,
} from "./index.js";
import { MAX_SEMANTIC_REVISION_ATTEMPTS } from "./service.js";
import { EXAMPLE_BUDGET } from "../control-plane/fixtures.js";

function reviseAssessment(ruleId: string): ContextualValidationAssessment {
  return {
    recommendation: "REVISE",
    confidence: 0.55,
    observations: [
      {
        ruleId,
        category: "semantic-coverage",
        severity: "ERROR",
        message: `Contextual objection ${ruleId}`,
        affectedStepIds: ["step_patch"],
        evidenceRefs: [],
        repairable: true,
        rationale: "Configured contextual objection for tests",
      },
    ],
    unsupportedClaims: [],
    coverageGaps: [],
    summary: `Fake validation model requests a revision for ${ruleId}`,
  };
}

async function validatableRun(model?: FakeValidationModel) {
  const stack = createLocalValidationStack(
    model ? { validationModel: model } : undefined,
  );
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  return { stack, runId, model: stack.validationModel as FakeValidationModel };
}

describe("ValidationService — pass path", () => {
  it("passes a clean plan and leaves the run in VALIDATING", async () => {
    const { stack, runId, model } = await validatableRun();
    const result = await stack.validation.validate(runId);

    expect(result.outcome).toBe("VALIDATED");
    expect(result.decision).toBe("PASS");
    expect(result.reasonCodes).toEqual(["NO_BLOCKING_FINDINGS"]);
    expect(result.requiresHumanAction).toBe(false);
    expect(result.planVersion).toBe(1);
    expect(result.planStatus).toBe("VALIDATED_PASS");
    expect(result.runState).toBe("VALIDATING");
    expect(result.revisionAttemptsUsed).toBe(0);
    expect(result.exception).toBeUndefined();
    expect(result.contextualAssessmentUsed).toBe(true);
    expect(model.callCount).toBe(1);

    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
    const plan = await stack.plans.getByRunId(runId);
    expect(plan?.status).toBe("VALIDATED_PASS");
  });

  it("PASS is not approval: no approval is recorded and the plan is not executable", async () => {
    const { stack, runId } = await validatableRun();
    const result = await stack.validation.validate(runId);
    const decision = await stack.validation.getLatestDecision(runId);
    expect(decision?.decision).toBe("PASS");
    expect(decision?.requiresHumanAction).toBe(false);
    expect(result.runState).toBe("VALIDATING");
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
    expect(run?.state).not.toBe("APPROVED");
    expect(run?.state).not.toBe("EXECUTING");
  });

  it("cannot transition VALIDATING → APPROVED; PASS leaves the run VALIDATING", async () => {
    const { stack, runId } = await validatableRun();
    await stack.validation.validate(runId);
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
    expect(() => assertTransition("VALIDATING", "APPROVED")).toThrow(
      /Illegal run-state transition/,
    );
  });

  it("persists a decision bound to the exact plan identity", async () => {
    const { stack, runId } = await validatableRun();
    const result = await stack.validation.validate(runId);
    const decision = await stack.validation.getLatestDecision(runId);
    const plan = await stack.plans.getByRunId(runId);
    expect(decision?.planId).toBe(plan?.planId);
    expect(decision?.planHash).toBe(plan?.planHash);
    expect(decision?.planVersion).toBe(1);
    expect(decision?.validationDecisionId).toBe(result.validationDecisionId);
    expect(decision?.validationAttempt).toBe(1);
    expect(decision?.validatorId).toBeTruthy();
  });

  it("records model usage through reserve/settle", async () => {
    const { stack, runId } = await validatableRun();
    await stack.validation.validate(runId);
    const usage = await stack.validationUsage.listByRunId(runId);
    expect(usage.length).toBe(1);
    expect(usage[0]?.operation).toBe("CONTEXTUAL_ASSESSMENT");
    expect(usage[0]?.status).toBe("SUCCESS");
    expect(usage[0]?.reservedTokens).toBeGreaterThan(0);
    expect(
      await stack.validationUsage.hasBudgetInvariantViolation(runId),
    ).toBe(false);
  });
});

describe("ValidationService — fencing and idempotency", () => {
  it("replays the recorded decision without a second model call", async () => {
    const { stack, runId, model } = await validatableRun();
    const first = await stack.validation.validate(runId);
    const callsAfterFirst = model.callCount;
    const second = await stack.validation.validate(runId);
    expect(second.validationDecisionId).toBe(first.validationDecisionId);
    expect(second.decision).toBe(first.decision);
    expect(model.callCount).toBe(callsAfterFirst);
    expect((await stack.validation.listDecisions(runId)).length).toBe(1);
  });

  it("rejects a concurrent validation of the same plan version", async () => {
    const { stack, runId } = await validatableRun();
    const plan = (await stack.plans.getByRunId(runId))!;
    await stack.validationCoordinator.begin(
      {
        runId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
      },
      stack.clock.nowIso(),
    );
    await expect(stack.validation.validate(runId)).rejects.toMatchObject({
      code: "VALIDATION_IN_PROGRESS",
    });
  });

  it("marks the fence FAILED on a model failure and allows an explicit retry", async () => {
    const { stack, runId, model } = await validatableRun();
    model.failNextCall(
      new ValidationError(
        "VALIDATION_MODEL_UNAVAILABLE",
        "simulated provider outage",
      ),
    );
    await expect(stack.validation.validate(runId)).rejects.toMatchObject({
      code: "VALIDATION_MODEL_UNAVAILABLE",
    });
    const plan = (await stack.plans.getByRunId(runId))!;
    const key = {
      runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
    };
    const failed = await stack.validationCoordinator.get(key);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.attempt).toBe(1);
    expect(await stack.validation.getLatestDecision(runId)).toBeNull();

    const retried = await stack.validation.validate(runId);
    expect(retried.decision).toBe("PASS");
    const decided = await stack.validationCoordinator.get(key);
    expect(decided?.status).toBe("DECIDED");
    expect(decided?.attempt).toBe(2);
  });

  it("settles the usage ledger as FAILED when the model errors", async () => {
    const { stack, runId, model } = await validatableRun();
    model.failNextCall(new Error("simulated provider outage"));
    await expect(stack.validation.validate(runId)).rejects.toBeTruthy();
    const usage = await stack.validationUsage.listByRunId(runId);
    expect(usage[0]?.status).toBe("FAILED");
  });
});

describe("ValidationService — hard blocks are never revised", () => {
  it("BLOCKs a stale repository lock without calling the model", async () => {
    const { stack, runId, model } = await validatableRun();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });

    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toEqual(["UNREPAIRABLE_VIOLATION"]);
    expect(result.requiresHumanAction).toBe(true);
    expect(result.planStatus).toBe("VALIDATED_BLOCK");
    expect(result.planVersion).toBe(1);
    expect(result.contextualAssessmentUsed).toBe(false);
    expect(model.callCount).toBe(0);
    expect(result.exception?.exceptionType).toBe("UNREPAIRABLE_VIOLATION");
    expect((await stack.plans.listByRunId(runId)).length).toBe(1);
  });

  it("BLOCKs a tampered plan hash", async () => {
    const { stack, runId } = await validatableRun();
    const plan = (await stack.plans.getByRunId(runId))!;
    await stack.plans.save({ ...plan, planHash: `${plan.planHash}-tampered` });
    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("BLOCK");
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "PLAN_RECORD_HASH_MISMATCH",
      ),
    ).toBe(true);
    expect((await stack.plans.listByRunId(runId)).length).toBe(1);
  });

  it("BLOCKs a policy-denied step and keeps the run in VALIDATING", async () => {
    const { stack, runId } = await validatableRun();
    const record = (await stack.plans.getByRunId(runId))!;
    const steps = record.plan.steps.map((step, index) =>
      index === 1 ? { ...step, actionType: "DEPLOY_PRODUCTION" } : step,
    );
    const { planHash: _previous, ...forHash } = { ...record.plan, steps };
    const hashed = new Sha256PlanHasher().hash(forHash);
    const plan = { ...record.plan, steps };
    await stack.plans.save({
      ...record,
      plan: { ...plan, planHash: hashed },
      planHash: hashed,
    });

    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("BLOCK");
    expect(
      result.findings.some((finding) => finding.ruleId === "POLICY_DENY"),
    ).toBe(true);
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
  });
});

describe("ValidationService — independence from the model", () => {
  it("ignores a model BLOCK recommendation that is not backed by a finding", async () => {
    const model = new FakeValidationModel();
    model.setAssessment({
      recommendation: "BLOCK",
      confidence: 0.99,
      observations: [],
      unsupportedClaims: [],
      coverageGaps: [],
      summary: "Model asserts the plan must be blocked",
    });
    const { stack, runId } = await validatableRun(model);
    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("PASS");
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "CONTEXTUAL_RECOMMENDATION",
      ),
    ).toBe(true);
    expect(
      result.findings
        .filter((finding) => finding.ruleId === "CONTEXTUAL_RECOMMENDATION")
        .every((finding) => !finding.blocking),
    ).toBe(true);
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
  });

  it("keeps a deterministic BLOCK even when the model recommends PASS", async () => {
    const { stack, runId, model } = await validatableRun();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "INVALID" });
    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("BLOCK");
    expect(model.callCount).toBe(0);
    expect((await stack.runs.getById(runId))?.state).toBe("VALIDATING");
  });

  it("DecisionEngine may BLOCK from a structured unrepairable contextual finding", async () => {
    const model = new FakeValidationModel();
    model.setAssessment({
      recommendation: "BLOCK",
      confidence: 0.8,
      observations: [
        {
          ruleId: "CONTEXT_OBJECTIVE_NOT_SATISFIED",
          category: "semantic-coverage",
          severity: "CRITICAL",
          message: "Plan does not satisfy the stated objective",
          affectedStepIds: [],
          evidenceRefs: [],
          repairable: false,
          rationale: "Configured unrepairable contextual objection",
        },
      ],
      unsupportedClaims: [],
      coverageGaps: [],
      summary: "Model objects on semantic grounds",
    });
    const { stack, runId } = await validatableRun(model);
    const result = await stack.validation.validate(runId);
    // Recommendation alone is not authoritative; the structured finding is
    // classified by DecisionEngine as blocking + non-repairable → BLOCK.
    expect(result.decision).toBe("BLOCK");
    expect(result.reasonCodes).toEqual(["UNREPAIRABLE_VIOLATION"]);
    expect(
      result.findings.some(
        (finding) =>
          finding.ruleId === "CONTEXT_OBJECTIVE_NOT_SATISFIED" &&
          finding.blocking &&
          !finding.repairable &&
          !finding.approvalEligible,
      ),
    ).toBe(true);
    expect(
      result.findings.some(
        (finding) => finding.ruleId === "CONTEXTUAL_RECOMMENDATION",
      ),
    ).toBe(true);
    expect((await stack.runs.getById(runId))?.state).toBe("VALIDATING");
  });

  it("HUMAN_APPROVAL_REQUIRED leaves the run VALIDATING", async () => {
    const model = new FakeValidationModel();
    model.setReviseRecommendation({
      ruleId: "CONTEXT_MISSING_VERIFICATION",
      affectedStepIds: ["step_patch"],
    });
    // Exhaust revisions to force HUMAN_APPROVAL_REQUIRED without needing
    // approval-eligible-only findings.
    const { stack, runId } = await validatableRun(model);
    // Force approval-eligible non-blocking finding by using a soft assessment
    // that DecisionEngine routes to HUMAN_APPROVAL via approvalEligible finding.
    // Simpler: use capability CONDITIONAL path — instead reuse REVISE exhaustion.
    const result = await stack.validation.validate(runId);
    // With repeated same fingerprint after one revision → HUMAN_APPROVAL_REQUIRED
    expect(result.decision).toBe("HUMAN_APPROVAL_REQUIRED");
    expect((await stack.runs.getById(runId))?.state).toBe("VALIDATING");
  });
});

describe("ValidationService — revision inference accounting", () => {
  it("tags revision calls as SEMANTIC_REVISION with lineage metadata", async () => {
    const model = new FakeValidationModel();
    model.setReviseRecommendation({
      ruleId: "CONTEXT_MISSING_VERIFICATION_A",
      affectedStepIds: ["step_patch"],
    });
    // After first revision, emit a different fingerprint so a second revision occurs.
    let calls = 0;
    const originalValidate = model.validatePlan.bind(model);
    model.validatePlan = async (input) => {
      calls += 1;
      if (calls === 1) {
        return originalValidate(input);
      }
      model.setReviseRecommendation({
        ruleId: "CONTEXT_MISSING_VERIFICATION_B",
        affectedStepIds: ["step_test"],
      });
      return originalValidate(input);
    };
    const { stack, runId } = await validatableRun(model);
    await stack.validation.validate(runId);
    const usage = await stack.validationUsage.listByRunId(runId);
    const revisions = usage.filter((r) => r.operation === "PLAN_REVISION");
    const contextual = usage.filter(
      (r) => r.operation === "CONTEXTUAL_ASSESSMENT",
    );
    expect(contextual.length).toBeGreaterThanOrEqual(1);
    expect(revisions.length).toBeGreaterThanOrEqual(1);
    expect(
      revisions.every((r) => r.operationCategory === "SEMANTIC_REVISION"),
    ).toBe(true);
    expect(
      contextual.every((r) => r.operationCategory === "CONTEXTUAL_VALIDATION"),
    ).toBe(true);
    expect(revisions[0]?.sourcePlanVersion).toBe(1);
    expect(revisions[0]?.targetPlanVersion).toBe(2);
    expect(revisions[0]?.revisionAttempt).toBe(1);
    const aggregate = aggregateValidationUsage(usage);
    expect(aggregate.byCategory.SEMANTIC_REVISION.llmCalls).toBe(
      revisions.length,
    );
    expect(aggregate.byCategory.CONTEXTUAL_VALIDATION.llmCalls).toBe(
      contextual.length,
    );
  });

  it("escalates when revision budget is insufficient rather than overspending", async () => {
    const model = new FakeValidationModel();
    model.setReviseRecommendation({
      ruleId: "CONTEXT_BUDGET_PRESSURE",
      affectedStepIds: ["step_patch"],
    });
    model.setTokenUsagePerCall({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
    // Planning and validation use separate ledgers against the same hard ceilings.
    // Leave only enough remaining tokens for one contextual reservation (50),
    // so the subsequent SEMANTIC_REVISION reservation fails closed.
    const stack = createLocalValidationStack({
      validationModel: model,
      validationTokenEstimator: new FixedValidationTokenEstimator(10),
      validationMaxOutputTokensByOperation: {
        CONTEXTUAL_ASSESSMENT: 40,
        PLAN_REVISION: 40,
      },
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    await stack.ingestion.ingest(
      admitted.runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await stack.planning.plan(admitted.runId);
    const plan = (await stack.plans.getByRunId(admitted.runId))!;
    const ceiling = EXAMPLE_BUDGET.maximumTotalTokens;
    await stack.validationUsage.reserve({
      callId: "seed-prior-usage",
      runId: admitted.runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      validationAttempt: 1,
      operation: "CONTEXTUAL_ASSESSMENT",
      provider: "seed",
      model: "seed",
      reservedTokens: 1,
      startedAt: stack.clock.nowIso(),
      maximumLlmCalls: EXAMPLE_BUDGET.maximumLlmCalls,
      maximumTotalTokens: ceiling,
      budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
    });
    await stack.validationUsage.settle("seed-prior-usage", {
      outcome: "SUCCESS",
      completedAt: stack.clock.nowIso(),
      charging: "ACTUAL",
      totalUsage: ceiling - 50,
    });

    const result = await stack.validation.validate(admitted.runId);
    expect(result.decision).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(result.exception?.exceptionType).toBe("REVISION_BUDGET_EXCEEDED");
    expect((await stack.runs.getById(admitted.runId))?.state).toBe(
      "VALIDATING",
    );
    const usage = await stack.validationUsage.listByRunId(admitted.runId);
    const revisions = usage.filter((r) => r.operation === "PLAN_REVISION");
    expect(revisions).toHaveLength(0);
    const liveContextual = usage.filter(
      (r) =>
        r.operation === "CONTEXTUAL_ASSESSMENT" && r.callId !== "seed-prior-usage",
    );
    expect(liveContextual).toHaveLength(1);
  });
});

describe("ValidationService — bounded revision", () => {
  it("escalates a repeated semantic violation after one revision", async () => {
    const model = new FakeValidationModel();
    model.setReviseRecommendation({
      ruleId: "CONTEXT_MISSING_VERIFICATION",
      affectedStepIds: ["step_patch"],
    });
    const { stack, runId } = await validatableRun(model);

    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(result.reasonCodes).toEqual(["REPEATED_SEMANTIC_VIOLATION"]);
    expect(result.exception?.exceptionType).toBe("REPEATED_SEMANTIC_VIOLATION");
    expect(result.planVersion).toBe(2);
    expect(result.revisionAttemptsUsed).toBe(1);

    const versions = await stack.plans.listByRunId(runId);
    expect(versions.map((entry) => entry.planVersion)).toEqual([1, 2]);
    expect(versions[0]?.status).toBe("SUPERSEDED");
    expect(versions[1]?.status).toBe("VALIDATED_APPROVAL_REQUIRED");
    expect(result.supersededPlanIds).toEqual([versions[0]?.planId]);

    const decisions = await stack.validation.listDecisions(runId);
    expect(decisions.map((entry) => entry.decision)).toEqual([
      "REVISE",
      "HUMAN_APPROVAL_REQUIRED",
    ]);
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
  });

  it("stops at v3 when every revision raises a new repairable violation", async () => {
    const model = new FakeValidationModel();
    model.queueAssessments([
      reviseAssessment("CONTEXT_GAP_A"),
      reviseAssessment("CONTEXT_GAP_B"),
      reviseAssessment("CONTEXT_GAP_C"),
    ]);
    const { stack, runId } = await validatableRun(model);

    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(result.reasonCodes).toEqual(["REVISION_ATTEMPTS_EXHAUSTED"]);
    expect(result.exception?.exceptionType).toBe(
      "REVISION_ATTEMPTS_EXHAUSTED",
    );
    expect(result.planVersion).toBe(3);
    expect(result.revisionAttemptsUsed).toBe(MAX_SEMANTIC_REVISION_ATTEMPTS);

    const versions = await stack.plans.listByRunId(runId);
    expect(versions.map((entry) => entry.planVersion)).toEqual([1, 2, 3]);
    expect(versions.map((entry) => entry.status)).toEqual([
      "SUPERSEDED",
      "SUPERSEDED",
      "VALIDATED_APPROVAL_REQUIRED",
    ]);
    expect(model.callCount).toBe(3);

    const decisions = await stack.validation.listDecisions(runId);
    expect(decisions.map((entry) => entry.decision)).toEqual([
      "REVISE",
      "REVISE",
      "HUMAN_APPROVAL_REQUIRED",
    ]);
  });

  it("gives each revised version its own fence and decision", async () => {
    const model = new FakeValidationModel();
    model.queueAssessments([
      reviseAssessment("CONTEXT_GAP_A"),
      reviseAssessment("CONTEXT_GAP_B"),
      reviseAssessment("CONTEXT_GAP_C"),
    ]);
    const { stack, runId } = await validatableRun(model);
    await stack.validation.validate(runId);
    const fences = await stack.validationCoordinator.listByRunId(runId);
    expect(fences.map((fence) => fence.planVersion)).toEqual([1, 2, 3]);
    expect(fences.every((fence) => fence.status === "DECIDED")).toBe(true);
    expect(new Set(fences.map((fence) => fence.planId)).size).toBe(3);
  });

  it("does not revise a plan that also carries a hard violation", async () => {
    const model = new FakeValidationModel();
    model.setReviseRecommendation({ ruleId: "CONTEXT_MISSING_VERIFICATION" });
    const { stack, runId } = await validatableRun(model);
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });
    const result = await stack.validation.validate(runId);
    expect(result.decision).toBe("BLOCK");
    expect((await stack.plans.listByRunId(runId)).length).toBe(1);
  });
});
