import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";
import { OutcomeVerdictSchema } from "./outcome.js";
import {
  AcceptanceCriterionResultSchema,
  StepPostconditionResultSchema,
} from "./criterion-result.js";
import { VerificationFindingSchema } from "./finding.js";

/**
 * Append-only authoritative outcome verification record.
 * Never mutate a prior record.
 */
export const OutcomeVerificationRecordSchema = z
  .object({
    outcomeVerificationId: z.string().min(1),
    verificationAttemptId: z.string().min(1),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    postExecutionSnapshotHash: z.string().min(1),
    verificationSpecificationHash: z.string().min(1),
    outcome: OutcomeVerdictSchema,
    criterionResults: z.array(AcceptanceCriterionResultSchema),
    postconditionResults: z.array(StepPostconditionResultSchema),
    findings: z.array(VerificationFindingSchema),
    evidenceRefs: z.array(z.string()),
    contextualAssessmentReference: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type OutcomeVerificationRecord = z.infer<
  typeof OutcomeVerificationRecordSchema
>;

export function parseOutcomeVerificationRecord(
  input: unknown,
): OutcomeVerificationRecord {
  return OutcomeVerificationRecordSchema.parse(input);
}

/**
 * Evidence-backed proof that allowed VERIFYING → COMPLETED.
 * ONLY created for VERIFIED_SUCCESS.
 */
export const CompletionRecordSchema = z
  .object({
    completionRecordId: z.string().min(1),
    runId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: z.number().int().positive(),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    executionAttemptId: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    outcomeVerificationId: z.string().min(1),
    postExecutionSnapshotHash: z.string().min(1),
    verificationSpecificationHash: z.string().min(1),
    completedAt: z.string().datetime(),
  })
  .strict();

export type CompletionRecord = z.infer<typeof CompletionRecordSchema>;

export function parseCompletionRecord(input: unknown): CompletionRecord {
  return CompletionRecordSchema.parse(input);
}
