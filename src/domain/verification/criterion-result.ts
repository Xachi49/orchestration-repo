import { z } from "zod";

export const CriterionVerdictSchema = z.enum([
  "SATISFIED",
  "PARTIALLY_SATISFIED",
  "UNSATISFIED",
  "INCONCLUSIVE",
]);

export type CriterionVerdict = z.infer<typeof CriterionVerdictSchema>;

/**
 * Exactly one result per original acceptance criterion.
 * Missing evidence → INCONCLUSIVE (never default success).
 */
export const AcceptanceCriterionResultSchema = z
  .object({
    criterionId: z.string().min(1),
    criterionText: z.string().min(1),
    verdict: CriterionVerdictSchema,
    evidenceRefs: z.array(z.string()),
    stepRefs: z.array(z.string()),
    findingRefs: z.array(z.string()),
    conciseRationale: z.string().min(1),
    verificationMethod: z.string().min(1),
  })
  .strict();

export type AcceptanceCriterionResult = z.infer<
  typeof AcceptanceCriterionResultSchema
>;

export function parseAcceptanceCriterionResult(
  input: unknown,
): AcceptanceCriterionResult {
  return AcceptanceCriterionResultSchema.parse(input);
}

/**
 * Step expectedPostcondition evaluation.
 * Step status SUCCEEDED does not automatically satisfy postconditions.
 */
export const StepPostconditionResultSchema = z
  .object({
    stepId: z.string().min(1),
    postconditionId: z.string().min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    verdict: CriterionVerdictSchema,
    evidenceRefs: z.array(z.string()),
    findingRefs: z.array(z.string()),
  })
  .strict();

export type StepPostconditionResult = z.infer<
  typeof StepPostconditionResultSchema
>;

export function parseStepPostconditionResult(
  input: unknown,
): StepPostconditionResult {
  return StepPostconditionResultSchema.parse(input);
}
