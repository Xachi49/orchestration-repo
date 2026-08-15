import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

export const VerificationAttemptStatusSchema = z.enum([
  "IN_PROGRESS",
  "DECIDED",
  "FAILED",
]);

export type VerificationAttemptStatus = z.infer<
  typeof VerificationAttemptStatusSchema
>;

/**
 * Append-only verification attempt. Prior attempts are never overwritten.
 */
export const VerificationAttemptSchema = z
  .object({
    verificationAttemptId: z.string().min(1),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    startedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    status: VerificationAttemptStatusSchema,
  })
  .strict();

export type VerificationAttempt = z.infer<typeof VerificationAttemptSchema>;

export function parseVerificationAttempt(input: unknown): VerificationAttempt {
  return VerificationAttemptSchema.parse(input);
}
