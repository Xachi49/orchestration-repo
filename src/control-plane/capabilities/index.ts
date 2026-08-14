export {
  CapabilityApprovalRequirementSchema,
  CapabilitySchema,
  ActionAllowanceReasonSchema,
  parseCapability,
  type CapabilityApprovalRequirement,
  type Capability,
  type ActionAllowanceReason,
  type ActionAllowance,
} from "./capability.js";

export type {
  CapabilityRegistry,
  CapabilityRegistryPort,
} from "./registry.js";

/** Phase 0 placeholder name. */
export type { Capability as CapabilityDescriptor } from "./capability.js";
