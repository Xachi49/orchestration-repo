import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

export const ValidationDecisionClassSchema = z.enum([
  "PASS",
  "BLOCK",
  "HUMAN_APPROVAL_REQUIRED",
  "REVISE",
]);

export type ValidationDecisionClass = z.infer<
  typeof ValidationDecisionClassSchema
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

export const ValidationFindingSchema = z
  .object({
    findingId: z.string().min(1),
    code: z.string().min(1),
    severity: ValidationFindingSeveritySchema,
    message: z.string().min(1),
    path: z.array(z.string()).optional(),
    relatedStepIds: z.array(z.string()).optional(),
  })
  .strict();

export type ValidationFinding = z.infer<typeof ValidationFindingSchema>;

export const ValidationDecisionSchema = z
  .object({
    decision: ValidationDecisionClassSchema,
    findings: z.array(ValidationFindingSchema),
    decidedAt: z.string().datetime(),
    validatorId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
  })
  .strict();

export type ValidationDecision = z.infer<typeof ValidationDecisionSchema>;

export function parseValidationDecision(input: unknown): ValidationDecision {
  return ValidationDecisionSchema.parse(input);
}
