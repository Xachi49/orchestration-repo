import { z } from "zod";

export const VerificationFindingCategorySchema = z.enum([
  "BINDING",
  "AUTHORITY",
  "EXECUTION_INTEGRITY",
  "ARTIFACT_INTEGRITY",
  "POSTCONDITION",
  "ACCEPTANCE_CRITERION",
  "BOUNDARY",
  "RESOURCE",
  "CONTAINMENT",
  "EVIDENCE_GAP",
  "CONTEXTUAL",
  "GOVERNANCE",
  "CURRENT_DRIFT",
]);

export type VerificationFindingCategory = z.infer<
  typeof VerificationFindingCategorySchema
>;

export const VerificationFindingSeveritySchema = z.enum([
  "INFO",
  "WARNING",
  "ERROR",
  "CRITICAL",
]);

export type VerificationFindingSeverity = z.infer<
  typeof VerificationFindingSeveritySchema
>;

/**
 * Structured verification finding — never prose-only.
 * blocksVerifiedSuccess prevents VERIFIED_SUCCESS when true.
 */
export const VerificationFindingSchema = z
  .object({
    findingId: z.string().min(1),
    category: VerificationFindingCategorySchema,
    severity: VerificationFindingSeveritySchema,
    ruleId: z.string().min(1),
    message: z.string().min(1),
    criterionIds: z.array(z.string()),
    stepIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    blocksVerifiedSuccess: z.boolean(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type VerificationFinding = z.infer<typeof VerificationFindingSchema>;

export function parseVerificationFinding(input: unknown): VerificationFinding {
  return VerificationFindingSchema.parse(input);
}
