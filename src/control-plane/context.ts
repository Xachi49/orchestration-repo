import type { Capability } from "./capabilities/capability.js";
import type { PolicyBundle } from "./policies/policy.js";
import type { Project } from "./projects/project.js";
import type { ResourceBudgetProfile } from "./budgets/budget.js";

export interface ProjectControlContext {
  project: Project;
  activePolicyBundle: PolicyBundle;
  resourceBudget: ResourceBudgetProfile;
  availableCapabilities: readonly Capability[];
  environment: string;
  resolvedAt: string;
}
