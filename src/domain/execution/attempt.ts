import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

export const ExecutionAttemptStatusSchema = z.enum([
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
  "PARTIAL",
  "CONTAINED",
]);
export type ExecutionAttemptStatus = z.infer<
  typeof ExecutionAttemptStatusSchema
>;

/**
 * Auditable execution attempt. Retries create new attempts; prior attempts
 * are never overwritten.
 */
export const ExecutionAttemptSchema = z
  .object({
    executionAttemptId: z.string().min(1),
    runId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    authorizationRecordId: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    status: ExecutionAttemptStatusSchema,
    authoritySnapshotId: z.string().min(1).optional(),
  })
  .strict();

export type ExecutionAttempt = z.infer<typeof ExecutionAttemptSchema>;

export function parseExecutionAttempt(input: unknown): ExecutionAttempt {
  return ExecutionAttemptSchema.parse(input);
}
