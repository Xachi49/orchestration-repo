/**
 * Control-plane: budget contracts.
 * Phase 0: types only — no spend enforcement yet.
 */
export interface BudgetLimit {
  budgetId: string;
  projectId: string;
  maxCostUsd: number;
  currency: "USD";
}

export interface BudgetRegistryPort {
  getProjectBudget(projectId: string): Promise<BudgetLimit | null>;
}
