import type { ResourceBudgetProfile } from "./budget.js";

export interface ResourceBudgetRegistry {
  getById(budgetProfileId: string): Promise<ResourceBudgetProfile | null>;
  exists(budgetProfileId: string): Promise<boolean>;
  list(): Promise<readonly ResourceBudgetProfile[]>;
}

/** Phase 0 name retained as an alias. */
export type BudgetRegistryPort = ResourceBudgetRegistry;
