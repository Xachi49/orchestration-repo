import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

/**
 * Independently reconstructed post-execution observable truth.
 * Not a serialization of ExecutionResult.
 */
export const PostExecutionSnapshotSchema = z
  .object({
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    executionAuthoritySnapshotId: z.string().min(1),
    stepResultFingerprint: z.string().min(1),
    artifactManifestFingerprint: z.string().min(1),
    resourceLedgerFingerprint: z.string().min(1),
    auditEventFingerprint: z.string().min(1),
    workspaceObservationFingerprint: z.string().min(1).optional(),
    executionResultStatus: z.string().min(1),
    containmentRequired: z.boolean(),
    observedAt: z.string().datetime(),
  })
  .strict();

export type PostExecutionSnapshot = z.infer<typeof PostExecutionSnapshotSchema>;

export function parsePostExecutionSnapshot(
  input: unknown,
): PostExecutionSnapshot {
  return PostExecutionSnapshotSchema.parse(input);
}
