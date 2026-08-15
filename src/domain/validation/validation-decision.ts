import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";
import { ValidationFindingSchema } from "./validation-finding.js";

export const ValidationDecisionClassSchema = z.enum([
  "PASS",
  "BLOCK",
  "HUMAN_APPROVAL_REQUIRED",
  "REVISE",
]);

export type ValidationDecisionClass = z.infer<
  typeof ValidationDecisionClassSchema
>;

export {
  ValidationFindingSeveritySchema,
  ValidationFindingSchema,
  parseValidationFinding,
  type ValidationFindingSeverity,
  type ValidationFinding,
  ValidationValidatorTypeSchema,
  type ValidationValidatorType,
} from "./validation-finding.js";

/**
 * Authoritative validation decision produced by deterministic code.
 * Model recommendations are advisory only.
 */
export const ValidationDecisionSchema = z
  .object({
    validationDecisionId: z.string().min(1),
    decision: ValidationDecisionClassSchema,
    findings: z.array(ValidationFindingSchema),
    decidedAt: z.string().datetime(),
    validatorId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    policyBundleHash: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    validationAttempt: z.number().int().positive(),
    requiresHumanAction: z.boolean(),
  })
  .strict();

export type ValidationDecision = z.infer<typeof ValidationDecisionSchema>;

export function parseValidationDecision(input: unknown): ValidationDecision {
  return ValidationDecisionSchema.parse(input);
}
