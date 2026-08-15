import { compareBudget } from "../control-plane/budgets/compare.js";
import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import type { PlanProposal } from "./proposal.js";
import { PlanningError } from "./errors.js";

export interface PlanResourceAnalysis {
  estimatedDurationMinutes: number;
  estimatedLlmTokens: number;
  estimatedApiCalls: number;
  estimatedHumanMinutes: number;
  estimatedCost: number;
  maximumParallelWorkstreams: number;
  planStepCount: number;
  estimatedLlmCalls: number;
  classification: "WITHIN_BUDGET" | "BUDGET_EXCEEDED" | "UNESTIMATED_RESOURCE";
}

/**
 * Deterministic totals from model proposals; never silently expands budgets.
 * Hard budget exceed on *proposed execution* estimates → Phase 4 failure
 * (`PLAN_RESOURCE_BUDGET_EXCEEDED`), not READY_FOR_VALIDATION.
 * Distinct from planning-inference usage (`PLANNING_MODEL_BUDGET_EXCEEDED`).
 */
export class PlanResourceAnalyzer {
  analyze(
    proposal: PlanProposal,
    budget: ResourceBudgetProfile,
  ): PlanResourceAnalysis {
    const totals = proposal.proposedResourceTotals;
    const stepTokenSum = proposal.steps.reduce(
      (sum, step) => sum + (step.resourceEstimate.tokenEstimate ?? 0),
      0,
    );
    const stepDurationMs = proposal.steps.reduce(
      (sum, step) => sum + (step.resourceEstimate.durationMs ?? 0),
      0,
    );
    const stepCost = proposal.steps.reduce(
      (sum, step) => sum + (step.resourceEstimate.costEstimateUsd ?? 0),
      0,
    );

    const estimatedDurationMinutes = Math.max(
      totals.estimatedDurationMinutes,
      Math.ceil(stepDurationMs / 60_000),
    );
    const estimatedLlmTokens = Math.max(
      totals.estimatedLlmTokens,
      stepTokenSum,
    );
    const estimatedCost = Math.max(totals.estimatedCost, stepCost);
    const estimatedApiCalls = totals.estimatedApiCalls;
    const estimatedHumanMinutes = totals.estimatedHumanMinutes;
    const maximumParallelWorkstreams = totals.maximumParallelWorkstreams;
    const planStepCount = proposal.steps.length;
    const estimatedLlmCalls = totals.estimatedLlmCalls ?? 1;

    const comparison = compareBudget(
      {
        llmCalls: estimatedLlmCalls,
        totalTokens: estimatedLlmTokens,
        apiCalls: estimatedApiCalls,
        executionMinutes: estimatedDurationMinutes,
        estimatedCost,
        humanReviewMinutes: estimatedHumanMinutes,
        planSteps: planStepCount,
        parallelWorkstreams: maximumParallelWorkstreams,
        revisionAttempts: 0,
      },
      budget,
    );

    if (comparison.result === "UNESTIMATED_RESOURCE") {
      throw new PlanningError(
        "PLAN_RESOURCE_UNESTIMATED",
        "Plan is missing required resource estimates",
        { missing: comparison.missing },
      );
    }
    if (comparison.result === "BUDGET_EXCEEDED") {
      throw new PlanningError(
        "PLAN_RESOURCE_BUDGET_EXCEEDED",
        "Plan exceeds hard resource budget ceilings",
        { exceeded: comparison.exceeded },
      );
    }

    return {
      estimatedDurationMinutes,
      estimatedLlmTokens,
      estimatedApiCalls,
      estimatedHumanMinutes,
      estimatedCost,
      maximumParallelWorkstreams,
      planStepCount,
      estimatedLlmCalls,
      classification: "WITHIN_BUDGET",
    };
  }
}
