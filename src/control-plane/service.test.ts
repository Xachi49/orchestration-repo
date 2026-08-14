import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "./errors.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "./fixtures.js";
import { ControlPlaneService } from "./service.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { FixedClock } from "../infrastructure/index.js";
import type { Project } from "./projects/project.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");

function buildService(options?: {
  projects?: readonly Project[];
  policies?: readonly typeof EXAMPLE_POLICY_BUNDLE[];
  budgets?: readonly typeof EXAMPLE_BUDGET[];
}) {
  return new ControlPlaneService({
    projects: new InMemoryProjectRegistry(options?.projects ?? [EXAMPLE_PROJECT]),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry(
      options?.policies ?? [EXAMPLE_POLICY_BUNDLE],
      { clock },
    ),
    budgets: new InMemoryResourceBudgetRegistry(
      options?.budgets ?? [EXAMPLE_BUDGET],
    ),
    clock,
  });
}

describe("ControlPlaneService", () => {
  it("resolves a complete project control context", async () => {
    const service = buildService();
    const context = await service.resolve(EXAMPLE_PROJECT_ID, "local");

    expect(context.project.projectId).toBe(EXAMPLE_PROJECT_ID);
    expect(context.activePolicyBundle.policyBundleId).toBe(
      EXAMPLE_POLICY_BUNDLE.policyBundleId,
    );
    expect(context.resourceBudget.budgetProfileId).toBe(
      EXAMPLE_BUDGET.budgetProfileId,
    );
    expect(context.environment).toBe("local");
    expect(context.resolvedAt).toBe("2026-08-14T12:00:00.000Z");
    expect(
      context.availableCapabilities.map((item) => item.capabilityId).sort(),
    ).toEqual(
      [
        "CREATE_LOCAL_PATCH",
        "CREATE_TASK",
        "PREPARE_PULL_REQUEST",
        "READ_FILE",
        "RUN_TESTS",
      ].sort(),
    );
  });

  it("fails when the project is missing", async () => {
    const service = buildService();
    await expect(service.resolve("missing", "local")).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    } satisfies Partial<ControlPlaneError>);
  });

  it("fails when the active policy bundle is missing", async () => {
    const service = buildService({ policies: [] });
    await expect(
      service.resolve(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "POLICY_BUNDLE_NOT_FOUND",
    } satisfies Partial<ControlPlaneError>);
  });

  it("fails when the budget profile is missing", async () => {
    const service = buildService({ budgets: [] });
    await expect(
      service.resolve(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "BUDGET_PROFILE_NOT_FOUND",
    } satisfies Partial<ControlPlaneError>);
  });

  it("fails for an invalid environment", async () => {
    const service = buildService();
    await expect(
      service.resolve(EXAMPLE_PROJECT_ID, "production"),
    ).rejects.toMatchObject({
      code: "ENVIRONMENT_NOT_ALLOWED",
    } satisfies Partial<ControlPlaneError>);
  });

  it("does not expose disabled capabilities as available", async () => {
    const service = buildService();
    const context = await service.resolve(EXAMPLE_PROJECT_ID, "local");
    const ids = context.availableCapabilities.map((item) => item.capabilityId);
    expect(ids).not.toContain("PUSH_TO_MAIN");
    expect(ids).not.toContain("DELETE_REPOSITORY");
    expect(ids).not.toContain("CHANGE_ACCESS_CONTROL");
    expect(ids).not.toContain("DEPLOY_PRODUCTION");
    expect(
      context.availableCapabilities.every((capability) => capability.enabled),
    ).toBe(true);
  });

  it("fails closed when the unique ACTIVE bundle does not match the project's declared id", async () => {
    const mismatched = {
      ...EXAMPLE_PROJECT,
      activePolicyBundleId: "pol_declared_but_not_resolved",
    };
    const service = buildService({ projects: [mismatched] });
    await expect(
      service.resolve(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "POLICY_CONFLICT",
    } satisfies Partial<ControlPlaneError>);
  });
});
