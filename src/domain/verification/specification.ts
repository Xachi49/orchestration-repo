import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

export const CompiledAcceptanceCriterionSchema = z
  .object({
    criterionId: z.string().min(1),
    criterionText: z.string().min(1),
    index: z.number().int().nonnegative(),
    required: z.boolean(),
  })
  .strict();

export type CompiledAcceptanceCriterion = z.infer<
  typeof CompiledAcceptanceCriterionSchema
>;

export const CompiledPostconditionSchema = z
  .object({
    postconditionId: z.string().min(1),
    stepId: z.string().min(1),
    expected: z.string().min(1),
    index: z.number().int().nonnegative(),
  })
  .strict();

export type CompiledPostcondition = z.infer<typeof CompiledPostconditionSchema>;

export const CompiledVerificationRequirementSchema = z
  .object({
    requirementId: z.string().min(1),
    stepId: z.string().min(1),
    check: z.string().min(1),
  })
  .strict();

export type CompiledVerificationRequirement = z.infer<
  typeof CompiledVerificationRequirementSchema
>;

/**
 * Deterministic compilation of objective + plan success definition.
 * Does not invent new acceptance criteria.
 */
export const VerificationSpecificationSchema = z
  .object({
    specificationId: z.string().min(1),
    runId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: z.number().int().positive(),
    objectiveFingerprint: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    acceptanceCriteria: z.array(CompiledAcceptanceCriterionSchema).min(1),
    constraints: z.array(z.string()),
    nonGoals: z.array(z.string()),
    postconditions: z.array(CompiledPostconditionSchema),
    verificationRequirements: z.array(CompiledVerificationRequirementSchema),
    verificationSpecificationHash: z.string().min(1),
  })
  .strict();

export type VerificationSpecification = z.infer<
  typeof VerificationSpecificationSchema
>;

export function parseVerificationSpecification(
  input: unknown,
): VerificationSpecification {
  return VerificationSpecificationSchema.parse(input);
}
