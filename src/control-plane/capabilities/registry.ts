import type { ActionAllowance } from "./capability.js";
import type { Capability } from "./capability.js";

export interface CapabilityRegistry {
  getById(capabilityId: string): Promise<Capability | null>;
  exists(capabilityId: string): Promise<boolean>;
  list(): Promise<readonly Capability[]>;
  /**
   * Deterministic exact-match permission check.
   * Unknown, disabled, or environment-mismatched capabilities are not permitted.
   */
  isActionAllowed(
    capabilityId: string,
    action: string,
    environment: string,
  ): Promise<ActionAllowance>;
}

/** Phase 0 name retained as an alias. */
export type CapabilityRegistryPort = CapabilityRegistry;
