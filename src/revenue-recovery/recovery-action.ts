import { z } from "zod";

/**
 * Domain action schemas for recovery outreach.
 * Recipient must resolve from the bound Lead — no arbitrary redirect.
 */
export const RECOVERY_ACTION_TYPES = [
  "SEND_RECOVERY_SMS",
  "SEND_RECOVERY_EMAIL",
  "CREATE_CALLBACK_TASK",
  "WAIT_FOR_RESPONSE",
  "MARK_RECOVERY_EXHAUSTED",
] as const;

export type RecoveryActionType = (typeof RECOVERY_ACTION_TYPES)[number];

export const SendRecoverySmsSchema = z
  .object({
    actionType: z.literal("SEND_RECOVERY_SMS"),
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    recipientPhone: z.string().min(1).max(32),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
    renderedMessage: z.string().min(1).max(1600),
  })
  .strict();

export const SendRecoveryEmailSchema = z
  .object({
    actionType: z.literal("SEND_RECOVERY_EMAIL"),
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    recipientEmail: z.string().email().max(254),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
    renderedSubject: z.string().min(1).max(200),
    renderedMessage: z.string().min(1).max(5000),
  })
  .strict();

export const CreateCallbackTaskSchema = z
  .object({
    actionType: z.literal("CREATE_CALLBACK_TASK"),
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    recipientPhone: z.string().min(1).max(32),
    note: z.string().max(500).optional(),
  })
  .strict();

export const WaitForResponseSchema = z
  .object({
    actionType: z.literal("WAIT_FOR_RESPONSE"),
    recoveryCaseId: z.string().min(1),
    waitMinutes: z.number().int().positive().max(7 * 24 * 60),
  })
  .strict();

export const MarkRecoveryExhaustedSchema = z
  .object({
    actionType: z.literal("MARK_RECOVERY_EXHAUSTED"),
    recoveryCaseId: z.string().min(1),
    reasonCode: z.string().min(1).max(64),
  })
  .strict();

export const RecoveryActionSchema = z.discriminatedUnion("actionType", [
  SendRecoverySmsSchema,
  SendRecoveryEmailSchema,
  CreateCallbackTaskSchema,
  WaitForResponseSchema,
  MarkRecoveryExhaustedSchema,
]);

export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export function parseRecoveryAction(input: unknown): RecoveryAction {
  return RecoveryActionSchema.parse(input);
}
