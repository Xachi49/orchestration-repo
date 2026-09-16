import type {
  CreateCallbackTaskSchema,
  SendRecoveryEmailSchema,
  SendRecoverySmsSchema,
} from "./recovery-action.js";
import type { z } from "zod";

export type SendSmsAction = z.infer<typeof SendRecoverySmsSchema>;
export type SendEmailAction = z.infer<typeof SendRecoveryEmailSchema>;
export type CallbackTaskAction = z.infer<typeof CreateCallbackTaskSchema>;

export type MessagingProviderName = "FAKE" | "RESEND" | "SHADOW";

export type MessagingDeliveryResult = {
  outcome: "SENT" | "FAILED" | "SIMULATED";
  providerMessageId: string;
  deliveredAt: string;
  providerName?: MessagingProviderName;
  providerIdempotencyKey?: string;
};

/** Durable Phase7 identity + tenant for provider gates / idempotency. */
export type RecoveryMessagingContext = {
  providerIdempotencyKey: string;
  customerAccountId: string;
  projectId: string;
};

/**
 * Narrow messaging port — no arbitrary HTTP / recipient.
 */
export interface RecoveryMessagingProvider {
  sendSms(input: {
    action: SendSmsAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<MessagingDeliveryResult>;
  sendEmail(input: {
    action: SendEmailAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<MessagingDeliveryResult>;
  createCallbackTask(input: {
    action: CallbackTaskAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<MessagingDeliveryResult>;
}

/** Deterministic fake actuator — no real external messages. */
export class FakeRecoveryMessagingProvider implements RecoveryMessagingProvider {
  readonly sent: Array<{
    kind: "SMS" | "EMAIL" | "CALL_TASK";
    action: SendSmsAction | SendEmailAction | CallbackTaskAction;
    result: MessagingDeliveryResult;
  }> = [];

  async sendSms(input: {
    action: SendSmsAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<MessagingDeliveryResult> {
    const result: MessagingDeliveryResult = {
      outcome: "SIMULATED",
      providerMessageId: `fake_sms_${input.action.recoveryCaseId}_${this.sent.length}`,
      deliveredAt: input.nowIso,
      providerName: "FAKE",
      ...(input.context
        ? { providerIdempotencyKey: input.context.providerIdempotencyKey }
        : {}),
    };
    this.sent.push({ kind: "SMS", action: input.action, result });
    return result;
  }

  async sendEmail(input: {
    action: SendEmailAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<MessagingDeliveryResult> {
    const result: MessagingDeliveryResult = {
      outcome: "SIMULATED",
      providerMessageId: `fake_email_${input.action.recoveryCaseId}_${this.sent.length}`,
      deliveredAt: input.nowIso,
      providerName: "FAKE",
      ...(input.context
        ? { providerIdempotencyKey: input.context.providerIdempotencyKey }
        : {}),
    };
    this.sent.push({ kind: "EMAIL", action: input.action, result });
    return result;
  }

  async createCallbackTask(input: {
    action: CallbackTaskAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<MessagingDeliveryResult> {
    const result: MessagingDeliveryResult = {
      outcome: "SIMULATED",
      providerMessageId: `fake_task_${input.action.recoveryCaseId}_${this.sent.length}`,
      deliveredAt: input.nowIso,
      providerName: "FAKE",
      ...(input.context
        ? { providerIdempotencyKey: input.context.providerIdempotencyKey }
        : {}),
    };
    this.sent.push({ kind: "CALL_TASK", action: input.action, result });
    return result;
  }
}
