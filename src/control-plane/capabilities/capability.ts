import { z } from "zod";

export const CapabilityApprovalRequirementSchema = z.enum([
  "NONE",
  "CONDITIONAL",
  "REQUIRED",
]);
export type CapabilityApprovalRequirement = z.infer<
  typeof CapabilityApprovalRequirementSchema
>;

export const CapabilitySchema = z
  .object({
    capabilityId: z.string().min(1),
    version: z.string().min(1),
    description: z.string().min(1),
    allowedActions: z.array(z.string().min(1)),
    forbiddenActions: z.array(z.string().min(1)),
    allowedEnvironments: z.array(z.string().min(1)).min(1),
    approvalRequirement: CapabilityApprovalRequirementSchema,
    maximumRuntimeSeconds: z.number().int().nonnegative(),
    enabled: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Capability = z.infer<typeof CapabilitySchema>;

export function parseCapability(input: unknown): Capability {
  return CapabilitySchema.parse(input);
}

export const ActionAllowanceReasonSchema = z.enum([
  "ALLOWED",
  "CAPABILITY_NOT_FOUND",
  "CAPABILITY_DISABLED",
  "ENVIRONMENT_NOT_ALLOWED",
  "ACTION_FORBIDDEN",
  "ACTION_NOT_PERMITTED",
]);
export type ActionAllowanceReason = z.infer<typeof ActionAllowanceReasonSchema>;

export type ActionAllowance =
  | { allowed: true; reason: "ALLOWED" }
  | {
      allowed: false;
      reason: Exclude<ActionAllowanceReason, "ALLOWED">;
    };

export function evaluateActionAllowance(
  capability: Capability | null,
  action: string,
  environment: string,
): ActionAllowance {
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
