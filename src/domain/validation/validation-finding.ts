import { z } from "zod";

export const ValidationValidatorTypeSchema = z.enum([
  "SCHEMA",
  "STATE",
  "FRESHNESS",
  "POLICY",
  "CAPABILITY",
  "DEPENDENCY",
  "RESOURCE",
  "SECURITY",
  "VERIFICATION_BINDING",
  "CONTEXTUAL",
]);
export type ValidationValidatorType = z.infer<
  typeof ValidationValidatorTypeSchema
>;

export const ValidationFindingSeveritySchema = z.enum([
  "INFO",
  "WARNING",
  "ERROR",
  "CRITICAL",
]);
export type ValidationFindingSeverity = z.infer<
  typeof ValidationFindingSeveritySchema
>;

/**
 * Canonical Phase 5 validation finding.
 * Structured only — never prose-only validator output.
 */
export const ValidationFindingSchema = z
  .object({
    findingId: z.string().min(1),
    validatorType: ValidationValidatorTypeSchema,
    category: z.string().min(1),
    severity: ValidationFindingSeveritySchema,
    ruleId: z.string().min(1),
    message: z.string().min(1),
    evidenceRefs: z.array(z.string()),
    affectedStepIds: z.array(z.string()),
    repairable: z.boolean(),
    approvalEligible: z.boolean(),
    blocking: z.boolean(),
    semanticFingerprint: z.string().min(1),
    metadata: z.record(z.unknown()).default({}),
  })
  .strict();

export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;

export function parseValidationFinding(input: unknown): ValidationFinding {
  return ValidationFindingSchema.parse(input);
}
