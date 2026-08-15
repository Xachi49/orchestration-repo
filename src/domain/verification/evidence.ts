import { z } from "zod";

export const VerificationEvidenceSourceTypeSchema = z.enum([
  "STEP_RESULT",
  "EXECUTION_ARTIFACT",
  "TEST_RESULT",
  "WORKSPACE_OBSERVATION",
  "TASK_RECORD",
  "PR_PREPARATION",
  "AUDIT_EVENT",
  "RESOURCE_LEDGER",
  "REGISTERED_PROBE",
  "DERIVED",
]);

export type VerificationEvidenceSourceType = z.infer<
  typeof VerificationEvidenceSourceTypeSchema
>;

/**
 * Trust classification for verification evidence.
 * Models must never create SYSTEM_OBSERVED or SYSTEM_RECOMPUTED evidence.
 * MODEL_INTERPRETATION cannot alone support VERIFIED_SUCCESS.
 */
export const VerificationEvidenceTrustClassSchema = z.enum([
  "SYSTEM_OBSERVED",
  "SYSTEM_RECOMPUTED",
  "VERIFIED_EXECUTION_RECORD",
  "MODEL_INTERPRETATION",
]);

export type VerificationEvidenceTrustClass = z.infer<
  typeof VerificationEvidenceTrustClassSchema
>;

export const VerificationEvidenceSchema = z
  .object({
    evidenceId: z.string().min(1),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    sourceType: VerificationEvidenceSourceTypeSchema,
    trustClass: VerificationEvidenceTrustClassSchema,
    contentHash: z.string().min(1),
    artifactRef: z.string().min(1).optional(),
    stepIds: z.array(z.string()),
    criterionIds: z.array(z.string()),
    observedValue: z.unknown(),
    expectedValue: z.unknown().optional(),
    observedAt: z.string().datetime(),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type VerificationEvidence = z.infer<typeof VerificationEvidenceSchema>;

export function parseVerificationEvidence(
  input: unknown,
): VerificationEvidence {
  return VerificationEvidenceSchema.parse(input);
}
