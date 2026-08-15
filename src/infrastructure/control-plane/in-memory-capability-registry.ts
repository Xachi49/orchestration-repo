import {
  parseCapability,
  type ActionAllowance,
  type Capability,
} from "../../control-plane/capabilities/capability.js";
import type { CapabilityRegistry } from "../../control-plane/capabilities/registry.js";

/**
 * In-memory CapabilityRegistry — the single Control Plane capability authority
 * when wired into ControlPlaneService.
 */
export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly capabilities: Map<string, Capability>;

  constructor(seed: readonly Capability[] = []) {
    this.capabilities = new Map();
    for (const item of seed) {
      const capability = parseCapability(item);
      if (this.capabilities.has(capability.capabilityId)) {
        throw new Error(
          `Duplicate capabilityId in seed: ${capability.capabilityId}`,
        );
      }
      this.capabilities.set(capability.capabilityId, Object.freeze(capability));
    }
  }

  /**
   * Replace an existing capability in the single authoritative registry.
   * Used for config-reload / drift tests — not a parallel capability truth.
   */
  replace(input: Capability): Capability {
    const capability = parseCapability(input);
    if (!this.capabilities.has(capability.capabilityId)) {
      throw new Error(
        `Cannot replace unknown capabilityId: ${capability.capabilityId}`,
      );
    }
    this.capabilities.set(capability.capabilityId, Object.freeze(capability));
    return capability;
  }

  async getById(capabilityId: string): Promise<Capability | null> {
    return this.capabilities.get(capabilityId) ?? null;
  }

  async exists(capabilityId: string): Promise<boolean> {
    return this.capabilities.has(capabilityId);
  }

  async list(): Promise<readonly Capability[]> {
    return [...this.capabilities.values()];
  }

  async isActionAllowed(
    capabilityId: string,
    action: string,
    environment: string,
  ): Promise<ActionAllowance> {
    const capability = this.capabilities.get(capabilityId);
    if (!capability) {
      return { allowed: false, reason: "CAPABILITY_NOT_FOUND" };
    }
    if (!capability.enabled) {
      return { allowed: false, reason: "CAPABILITY_DISABLED" };
    }
    if (!capability.allowedEnvironments.includes(environment)) {
      return { allowed: false, reason: "ENVIRONMENT_NOT_ALLOWED" };
    }
    if (capability.forbiddenActions.includes(action)) {
      return { allowed: false, reason: "ACTION_FORBIDDEN" };
    }
    if (!capability.allowedActions.includes(action)) {
      return { allowed: false, reason: "ACTION_NOT_PERMITTED" };
    }
    return { allowed: true, reason: "ALLOWED" };
  }
}
