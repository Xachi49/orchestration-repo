import {
  BUDGET_DIMENSIONS,
  BUDGET_LIMIT_BY_DIMENSION,
  type BudgetComparisonResult,
  type BudgetDimension,
  type BudgetResourceEstimate,
  type ResourceBudgetProfile,
} from "./budget.js";

export type BudgetComparison =
  | { result: "WITHIN_BUDGET" }
  | { result: "BUDGET_EXCEEDED"; exceeded: readonly BudgetDimension[] }
  | { result: "UNESTIMATED_RESOURCE"; missing: readonly BudgetDimension[] };

function isPresentNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Pure comparison of a resource estimate against a budget profile.
 * Missing estimate fields fail closed as UNESTIMATED_RESOURCE.
 * Values equal to a maximum are within budget.
 * Does not evaluate allowedExecutionWindows (stored configuration only).
 */
export function compareBudget(
  estimate: Partial<BudgetResourceEstimate>,
  profile: ResourceBudgetProfile,
): BudgetComparison {
  const missing: BudgetDimension[] = [];
  const exceeded: BudgetDimension[] = [];

  for (const dimension of BUDGET_DIMENSIONS) {
    const estimateValue = estimate[dimension];
    if (!isPresentNumber(estimateValue)) {
      missing.push(dimension);
      continue;
    }
    const limitKey = BUDGET_LIMIT_BY_DIMENSION[dimension];
    const limit = profile[limitKey];
    if (estimateValue > limit) {
      exceeded.push(dimension);
    }
  }

  if (missing.length > 0) {
    return { result: "UNESTIMATED_RESOURCE", missing };
  }
  if (exceeded.length > 0) {
    return { result: "BUDGET_EXCEEDED", exceeded };
  }
  return { result: "WITHIN_BUDGET" };
}

export function budgetComparisonResult(
  estimate: Partial<BudgetResourceEstimate>,
  profile: ResourceBudgetProfile,
): BudgetComparisonResult {
  return compareBudget(estimate, profile).result;
}
