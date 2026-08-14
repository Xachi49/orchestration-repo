import { describe, expect, it } from "vitest";
import { EXAMPLE_BUDGET } from "../fixtures.js";
import {
  compareBudget,
  type BudgetResourceEstimate,
} from "./index.js";
import { InMemoryResourceBudgetRegistry } from "../../infrastructure/control-plane/in-memory-budget-registry.js";

function estimate(
  overrides: Partial<BudgetResourceEstimate> = {},
): BudgetResourceEstimate {
  return {
    llmCalls: 10,
    totalTokens: 1000,
    apiCalls: 5,
    executionMinutes: 5,
    estimatedCost: 2,
    humanReviewMinutes: 10,
    planSteps: 8,
    parallelWorkstreams: 1,
    revisionAttempts: 1,
    ...overrides,
  };
}

describe("Resource Budgets", () => {
  it("resolves known profiles and rejects unknown ids", async () => {
    const registry = new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]);
    expect(await registry.exists(EXAMPLE_BUDGET.budgetProfileId)).toBe(true);
    expect(await registry.getById("missing")).toBeNull();
    expect(await registry.list()).toHaveLength(1);
  });

  it("passes when all estimates are inside limits", () => {
    const result = compareBudget(estimate(), EXAMPLE_BUDGET);
    expect(result).toEqual({ result: "WITHIN_BUDGET" });
  });

  it("fails when a single limit is exceeded", () => {
    const result = compareBudget(
      estimate({ planSteps: EXAMPLE_BUDGET.maximumPlanSteps + 1 }),
      EXAMPLE_BUDGET,
    );
    expect(result.result).toBe("BUDGET_EXCEEDED");
    if (result.result === "BUDGET_EXCEEDED") {
      expect(result.exceeded).toEqual(["planSteps"]);
    }
  });

  it("fails when multiple limits are exceeded", () => {
    const result = compareBudget(
      estimate({
        llmCalls: EXAMPLE_BUDGET.maximumLlmCalls + 1,
        estimatedCost: EXAMPLE_BUDGET.maximumEstimatedCost + 1,
      }),
      EXAMPLE_BUDGET,
    );
    expect(result.result).toBe("BUDGET_EXCEEDED");
    if (result.result === "BUDGET_EXCEEDED") {
      expect(result.exceeded).toEqual(["llmCalls", "estimatedCost"]);
    }
  });

  it("returns UNESTIMATED_RESOURCE when a required estimate is missing", () => {
    const { llmCalls: _omit, ...partial } = estimate();
    const result = compareBudget(partial, EXAMPLE_BUDGET);
    expect(result.result).toBe("UNESTIMATED_RESOURCE");
    if (result.result === "UNESTIMATED_RESOURCE") {
      expect(result.missing).toEqual(["llmCalls"]);
    }
  });

  it("treats boundary values as within budget", () => {
    const atLimit = estimate({
      llmCalls: EXAMPLE_BUDGET.maximumLlmCalls,
      totalTokens: EXAMPLE_BUDGET.maximumTotalTokens,
      apiCalls: EXAMPLE_BUDGET.maximumApiCalls,
      executionMinutes: EXAMPLE_BUDGET.maximumExecutionMinutes,
      estimatedCost: EXAMPLE_BUDGET.maximumEstimatedCost,
      humanReviewMinutes: EXAMPLE_BUDGET.maximumHumanReviewMinutes,
      planSteps: EXAMPLE_BUDGET.maximumPlanSteps,
      parallelWorkstreams: EXAMPLE_BUDGET.maximumParallelWorkstreams,
      revisionAttempts: EXAMPLE_BUDGET.maximumRevisionAttempts,
    });
    expect(compareBudget(atLimit, EXAMPLE_BUDGET)).toEqual({
      result: "WITHIN_BUDGET",
    });
  });

  it("does not enforce allowedExecutionWindows in Phase 1 comparison", () => {
    const inside = estimate();
    const withoutWindows = {
      ...EXAMPLE_BUDGET,
      allowedExecutionWindows: [],
    };
    expect(compareBudget(inside, EXAMPLE_BUDGET)).toEqual({
      result: "WITHIN_BUDGET",
    });
    expect(compareBudget(inside, withoutWindows)).toEqual({
      result: "WITHIN_BUDGET",
    });
  });
});
