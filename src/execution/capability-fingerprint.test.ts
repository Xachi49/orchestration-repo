import { describe, expect, it } from "vitest";
import { EXAMPLE_CAPABILITIES } from "../control-plane/fixtures.js";
import {
  capabilitySetFingerprint,
  type CapabilityAuthorityFields,
} from "./capability-fingerprint.js";

function asAuthority(
  cap: (typeof EXAMPLE_CAPABILITIES)[number],
): CapabilityAuthorityFields {
  return {
    capabilityId: cap.capabilityId,
    version: cap.version,
    enabled: cap.enabled,
    allowedActions: cap.allowedActions,
    forbiddenActions: cap.forbiddenActions,
    allowedEnvironments: cap.allowedEnvironments,
    approvalRequirement: cap.approvalRequirement,
    maximumRuntimeSeconds: cap.maximumRuntimeSeconds,
  };
}

describe("capabilitySetFingerprint", () => {
  it("changes when only maximumRuntimeSeconds changes", () => {
    const base = asAuthority(
      EXAMPLE_CAPABILITIES.find((c) => c.capabilityId === "CREATE_LOCAL_PATCH")!,
    );
    const a = capabilitySetFingerprint([{ ...base, maximumRuntimeSeconds: 30 }]);
    const b = capabilitySetFingerprint([{ ...base, maximumRuntimeSeconds: 600 }]);
    expect(a).not.toBe(b);
  });

  it("does not change for non-authority metadata", () => {
    const base = asAuthority(
      EXAMPLE_CAPABILITIES.find((c) => c.capabilityId === "RUN_TESTS")!,
    );
    const withMeta = {
      ...base,
      description: "totally different description",
      createdAt: "2099-01-01T00:00:00.000Z",
      updatedAt: "2099-01-02T00:00:00.000Z",
      displayLabel: "Tests",
    };
    expect(capabilitySetFingerprint([base])).toBe(
      capabilitySetFingerprint([withMeta as CapabilityAuthorityFields]),
    );
  });

  it("is invariant to capability insertion order", () => {
    const a = asAuthority(EXAMPLE_CAPABILITIES[0]!);
    const b = asAuthority(EXAMPLE_CAPABILITIES[1]!);
    expect(capabilitySetFingerprint([a, b])).toBe(
      capabilitySetFingerprint([b, a]),
    );
  });

  it("is invariant to action array order", () => {
    const base = asAuthority(
      EXAMPLE_CAPABILITIES.find((c) => c.capabilityId === "CREATE_LOCAL_PATCH")!,
    );
    const shuffled = {
      ...base,
      allowedActions: [...base.allowedActions].reverse(),
      allowedEnvironments: [...base.allowedEnvironments].reverse(),
    };
    expect(capabilitySetFingerprint([base])).toBe(
      capabilitySetFingerprint([shuffled]),
    );
  });
});
