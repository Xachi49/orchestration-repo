export {
  ExecutionWindowSchema,
  ResourceBudgetProfileSchema,
  BudgetResourceEstimateSchema,
  BudgetComparisonResultSchema,
  BUDGET_DIMENSIONS,
  BUDGET_LIMIT_BY_DIMENSION,
  parseResourceBudgetProfile,
  type ExecutionWindow,
  type ResourceBudgetProfile,
  type BudgetResourceEstimate,
  type BudgetComparisonResult,
  type BudgetDimension,
} from "./budget.js";

export {
  compareBudget,
  budgetComparisonResult,
  type BudgetComparison,
} from "./compare.js";

export type {
  ResourceBudgetRegistry,
  BudgetRegistryPort,
} from "./registry.js";

/** Phase 0 placeholder name. */
export type { ResourceBudgetProfile as BudgetLimit } from "./budget.js";
