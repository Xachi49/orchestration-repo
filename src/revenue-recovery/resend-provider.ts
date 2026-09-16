import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CallbackTaskAction,
  MessagingDeliveryResult,
  RecoveryMessagingContext,
  RecoveryMessagingProvider,
  SendEmailAction,
  SendSmsAction,
} from "./messaging.js";
import { FakeRecoveryMessagingProvider } from "./messaging.js";
import {
  isLivePilotTenant,
  type RecoveryPilotConfig,
} from "./pilot-config.js";
import { RevenueRecoveryError } from "./errors.js";

export type ExtendedMessagingDeliveryResult = MessagingDeliveryResult & {
  providerName: "FAKE" | "RESEND" | "SHADOW";
  providerIdempotencyKey?: string;
  shadowedRequest?: {
    to: string;
    from: string;
    subject: string;
    textLength: number;
    idempotencyKey: string;
  };
};

export type ResendTransport = {
  sendEmail(input: {
    apiKey: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    replyTo?: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
};

/** Real HTTP transport — excluded from normal CI; only used when LIVE_EMAIL. */
export const defaultResendTransport: ResendTransport = {
  async sendEmail(input) {
    const body: Record<string, unknown> = {
      from: input.from,
      to: [input.to],
      subject: input.subject,
      text: input.text,
    };
    if (input.replyTo) {
      body["reply_to"] = input.replyTo;
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new RevenueRecoveryError(
        "PROVIDER_DELIVERY_FAILED",
        `Resend send failed with status ${response.status}`,
        { status: response.status, bodyLength: text.length },
      );
    }
    const json = (await response.json()) as { id?: string };
    if (!json.id) {
      throw new RevenueRecoveryError(
        "PROVIDER_DELIVERY_FAILED",
        "Resend response missing id",
      );
    }
    return { id: json.id };
  },
};

/**
 * Narrow Resend email boundary for SEND_RECOVERY_EMAIL only.
 * SMS / callback remain on Fake (no Twilio in pilot v1).
 */
export class ResendRecoveryEmailProvider implements RecoveryMessagingProvider {
  readonly shadowed: ExtendedMessagingDeliveryResult["shadowedRequest"][] = [];
  readonly liveCalls: Array<{
    to: string;
    idempotencyKey: string;
    providerMessageId: string;
  }> = [];
  private readonly fake = new FakeRecoveryMessagingProvider();

  constructor(
    private readonly config: RecoveryPilotConfig,
    private readonly transport: ResendTransport = defaultResendTransport,
  ) {}

  get sent() {
    return this.fake.sent;
  }

  async sendSms(input: {
    action: SendSmsAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<ExtendedMessagingDeliveryResult> {
    const result = await this.fake.sendSms(input);
    return { ...result, providerName: "FAKE" };
  }

  async createCallbackTask(input: {
    action: CallbackTaskAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<ExtendedMessagingDeliveryResult> {
    const result = await this.fake.createCallbackTask(input);
    return { ...result, providerName: "FAKE" };
  }

  async sendEmail(input: {
    action: SendEmailAction;
    nowIso: string;
    context?: RecoveryMessagingContext;
  }): Promise<ExtendedMessagingDeliveryResult> {
    const context = input.context;
    if (!context?.providerIdempotencyKey) {
      throw new RevenueRecoveryError(
        "PROVIDER_CONTEXT_MISSING",
        "Email send requires providerIdempotencyKey from executionActionIdentity",
      );
    }

    const from = this.config.recoveryEmailFrom;
    if (!from) {
      throw new RevenueRecoveryError(
        "PROVIDER_CONFIG_INVALID",
        "RECOVERY_EMAIL_FROM is required for email recovery",
      );
    }

    // Containment: recipient is only the action's lead email (already resolved
    // from canonical Lead by the service). No cc/bcc/arbitrary from.
    const to = input.action.recipientEmail;
    const subject = input.action.renderedSubject;
    const text = input.action.renderedMessage;
    const idempotencyKey = context.providerIdempotencyKey;

    if (this.config.mode === "FAKE") {
      const result = await this.fake.sendEmail(input);
      return {
        ...result,
        providerName: "FAKE",
        providerIdempotencyKey: idempotencyKey,
      };
    }

    const shadowedRequest = {
      to,
      from,
      subject,
      textLength: text.length,
      idempotencyKey,
    };

    if (this.config.mode === "SHADOW") {
      this.shadowed.push(shadowedRequest);
      return {
        outcome: "SIMULATED",
        providerMessageId: `shadow_email_${idempotencyKey}`,
        deliveredAt: input.nowIso,
        providerName: "SHADOW",
        providerIdempotencyKey: idempotencyKey,
        shadowedRequest,
      };
    }

    // LIVE_EMAIL
    if (
      !isLivePilotTenant(this.config, {
        customerAccountId: context.customerAccountId,
        projectId: context.projectId,
      })
    ) {
      throw new RevenueRecoveryError(
        "LIVE_PILOT_TENANT_DENIED",
        "LIVE_EMAIL is restricted to the configured pilot tenant/project",
        {
          customerAccountId: context.customerAccountId,
          projectId: context.projectId,
        },
      );
    }

    if (
      this.config.livePilotRecipientAllowlist.length > 0 &&
      !this.config.livePilotRecipientAllowlist.includes(to)
    ) {
      throw new RevenueRecoveryError(
        "LIVE_PILOT_RECIPIENT_DENIED",
        "LIVE_EMAIL recipient is not on the pilot allowlist",
      );
    }

    if (!this.config.resendApiKey) {
      throw new RevenueRecoveryError(
        "PROVIDER_CONFIG_INVALID",
        "RESEND_API_KEY required for LIVE_EMAIL",
      );
    }

    try {
      const sent = await this.transport.sendEmail({
        apiKey: this.config.resendApiKey,
        from,
        to,
        subject,
        text,
        ...(this.config.recoveryEmailReplyTo
          ? { replyTo: this.config.recoveryEmailReplyTo }
          : {}),
        idempotencyKey,
      });
      this.liveCalls.push({
        to,
        idempotencyKey,
        providerMessageId: sent.id,
      });
      return {
        outcome: "SENT",
        providerMessageId: sent.id,
        deliveredAt: input.nowIso,
        providerName: "RESEND",
        providerIdempotencyKey: idempotencyKey,
      };
    } catch (error) {
      if (error instanceof RevenueRecoveryError) throw error;
      return {
        outcome: "FAILED",
        providerMessageId: `resend_fail_${idempotencyKey}`,
        deliveredAt: input.nowIso,
        providerName: "RESEND",
        providerIdempotencyKey: idempotencyKey,
      };
    }
  }
}

/**
 * Verify Resend/Svix webhook signature against the raw body bytes/string.
 * Do not re-stringify JSON before calling this.
 */
export function verifyResendWebhookSignature(input: {
  rawBody: string | Buffer;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  secret: string;
  /** Reject timestamps older than this (seconds). Default 5 minutes. */
  toleranceSeconds?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? 300;
  const ts = Number(input.svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > tolerance) return false;

  const body =
    typeof input.rawBody === "string"
      ? input.rawBody
      : input.rawBody.toString("utf8");
  const signedContent = `${input.svixId}.${input.svixTimestamp}.${body}`;

  // Resend secrets are often `whsec_<base64>`.
  const secretBytes = input.secret.startsWith("whsec_")
    ? Buffer.from(input.secret.slice("whsec_".length), "base64")
    : Buffer.from(input.secret, "utf8");

  const expected = createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");

  const signatures = input.svixSignature.split(" ").map((part) => {
    const [, value] = part.split(",");
    return value ?? part.replace(/^v1,/, "");
  });

  const expectedBuf = Buffer.from(expected);
  return signatures.some((sig) => {
    try {
      const got = Buffer.from(sig);
      return (
        got.length === expectedBuf.length && timingSafeEqual(got, expectedBuf)
      );
    } catch {
      return false;
    }
  });
}

export function createMessagingProviderForPilot(
  config: RecoveryPilotConfig,
  transport?: ResendTransport,
): RecoveryMessagingProvider {
  if (config.mode === "FAKE" && !config.recoveryEmailFrom) {
    return new FakeRecoveryMessagingProvider();
  }
  return new ResendRecoveryEmailProvider(config, transport);
}
