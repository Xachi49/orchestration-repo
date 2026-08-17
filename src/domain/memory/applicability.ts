import { z } from "zod";

export const ScopeClassSchema = z.enum([
  "RUN_LOCAL",
  "PROJECT_LOCAL",
  "PROJECT_CLASS",
  "GLOBAL_ADVISORY",
]);
export type ScopeClass = z.infer<typeof ScopeClassSchema>;

export const RiskClassSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type RiskClass = z.infer<typeof RiskClassSchema>;

/**
 * Deterministic applicability envelope for candidates and precedents.
 * Default scopeClass is PROJECT_LOCAL — widening requires explicit human decision.
 */
export const PrecedentApplicabilitySchema = z
  .object({
    scopeClass: ScopeClassSchema.default("PROJECT_LOCAL"),
    projectIds: z.array(z.string().min(1)).min(1),
    objectiveClasses: z.array(z.string()).default([]),
    repositoryCharacteristics: z.array(z.string()).default([]),
    actionTypes: z.array(z.string()).default([]),
    capabilityIds: z.array(z.string()).default([]),
    environments: z.array(z.string()).default([]),
    executionModes: z.array(z.string()).default([]),
    riskClasses: z.array(RiskClassSchema).default(["LOW"]),
    outcomeTypes: z.array(z.string()).default([]),
    policyBundleCompatibility: z.array(z.string()).default([]),
    technologyTags: z.array(z.string()).default([]),
  })
  .strict();

export type PrecedentApplicability = z.infer<
  typeof PrecedentApplicabilitySchema
>;

export function parsePrecedentApplicability(
  input: unknown,
): PrecedentApplicability {
  return PrecedentApplicabilitySchema.parse(input);
}
