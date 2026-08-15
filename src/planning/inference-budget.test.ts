import { describe, expect, it } from "vitest";
import { EXAMPLE_BUDGET } from "../control-plane/fixtures.js";
import { createLocalPlanningStack } from "../infrastructure/planning/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { EXAMPLE_COMMIT_SHA } from "../ingestion/fixtures.js";
import { PlanningError } from "./errors.js";
import {
  aggregatePlanningUsage,
  FakePlanningModel,
  FixedPlanningTokenEstimator,
  InMemoryPlanningUsageLedger,
  PlanningInferenceBudget,
  PlanningPreDispatchError,
} from "./index.js";

const TIGHT_OUTPUT = {
  GAP_ANALYSIS: 40,
  PLAN_PROPOSAL: 40,
} as const;

async function admitAndIngest(options?: {
  budgets?: (typeof EXAMPLE_BUDGET)[];
  model?: FakePlanningModel;
  inputEstimate?: number;
  maxOutputTokensByOperation?: {
    GAP_ANALYSIS: number;
    PLAN_PROPOSAL: number;
  };
}) {
  const model = options?.model ?? new FakePlanningModel();
  if (!options?.model) {
    model.setTokenUsagePerCall({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
  }
  const stack = createLocalPlanningStack({
    ...(options?.budgets ? { budgets: options.budgets } : {}),
    model,
    tokenEstimator: new FixedPlanningTokenEstimator(
      options?.inputEstimate ?? 10,
    ),
    maxOutputTokensByOperation:
      options?.maxOutputTokensByOperation ?? TIGHT_OUTPUT,
  });
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  await stack.ingestion.ingest(
    admitted.runId,
    EXAMPLE_PROJECT_ID,
    EXAMPLE_ENVIRONMENT,
  );
  return { stack, runId: admitted.runId };
}

describe("PlanningInferenceBudget", () => {
  it("allows gap analysis + proposal when two LLM calls remain", async () => {
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 2,
      maximumTotalTokens: 200_000,
    };
    const { stack, runId } = await admitAndIngest({ budgets: [budget] });
    const result = await stack.planning.plan(runId);
    expect(result.outcome).toBe("PLANNED");
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(2);
    expect(usage.map((record) => record.operation)).toEqual([
      "GAP_ANALYSIS",
      "PLAN_PROPOSAL",
    ]);
    expect(usage.every((record) => record.status === "SUCCESS")).toBe(true);
    const aggregate = aggregatePlanningUsage(usage);
    expect(aggregate.llmCalls).toBe(2);
    expect(aggregate.totalTokens).toBe(60);
  });

  it("blocks the second model call when maximumLlmCalls is 1", async () => {
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 1,
      maximumTotalTokens: 200_000,
    };
    const { stack, runId } = await admitAndIngest({ budgets: [budget] });
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.operation).toBe("GAP_ANALYSIS");
    expect(usage[0]?.status).toBe("SUCCESS");
    expect(await stack.plans.getByRunId(runId)).toBeNull();
    expect((stack.planningModel as FakePlanningModel).callCount).toBe(1);
  });

  it("blocks another call when token budget is exhausted after the first call", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    });
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 50,
      maximumTotalTokens: 50,
    };
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
      details: expect.objectContaining({ dimension: "maximumTotalTokens" }),
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.totalUsage).toBe(50);
    expect(model.callCount).toBe(1);
  });

  it("accumulates usage across calls", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 40,
      outputTokens: 10,
      totalTokens: 50,
    });
    const { stack, runId } = await admitAndIngest({ model });
    await stack.planning.plan(runId);
    const aggregate = aggregatePlanningUsage(
      await stack.usage.listByRunId(runId),
    );
    expect(aggregate).toEqual({
      llmCalls: 2,
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      completedActualTokens: 100,
      activeReservedTokens: 0,
      budgetInvariantViolated: false,
    });
  });

  it("consumes budget on retries rather than resetting it", async () => {
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 2,
      maximumTotalTokens: 200_000,
    };
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
    model.failNextCall(new Error("simulated model failure"));
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
    });
    await expect(stack.planning.plan(runId)).rejects.toBeTruthy();
    expect((await stack.usage.listByRunId(runId)).length).toBe(1);
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(2);
    expect(usage[0]?.status).toBe("FAILED");
    expect(usage[0]?.charging).toBe("RESERVATION");
    expect(usage[1]?.status).toBe("SUCCESS");
    expect(usage[1]?.operation).toBe("GAP_ANALYSIS");
    expect(await stack.plans.getByRunId(runId)).toBeNull();
  });

  it("does not double-count model calls when reconciling an existing plan", async () => {
    const { stack, runId } = await admitAndIngest();
    await stack.planning.plan(runId);
    const afterFirst = await stack.usage.listByRunId(runId);
    expect(afterFirst).toHaveLength(2);
    const calls = (stack.planningModel as FakePlanningModel).callCount;
    await stack.planning.plan(runId);
    expect((stack.planningModel as FakePlanningModel).callCount).toBe(calls);
    expect(await stack.usage.listByRunId(runId)).toHaveLength(2);
    expect(
      aggregatePlanningUsage(await stack.usage.listByRunId(runId)).llmCalls,
    ).toBe(2);
  });

  it("remains network-free via FakePlanningModel", async () => {
    const { stack, runId } = await admitAndIngest();
    expect(stack.planningModel.provider).toBe("fake");
    await stack.planning.plan(runId);
    expect(await stack.plans.getByRunId(runId)).not.toBeNull();
  });
});

describe("Planning token reservation", () => {
  it("prevents the model call entirely when remaining tokens are insufficient", async () => {
    const model = new FakePlanningModel();
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumTotalTokens: 30,
    };
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
      details: expect.objectContaining({
        requiredReservation: 50,
        remaining: 30,
      }),
    });
    expect(model.callCount).toBe(0);
    expect(await stack.usage.listByRunId(runId)).toHaveLength(0);
  });

  it("reduces available budget by the reservation before invocation", async () => {
    const ledger = new InMemoryPlanningUsageLedger();
    const reservePromise = ledger.reserve({
      callId: "hold",
      runId: "run_hold",
      planningAttempt: 1,
      operation: "GAP_ANALYSIS",
      provider: "fake",
      model: "fake",
      reservedTokens: 70,
      startedAt: "2026-08-14T12:00:00.000Z",
      maximumLlmCalls: 10,
      maximumTotalTokens: 100,
      budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
    });
    await reservePromise;
    const aggregate = aggregatePlanningUsage(
      await ledger.listByRunId("run_hold"),
    );
    expect(aggregate.activeReservedTokens).toBe(70);
    expect(aggregate.completedActualTokens).toBe(0);
    expect(100 - aggregate.totalTokens).toBe(30);

    await expect(
      ledger.reserve({
        callId: "blocked",
        runId: "run_hold",
        planningAttempt: 1,
        operation: "PLAN_PROPOSAL",
        provider: "fake",
        model: "fake",
        reservedTokens: 40,
        startedAt: "2026-08-14T12:00:01.000Z",
        maximumLlmCalls: 10,
        maximumTotalTokens: 100,
        budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
      }),
    ).rejects.toMatchObject({ code: "PLANNING_MODEL_BUDGET_EXCEEDED" });
  });

  it("cannot oversubscribe a run budget with concurrent reservations", async () => {
    const ledger = new InMemoryPlanningUsageLedger();
    const results = await Promise.allSettled([
      ledger.reserve({
        callId: "a",
        runId: "run_race",
        planningAttempt: 1,
        operation: "GAP_ANALYSIS",
        provider: "fake",
        model: "fake",
        reservedTokens: 60,
        startedAt: "2026-08-14T12:00:00.000Z",
        maximumLlmCalls: 10,
        maximumTotalTokens: 100,
        budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
      }),
      ledger.reserve({
        callId: "b",
        runId: "run_race",
        planningAttempt: 1,
        operation: "PLAN_PROPOSAL",
        provider: "fake",
        model: "fake",
        reservedTokens: 60,
        startedAt: "2026-08-14T12:00:00.000Z",
        maximumLlmCalls: 10,
        maximumTotalTokens: 100,
        budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
    });
    const aggregate = aggregatePlanningUsage(
      await ledger.listByRunId("run_race"),
    );
    expect(aggregate.activeReservedTokens).toBe(60);
  });

  it("releases unused capacity when actual usage is below reservation", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    });
    const { stack, runId } = await admitAndIngest({
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await stack.planning.plan(runId);
    const usage = await stack.usage.listByRunId(runId);
    expect(usage.every((r) => r.reservedTokens === 50)).toBe(true);
    expect(usage.every((r) => r.totalUsage === 10)).toBe(true);
    expect(usage.every((r) => r.charging === "ACTUAL")).toBe(true);
    const aggregate = aggregatePlanningUsage(usage);
    expect(aggregate.completedActualTokens).toBe(20);
    expect(aggregate.activeReservedTokens).toBe(0);
  });

  it("conservatively charges the reservation when provider usage is unavailable", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall(undefined);
    const { stack, runId } = await admitAndIngest({
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await stack.planning.plan(runId);
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(2);
    expect(usage.every((r) => r.charging === "RESERVATION")).toBe(true);
    expect(usage.every((r) => r.totalUsage === 50)).toBe(true);
    expect(aggregatePlanningUsage(usage).completedActualTokens).toBe(100);
  });

  it("does not restore potentially consumed budget on timeout/ambiguous dispatch", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    });
    model.failNextCall(
      new PlanningError("PLANNING_MODEL_TIMEOUT", "timed out"),
    );
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 50,
      maximumTotalTokens: 100,
    };
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_TIMEOUT",
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("TIMEOUT");
    expect(usage[0]?.charging).toBe("RESERVATION");
    expect(usage[0]?.totalUsage).toBe(50);
    expect(model.callCount).toBe(1);

    // Remaining 50 can fund gap, but not gap+proposal reservations.
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
    });
    expect(model.callCount).toBe(2);
    const afterRetry = await stack.usage.listByRunId(runId);
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry[1]?.status).toBe("SUCCESS");
    expect(afterRetry[1]?.charging).toBe("ACTUAL");
  });

  it("releases reservation without charging on demonstrable pre-dispatch failure", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
    });
    model.failBeforeDispatch(new PlanningPreDispatchError("not dispatched"));
    const { stack, runId } = await admitAndIngest({
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toBeTruthy();
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.status).toBe("RELEASED");
    expect(usage[0]?.charging).toBe("NONE");
    expect(usage[0]?.totalUsage).toBe(0);
    expect(model.callCount).toBe(0);
    const aggregate = aggregatePlanningUsage(usage);
    expect(aggregate.llmCalls).toBe(0);
    expect(aggregate.completedActualTokens).toBe(0);
    expect(aggregate.activeReservedTokens).toBe(0);

    const again = await stack.planning.plan(runId);
    expect(again.outcome).toBe("PLANNED");
  });

  it("blocks subsequent model calls when actual usage exceeds reservation", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
    });
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 50,
      maximumTotalTokens: 10_000,
    };
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.totalUsage).toBe(100);
    expect(usage[0]?.reservedTokens).toBe(50);
    expect(usage[0]?.budgetInvariantViolation).toBe(true);
    expect(model.callCount).toBe(1);

    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
    });
    expect(model.callCount).toBe(1);
  });

  it("prevents two planning operations from jointly reserving beyond maximumTotalTokens", async () => {
    const model = new FakePlanningModel();
    // Charge full reservation on the first call so remaining cannot fund the second.
    model.setTokenUsagePerCall(undefined);
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 10,
      // Each reservation is 50; after gap charges 50, remaining 40 < 50.
      maximumTotalTokens: 90,
    };
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(1);
    expect(usage[0]?.operation).toBe("GAP_ANALYSIS");
    expect(usage[0]?.charging).toBe("RESERVATION");
    expect(usage[0]?.totalUsage).toBe(50);
    expect(model.callCount).toBe(1);
  });

  it("retries reserve against the same run budget", async () => {
    const model = new FakePlanningModel();
    model.setTokenUsagePerCall({
      inputTokens: 5,
      outputTokens: 5,
      totalTokens: 10,
    });
    model.failNextCall(new Error("boom"));
    const budget = {
      ...EXAMPLE_BUDGET,
      maximumLlmCalls: 3,
      maximumTotalTokens: 100,
    };
    const { stack, runId } = await admitAndIngest({
      budgets: [budget],
      model,
      inputEstimate: 10,
      maxOutputTokensByOperation: { GAP_ANALYSIS: 40, PLAN_PROPOSAL: 40 },
    });
    await expect(stack.planning.plan(runId)).rejects.toBeTruthy();
    expect(aggregatePlanningUsage(await stack.usage.listByRunId(runId))).toEqual(
      expect.objectContaining({
        llmCalls: 1,
        completedActualTokens: 50,
      }),
    );
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_MODEL_BUDGET_EXCEEDED",
    });
    const usage = await stack.usage.listByRunId(runId);
    expect(usage).toHaveLength(2);
    expect(usage[0]?.charging).toBe("RESERVATION");
    expect(usage[1]?.status).toBe("SUCCESS");
    expect(aggregatePlanningUsage(usage).completedActualTokens).toBe(60);
  });

  it("unit: assertCanReserve fails closed without inventing monetary cost", async () => {
    const ledger = new InMemoryPlanningUsageLedger();
    const guard = new PlanningInferenceBudget(ledger);
    await ledger.reserve({
      callId: "c1",
      runId: "run_1",
      planningAttempt: 1,
      operation: "GAP_ANALYSIS",
      provider: "fake",
      model: "fake",
      reservedTokens: 10,
      startedAt: "2026-08-14T12:00:00.000Z",
      maximumLlmCalls: 1,
      maximumTotalTokens: 100,
      budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
    });
    await ledger.settle("c1", {
      outcome: "SUCCESS",
      completedAt: "2026-08-14T12:00:01.000Z",
      charging: "ACTUAL",
      totalUsage: 10,
    });
    await expect(
      guard.assertCanReserve({
        runId: "run_1",
        budget: { ...EXAMPLE_BUDGET, maximumLlmCalls: 1 },
        inputTokenEstimate: 1,
        maxOutputTokens: 1,
      }),
    ).rejects.toMatchObject({ code: "PLANNING_MODEL_BUDGET_EXCEEDED" });
  });
});

describe("planVersion positive integer", () => {
  it("assigns integer planVersion 1 via PlanCompiler", async () => {
    const { stack, runId } = await admitAndIngest();
    const result = await stack.planning.plan(runId);
    expect(result.planVersion).toBe(1);
    const plan = await stack.plans.getByRunId(runId);
    expect(plan?.planVersion).toBe(1);
    expect(plan?.plan.planVersion).toBe(1);
    expect(plan?.plan.repositoryCommitSha).toBe(EXAMPLE_COMMIT_SHA);
  });
});
