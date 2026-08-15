import { ControlPlaneError } from "./errors.js";
import type { CapabilityRegistry } from "./capabilities/registry.js";
import type { PolicyRegistry } from "./policies/registry.js";
import type { ProjectRegistry } from "./projects/registry.js";
import type { ResourceBudgetRegistry } from "./budgets/registry.js";
import type { ProjectControlContext } from "./context.js";

/** Minimal clock port so control-plane does not depend on infrastructure. */
export interface ControlPlaneClock {
  nowIso(): string;
}

export interface ControlPlaneServiceDeps {
  projects: ProjectRegistry;
  capabilities: CapabilityRegistry;
  policies: PolicyRegistry;
  budgets: ResourceBudgetRegistry;
  clock: ControlPlaneClock;
}

/**
 * Assembles authoritative project control context.
 * Configuration authority only — does not execute, approve, or plan.
 */
export class ControlPlaneService {
  private readonly projects: ProjectRegistry;
  private readonly capabilities: CapabilityRegistry;
  private readonly policies: PolicyRegistry;
  private readonly budgets: ResourceBudgetRegistry;
  private readonly clock: ControlPlaneClock;

  constructor(deps: ControlPlaneServiceDeps) {
    this.projects = deps.projects;
    this.capabilities = deps.capabilities;
    this.policies = deps.policies;
    this.budgets = deps.budgets;
    this.clock = deps.clock;
  }

  /**
   * The single Control Plane capability authority backing resolve().
   * Validation/execution services may hold this same reference; they must not
   * substitute an independent registry.
   */
  capabilityRegistry(): CapabilityRegistry {
    return this.capabilities;
  }

  async resolve(
    projectId: string,
    environment: string,
  ): Promise<ProjectControlContext> {
    const project = await this.projects.getById(projectId);
    if (!project) {
      throw new ControlPlaneError(
        "PROJECT_NOT_FOUND",
        `Project not found: ${projectId}`,
        { projectId },
      );
    }

    if (project.status !== "ACTIVE") {
      throw new ControlPlaneError(
        "PROJECT_INACTIVE",
        `Project is not ACTIVE: ${projectId}`,
        { projectId, status: project.status },
      );
    }

    if (!project.allowedEnvironments.includes(environment)) {
      throw new ControlPlaneError(
        "ENVIRONMENT_NOT_ALLOWED",
        `Environment ${environment} is not allowed for project ${projectId}`,
        {
          projectId,
          environment,
          allowedEnvironments: project.allowedEnvironments,
        },
      );
    }

    const activePolicyBundle = await this.policies.getActiveBundleForProject(
      projectId,
      environment,
    );

    if (activePolicyBundle.policyBundleId !== project.activePolicyBundleId) {
      throw new ControlPlaneError(
        "POLICY_CONFLICT",
        "Resolved active policy bundle does not match the project's declared bundle",
        {
          projectId,
          declaredPolicyBundleId: project.activePolicyBundleId,
          resolvedPolicyBundleId: activePolicyBundle.policyBundleId,
        },
      );
    }

    const resourceBudget = await this.budgets.getById(
      project.resourceBudgetProfileId,
    );
    if (!resourceBudget) {
      throw new ControlPlaneError(
        "BUDGET_PROFILE_NOT_FOUND",
        `Budget profile not found: ${project.resourceBudgetProfileId}`,
        {
          projectId,
          resourceBudgetProfileId: project.resourceBudgetProfileId,
        },
      );
    }

    const allCapabilities = await this.capabilities.list();
    const availableCapabilities = allCapabilities.filter(
      (capability) =>
        capability.enabled &&
        capability.allowedEnvironments.includes(environment),
    );

    return {
      project,
      activePolicyBundle,
      resourceBudget,
      availableCapabilities,
      environment,
      resolvedAt: this.clock.nowIso(),
    };
  }
}
