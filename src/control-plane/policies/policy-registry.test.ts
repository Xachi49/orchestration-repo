import { describe, expect, it } from "vitest";
import { ControlPlaneError } from "../errors.js";
import {
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT_ID,
} from "../fixtures.js";
import type { PolicyBundle } from "./policy.js";
import { InMemoryPolicyRegistry } from "../../infrastructure/control-plane/in-memory-policy-registry.js";
import { FixedClock } from "../../infrastructure/index.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");

function bundle(overrides: Partial<PolicyBundle>): PolicyBundle {
  return {
    ...EXAMPLE_POLICY_BUNDLE,
    ...overrides,
  };
}

describe("Policy Registry", () => {
  it("resolves the correct active bundle", async () => {
    const registry = new InMemoryPolicyRegistry(
      [
        bundle({
          policyBundleId: "pol_old",
          semanticVersion: "0.9.0",
          status: "SUPERSEDED",
          supersedes: null,
        }),
        EXAMPLE_POLICY_BUNDLE,
      ],
      { clock },
    );

    const active = await registry.getActiveBundleForProject(
      EXAMPLE_PROJECT_ID,
      "local",
    );
    expect(active.policyBundleId).toBe(EXAMPLE_POLICY_BUNDLE.policyBundleId);
  });

  it("does not select a superseded bundle", async () => {
    const registry = new InMemoryPolicyRegistry(
      [
        bundle({
          policyBundleId: "pol_superseded",
          status: "SUPERSEDED",
        }),
      ],
      { clock },
    );

    await expect(
      registry.getActiveBundleForProject(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "POLICY_BUNDLE_NOT_FOUND",
    } satisfies Partial<ControlPlaneError>);
  });

  it("does not select a revoked bundle", async () => {
    const registry = new InMemoryPolicyRegistry(
      [
        bundle({
          policyBundleId: "pol_revoked",
          status: "REVOKED",
        }),
      ],
      { clock },
    );

    await expect(
      registry.getActiveBundleForProject(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "POLICY_BUNDLE_NOT_FOUND",
    } satisfies Partial<ControlPlaneError>);
  });

  it("fails when no active bundle exists", async () => {
    const registry = new InMemoryPolicyRegistry([], { clock });
    await expect(
      registry.getActiveBundleForProject(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "POLICY_BUNDLE_NOT_FOUND",
    } satisfies Partial<ControlPlaneError>);
  });

  it("fails closed when multiple active bundles conflict", async () => {
    const registry = new InMemoryPolicyRegistry(
      [
        EXAMPLE_POLICY_BUNDLE,
        bundle({
          policyBundleId: "pol_conflict",
          semanticVersion: "1.1.0",
          status: "ACTIVE",
        }),
      ],
      { clock },
    );

    await expect(
      registry.getActiveBundleForProject(EXAMPLE_PROJECT_ID, "local"),
    ).rejects.toMatchObject({
      code: "POLICY_CONFLICT",
    } satisfies Partial<ControlPlaneError>);
  });

  it("lists lineage versions via supersedes", async () => {
    const v1 = bundle({
      policyBundleId: "pol_v1",
      semanticVersion: "1.0.0",
      status: "SUPERSEDED",
      supersedes: null,
      effectiveAt: "2026-01-01T00:00:00.000Z",
    });
    const v2 = bundle({
      policyBundleId: "pol_v2",
      semanticVersion: "2.0.0",
      status: "ACTIVE",
      supersedes: "pol_v1",
      effectiveAt: "2026-06-01T00:00:00.000Z",
    });
    const registry = new InMemoryPolicyRegistry([v1, v2], { clock });
    const versions = await registry.listVersions("pol_v2");
    expect(versions.map((item) => item.policyBundleId)).toEqual([
      "pol_v1",
      "pol_v2",
    ]);
  });
});
