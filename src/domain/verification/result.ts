import { z } from "zod";
import { OutcomeVerdictSchema } from "./outcome.js";
import {
  AcceptanceCriterionResultSchema,
  StepPostconditionResultSchema,
} from "./criterion-result.js";
import { VerificationFindingSchema } from "./finding.js";

/**
 * Returned verification result. No hidden reasoning.
 */
export const VerificationResultSchema = z
  .object({
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    verificationAttemptId: z.string().min(1),
    outcomeVerificationId: z.string().min(1),
    outcome: OutcomeVerdictSchema,
    criterionResults: z.array(AcceptanceCriterionResultSchema),
    postconditionResults: z.array(StepPostconditionResultSchema),
    evidenceRefs: z.array(z.string()),
    findings: z.array(VerificationFindingSchema),
    postExecutionSnapshotHash: z.string().min(1),
    verificationSpecificationHash: z.string().min(1),
    completionRecordId: z.string().min(1).optional(),
    requiresHumanReview: z.boolean(),
    failureSummary: z.string().max(4000).optional(),
  })
  .strict();

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export function parseVerificationResult(input: unknown): VerificationResult {
  return VerificationResultSchema.parse(input);
}
