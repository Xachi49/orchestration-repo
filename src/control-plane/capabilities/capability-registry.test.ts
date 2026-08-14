import { describe, expect, it } from "vitest";
import { EXAMPLE_CAPABILITIES } from "../fixtures.js";
import { InMemoryCapabilityRegistry } from "../../infrastructure/control-plane/in-memory-capability-registry.js";

describe("Capability Registry", () => {
  const registry = new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES);

  it("allows an explicitly permitted action", async () => {
    const result = await registry.isActionAllowed(
      "READ_FILE",
      "READ_FILE",
      "local",
    );
    expect(result).toEqual({ allowed: true, reason: "ALLOWED" });
  });

  it("denies a forbidden action", async () => {
    const result = await registry.isActionAllowed(
      "CREATE_LOCAL_PATCH",
      "PUSH_TO_MAIN",
      "local",
    );
    expect(result).toEqual({ allowed: false, reason: "ACTION_FORBIDDEN" });
  });

  it("denies a disabled capability", async () => {
    const result = await registry.isActionAllowed(
      "PUSH_TO_MAIN",
      "PUSH_TO_MAIN",
      "local",
    );
    expect(result).toEqual({ allowed: false, reason: "CAPABILITY_DISABLED" });
  });

  it("denies an invalid environment", async () => {
    const result = await registry.isActionAllowed(
      "READ_FILE",
      "READ_FILE",
      "production",
    );
    expect(result).toEqual({
      allowed: false,
      reason: "ENVIRONMENT_NOT_ALLOWED",
    });
  });

  it("fails closed for an unknown capability", async () => {
    expect(await registry.exists("NOT_A_CAPABILITY")).toBe(false);
    const result = await registry.isActionAllowed(
      "NOT_A_CAPABILITY",
      "READ_FILE",
      "local",
    );
    expect(result).toEqual({ allowed: false, reason: "CAPABILITY_NOT_FOUND" });
  });

  it("does not infer permission for actions missing from allowedActions", async () => {
    const result = await registry.isActionAllowed(
      "READ_FILE",
      "CREATE_LOCAL_PATCH",
      "local",
    );
    expect(result).toEqual({ allowed: false, reason: "ACTION_NOT_PERMITTED" });
  });
});
