import {
  parseCapability,
  type ActionAllowance,
  type Capability,
} from "../../control-plane/capabilities/capability.js";
import type { CapabilityRegistry } from "../../control-plane/capabilities/registry.js";

export class InMemoryCapabilityRegistry implements CapabilityRegistry {
  private readonly capabilities: ReadonlyMap<string, Capability>;

  constructor(seed: readonly Capability[] = []) {
    const map = new Map<string, Capability>();
    for (const item of seed) {
      const capability = parseCapability(item);
      if (map.has(capability.capabilityId)) {
        throw new Error(
          `Duplicate capabilityId in seed: ${capability.capabilityId}`,
        );
      }
      map.set(capability.capabilityId, Object.freeze(capability));
    }
    this.capabilities = map;
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
