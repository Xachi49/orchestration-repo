import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "../errors.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
  EXAMPLE_SUSPENDED_PROJECT,
} from "../fixtures.js";
import { ExecutionModeSchema } from "./project.js";
import { ControlPlaneService } from "../service.js";
import { InMemoryProjectRegistry } from "../../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../../infrastructure/control-plane/in-memory-budget-registry.js";
import { FixedClock } from "../../infrastructure/index.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");

function serviceWith(projects = [EXAMPLE_PROJECT, EXAMPLE_SUSPENDED_PROJECT]) {
  return new ControlPlaneService({
    projects: new InMemoryProjectRegistry(projects),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });
}

describe("Project Registry", () => {
  it("resolves a known project", async () => {
    const registry = new InMemoryProjectRegistry([EXAMPLE_PROJECT]);
    const project = await registry.getById(EXAMPLE_PROJECT_ID);
    expect(project?.projectId).toBe(EXAMPLE_PROJECT_ID);
    expect(await registry.exists(EXAMPLE_PROJECT_ID)).toBe(true);
    expect(await registry.list()).toHaveLength(1);
  });

  it("fails lookup for an unknown project", async () => {
    const registry = new InMemoryProjectRegistry([EXAMPLE_PROJECT]);
    expect(await registry.getById("unknown")).toBeNull();
    expect(await registry.exists("unknown")).toBe(false);
  });

  it("does not allow a suspended project to resolve into a control context", async () => {
    const service = serviceWith();
    await expect(
      service.resolve(EXAMPLE_SUSPENDED_PROJECT.projectId, "local"),
    ).rejects.toMatchObject({
      code: "PROJECT_INACTIVE",
    } satisfies Partial<ControlPlaneError>);
  });

  it("enforces environment restrictions", async () => {
    const service = serviceWith();
    await expect(
      service.resolve(EXAMPLE_PROJECT_ID, "production"),
    ).rejects.toMatchObject({
      code: "ENVIRONMENT_NOT_ALLOWED",
    } satisfies Partial<ControlPlaneError>);
  });

  it("accepts only PLAN_ONLY, SUPERVISED, and PATCH_ONLY execution modes", () => {
    expect(ExecutionModeSchema.options).toEqual([
      "PLAN_ONLY",
      "SUPERVISED",
      "PATCH_ONLY",
    ]);
    expect(EXAMPLE_PROJECT.executionMode).toBe("PATCH_ONLY");
    expect(() => ExecutionModeSchema.parse("LOCAL_MUTATION")).toThrow();
  });
});
