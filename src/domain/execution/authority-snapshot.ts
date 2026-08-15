import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

/**
 * Exact authority present when execution began.
 * Proves what was authorized at actuation time.
 */
export const ExecutionAuthoritySnapshotSchema = z
  .object({
    authoritySnapshotId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleHash: z.string().min(1),
    /** Frozen fingerprint from AuthorizationRecord (Phase 6 binding). */
    authorizedCapabilitySetFingerprint: z.string().min(1),
    /** Live Control Plane fingerprint verified equal at actuation. */
    liveCapabilitySetFingerprint: z.string().min(1),
    /**
     * Verified-equal capability authority (authorized === live).
     * Retained for callers that expect a single field.
     */
    capabilitySetFingerprint: z.string().min(1),
    executionMode: z.enum(["PLAN_ONLY", "SUPERVISED", "PATCH_ONLY"]),
    capturedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.authorizedCapabilitySetFingerprint !==
        value.liveCapabilitySetFingerprint ||
      value.capabilitySetFingerprint !==
        value.authorizedCapabilitySetFingerprint
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "ExecutionAuthoritySnapshot capability fingerprints must be identical",
      });
    }
  });

export type ExecutionAuthoritySnapshot = z.infer<
  typeof ExecutionAuthoritySnapshotSchema
>;

export function parseExecutionAuthoritySnapshot(
  input: unknown,
): ExecutionAuthoritySnapshot {
  return ExecutionAuthoritySnapshotSchema.parse(input);
}
