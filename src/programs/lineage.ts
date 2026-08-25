import { z } from "zod";

export const ProgramLineageRecordSchema = z
  .object({
    lineageId: z.string().min(1),
    programId: z.string().min(1),
    programVersion: z.number().int().positive(),
    programPlanVersion: z.number().int().positive(),
    programPlanHash: z.string().min(1),
    nodeId: z.string().min(1),
    childObjectiveId: z.string().min(1),
    childObjectiveVersion: z.number().int().positive(),
    childRunId: z.string().min(1).optional(),
    materializationStatus: z.enum([
      "PENDING",
      "ADMITTED",
      "DUPLICATE",
      "FAILED",
    ]),
    failureReasonCode: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ProgramLineageRecord = z.infer<typeof ProgramLineageRecordSchema>;

export function lineageIdFor(input: {
  programId: string;
  programPlanVersion: number;
  nodeId: string;
}): string {
  return `pln_${input.programId}_${input.programPlanVersion}_${input.nodeId}`.slice(
    0,
    120,
  );
}

export const ProgramMaterializationApprovalSchema = z
  .object({
    approvalId: z.string().min(1),
    programId: z.string().min(1),
    programVersion: z.number().int().positive(),
    programPlanVersion: z.number().int().positive(),
    programPlanHash: z.string().min(1),
    delegationEnvelopeHash: z.string().min(1),
    policyBundleHash: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    budgetAllocationFingerprint: z.string().min(1),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]),
    approverId: z.string().min(1).optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ProgramMaterializationApproval = z.infer<
  typeof ProgramMaterializationApprovalSchema
>;

export const PROGRAM_OUTCOME_CLASSES = [
  "VERIFIED_SUCCESS",
  "PARTIAL_SUCCESS",
  "PROGRAM_FAILED",
  "INCONCLUSIVE",
  "CONTAINED",
] as const;

export const ProgramOutcomeClassSchema = z.enum(PROGRAM_OUTCOME_CLASSES);
export type ProgramOutcomeClass = z.infer<typeof ProgramOutcomeClassSchema>;

export const ProgramCompletionRecordSchema = z
  .object({
    programCompletionRecordId: z.string().min(1),
    programId: z.string().min(1),
    programVersion: z.number().int().positive(),
    programPlanVersion: z.number().int().positive(),
    programPlanHash: z.string().min(1),
    outcome: z.literal("VERIFIED_SUCCESS"),
    criterionResults: z.array(
      z
        .object({
          rootCriterionIndex: z.number().int().nonnegative(),
          satisfied: z.literal(true),
          evidenceRefs: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ProgramCompletionRecord = z.infer<
  typeof ProgramCompletionRecordSchema
>;
