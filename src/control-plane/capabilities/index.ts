/**
 * Control-plane: capability registry contracts.
 * Phase 0: types only — no live capability invocation.
 */
export interface CapabilityDescriptor {
  capabilityId: string;
  name: string;
  version: string;
}

export interface CapabilityRegistryPort {
  list(): Promise<readonly CapabilityDescriptor[]>;
}
