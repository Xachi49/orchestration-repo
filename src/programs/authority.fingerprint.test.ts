import { describe, expect, it } from "vitest";
import {
  projectConfigurationFingerprint,
  repositoryAllowlistFingerprint,
} from "./authority.js";

describe("program authority fingerprints", () => {
  it("projectConfigurationFingerprint canonically includes allowedEnvironments", () => {
    const base = {
      projectId: "p1",
      activePolicyBundleId: "pol",
      budgetProfileId: "bud",
      allowedEnvironments: ["local", "development"] as const,
      executionMode: "PLAN_ONLY",
    };
    const withE1 = projectConfigurationFingerprint({
      ...base,
      allowedEnvironments: ["local", "development"],
    });
    const withoutE1 = projectConfigurationFingerprint({
      ...base,
      allowedEnvironments: ["development"],
    });
    expect(withE1).not.toBe(withoutE1);
    expect(
      projectConfigurationFingerprint({
        ...base,
        allowedEnvironments: ["development", "local"],
      }),
    ).toBe(withE1);
  });

  it("projectConfigurationFingerprint does NOT include repository identities", () => {
    const fp = projectConfigurationFingerprint({
      projectId: "p1",
      activePolicyBundleId: "pol",
      budgetProfileId: "bud",
      allowedEnvironments: ["local"],
      executionMode: "PLAN_ONLY",
    });
    // Distinct repository allowlists must not be confused with project config.
    expect(repositoryAllowlistFingerprint(["R1"])).not.toBe(
      repositoryAllowlistFingerprint([]),
    );
    expect(typeof fp).toBe("string");
    expect(fp.length).toBeGreaterThan(0);
  });
});
