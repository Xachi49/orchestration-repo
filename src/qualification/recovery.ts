import { z } from "zod";

/**
 * Recovery qualification evidence — verifies restart semantics without
 * inventing a new recovery system. Reuses Phase11 doctrine: no blind retry
 * of unknown external side effects.
 */
export const RecoveryQualificationResultSchema = z
  .object({
    boundary: z.enum([
      "AFTER_ADMISSION",
      "AFTER_PLANNING",
      "AFTER_AUTHORIZATION",
      "DURING_WORKER_COORDINATION",
      "AFTER_EXECUTION_BEFORE_VERIFICATION",
    ]),
    reconstructedWithoutDuplicateAuthority: z.boolean(),
    reconstructedWithoutDuplicateExecution: z.boolean(),
    runPreserved: z.boolean(),
    approvalPreserved: z.boolean(),
    noLifecycleRegression: z.boolean(),
    unknownExternalSideEffectNotBlindRetried: z.boolean(),
    result: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
  })
  .strict();

export type RecoveryQualificationResult = z.infer<
  typeof RecoveryQualificationResultSchema
>;

export function evaluateRecoveryQualification(
  input: Omit<RecoveryQualificationResult, "result">,
): RecoveryQualificationResult {
  const pass =
    input.reconstructedWithoutDuplicateAuthority &&
    input.reconstructedWithoutDuplicateExecution &&
    input.runPreserved &&
    input.approvalPreserved &&
    input.noLifecycleRegression &&
    input.unknownExternalSideEffectNotBlindRetried;
  return RecoveryQualificationResultSchema.parse({
    ...input,
    result: pass ? "PASS" : "FAIL",
  });
}
