import {
  parseResourceBudgetProfile,
  type ResourceBudgetProfile,
} from "../../control-plane/budgets/budget.js";
import type { ResourceBudgetRegistry } from "../../control-plane/budgets/registry.js";

export class InMemoryResourceBudgetRegistry implements ResourceBudgetRegistry {
  private readonly profiles: ReadonlyMap<string, ResourceBudgetProfile>;

  constructor(seed: readonly ResourceBudgetProfile[] = []) {
    const map = new Map<string, ResourceBudgetProfile>();
    for (const item of seed) {
      const profile = parseResourceBudgetProfile(item);
      if (map.has(profile.budgetProfileId)) {
        throw new Error(
          `Duplicate budgetProfileId in seed: ${profile.budgetProfileId}`,
        );
      }
      map.set(profile.budgetProfileId, Object.freeze(profile));
    }
    this.profiles = map;
  }

  async getById(
    budgetProfileId: string,
  ): Promise<ResourceBudgetProfile | null> {
    return this.profiles.get(budgetProfileId) ?? null;
  }

  async exists(budgetProfileId: string): Promise<boolean> {
    return this.profiles.has(budgetProfileId);
  }

  async list(): Promise<readonly ResourceBudgetProfile[]> {
    return [...this.profiles.values()];
  }
}
