import { z } from "zod";
import { hashCanonical } from "./hash.js";

export const PROVIDER_EVENT_KINDS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.failed",
  "email.complained",
  "email.suppressed",
  "email.opened",
  "email.clicked",
] as const;

export type ProviderEventKind = (typeof PROVIDER_EVENT_KINDS)[number];

export const RecoveryProviderEventSchema = z
  .object({
    providerEventId: z.string().min(1),
    providerName: z.literal("RESEND"),
    /** Svix/Resend event id — webhook replay key. */
    providerEventKey: z.string().min(1),
    providerMessageId: z.string().min(1).optional(),
    eventKind: z.string().min(1),
    attemptId: z.string().min(1).optional(),
    recoveryCaseId: z.string().min(1).optional(),
    leadId: z.string().min(1).optional(),
    customerAccountId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    occurredAt: z.string().datetime(),
    /** Bounded non-secret metadata only. */
    payload: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type RecoveryProviderEvent = z.infer<typeof RecoveryProviderEventSchema>;

export function parseRecoveryProviderEvent(input: unknown): RecoveryProviderEvent {
  return RecoveryProviderEventSchema.parse(input);
}

export function newProviderEventId(input: {
  providerName: string;
  providerEventKey: string;
}): string {
  return `rpe_${hashCanonical(input).slice(0, 24)}`;
}

export interface RecoveryProviderEventRepository {
  getByProviderEventKey(input: {
    providerName: string;
    providerEventKey: string;
  }): Promise<RecoveryProviderEvent | null>;
  save(event: RecoveryProviderEvent): Promise<void>;
}
