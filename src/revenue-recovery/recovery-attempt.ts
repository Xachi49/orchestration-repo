import { z } from "zod";
import { hashCanonical } from "./hash.js";

export const RECOVERY_ATTEMPT_CHANNELS = [
  "SMS",
  "EMAIL",
  "CALL_TASK",
] as const;

export const RecoveryAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    recoveryCaseId: z.string().min(1),
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    leadId: z.string().min(1),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    stepId: z.string().min(1),
    /** Durable Phase7 step identity — unique outreach key. */
    executionActionIdentity: z.string().min(1),
    /** Stable key for a future real provider. */
    providerIdempotencyKey: z.string().min(1),
    channel: z.enum(RECOVERY_ATTEMPT_CHANNELS),
    templateId: z.string().min(1).optional(),
    templateVersion: z.number().int().positive().optional(),
    recipientRef: z.string().min(1),
    sentAt: z.string().datetime(),
    deliveryOutcome: z.enum(["SENT", "FAILED", "SIMULATED"]),
    providerMessageId: z.string().min(1).optional(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type RecoveryAttempt = z.infer<typeof RecoveryAttemptSchema>;

export function parseRecoveryAttempt(input: unknown): RecoveryAttempt {
  return RecoveryAttemptSchema.parse(input);
}

export function recoveryExecutionActionIdentity(input: {
  executionAttemptId: string;
  stepIdempotencyKey: string;
  actionType: string;
}): string {
  return `rex_${hashCanonical(input).slice(0, 32)}`;
}

export function newRecoveryAttemptId(executionActionIdentity: string): string {
  return `ratt_${hashCanonical({ executionActionIdentity }).slice(0, 24)}`;
}
