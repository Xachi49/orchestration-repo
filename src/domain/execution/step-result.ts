import { z } from "zod";

export const StepExecutionStatusSchema = z.enum([
  "RESERVED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "COMPENSATED",
  "CONTAINED",
]);
export type StepExecutionStatus = z.infer<typeof StepExecutionStatusSchema>;

/**
 * Persisted outcome of one compiled execution step.
 * Do not store unbounded raw command output.
 */
export const StepExecutionResultSchema = z
  .object({
    stepId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    capabilityId: z.string().min(1),
    actionType: z.string().min(1),
    status: StepExecutionStatusSchema,
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    outputArtifactRefs: z.array(z.string()),
    outputHashes: z.array(z.string()),
    affectedTargets: z.array(z.string()),
    verificationMetadata: z.record(z.string(), z.unknown()).optional(),
    errorCode: z.string().min(1).optional(),
    errorMessage: z.string().max(4000).optional(),
    executionAttemptId: z.string().min(1),
    runId: z.string().min(1),
  })
  .strict();

export type StepExecutionResult = z.infer<typeof StepExecutionResultSchema>;

export function parseStepExecutionResult(input: unknown): StepExecutionResult {
  return StepExecutionResultSchema.parse(input);
}
