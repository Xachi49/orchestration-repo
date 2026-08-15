import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";
import { StepExecutionResultSchema } from "./step-result.js";

/**
 * Actuator completion status — not Phase 8 verified success.
 * EXECUTION_SUCCEEDED ≠ VERIFIED_SUCCESS.
 */
export const ExecutionResultStatusSchema = z.enum([
  "EXECUTION_SUCCEEDED",
  "EXECUTION_FAILED",
  "EXECUTION_PARTIAL",
  "EXECUTION_CONTAINED",
]);
export type ExecutionResultStatus = z.infer<typeof ExecutionResultStatusSchema>;

export const ExecutionResultSchema = z
  .object({
    executionAttemptId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    status: ExecutionResultStatusSchema,
    stepResults: z.array(StepExecutionResultSchema),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime(),
    artifactRefs: z.array(z.string()),
    failureSummary: z.string().max(4000).optional(),
    containmentRequired: z.boolean(),
  })
  .strict();

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export function parseExecutionResult(input: unknown): ExecutionResult {
  return ExecutionResultSchema.parse(input);
}
