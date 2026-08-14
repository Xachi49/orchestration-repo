import { z } from "zod";

export const PolicyStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "SUPERSEDED",
  "REVOKED",
]);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

export const PolicyEffectSchema = z.enum([
  "ALLOW",
  "DENY",
  "REQUIRE_APPROVAL",
]);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

/**
 * Stored condition records. Phase 1 does not evaluate these.
 * They are canonical data for a future deterministic policy engine.
 */
export const PolicyConditionSchema = z
  .object({
    attribute: z.string().min(1),
    operator: z.enum(["EQ", "NEQ", "IN", "NOT_IN"]),
    value: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  })
  .strict();
export type PolicyCondition = z.infer<typeof PolicyConditionSchema>;

export const PolicyRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    description: z.string().min(1),
    effect: PolicyEffectSchema,
    actionTypes: z.array(z.string().min(1)),
    environments: z.array(z.string().min(1)),
    conditions: z.array(PolicyConditionSchema),
    reasonCode: z.string().min(1),
  })
  .strict();
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const PolicyBundleSchema = z
  .object({
    policyBundleId: z.string().min(1),
    semanticVersion: z.string().min(1),
    policyHash: z.string().min(1),
    effectiveAt: z.string().datetime(),
    supersedes: z.string().min(1).nullable(),
    applicableProjectIds: z.array(z.string().min(1)),
    applicableEnvironments: z.array(z.string().min(1)),
    approvedBy: z.string().min(1),
    status: PolicyStatusSchema,
    rules: z.array(PolicyRuleSchema),
    createdAt: z.string().datetime(),
  })
  .strict();
export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;

export function parsePolicyBundle(input: unknown): PolicyBundle {
  return PolicyBundleSchema.parse(input);
}
