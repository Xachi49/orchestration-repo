import { z } from "zod";
import { hashCanonical } from "./hash.js";
import { TRUST_PROVENANCE_CLASSES } from "./provenance.js";

export const LEAD_EVENT_KINDS = [
  "LEAD_CREATED",
  "INBOUND_MESSAGE",
  "OUTBOUND_ATTEMPT",
  "OUTBOUND_DELIVERED",
  "OUTBOUND_FAILED",
  "CALL_ATTEMPTED",
  "CALL_CONNECTED",
  "APPOINTMENT_BOOKED",
  "APPOINTMENT_CANCELLED",
  "SALE_RECORDED",
  "PAYMENT_RECORDED",
  "DO_NOT_CONTACT",
  "CONSENT_REVOKED",
] as const;

export type LeadEventKind = (typeof LEAD_EVENT_KINDS)[number];

/** Public HTTP ingest — trustProvenance is NEVER accepted from callers. */
export const LeadEventIngestSchema = z
  .object({
    customerAccountId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    leadId: z.string().min(1),
    kind: z.enum(LEAD_EVENT_KINDS),
    occurredAt: z.string().datetime(),
    externalEventId: z.string().min(1).max(256),
    source: z.string().min(1).max(64),
    amount: z.number().nonnegative().finite().optional(),
    currency: z.string().length(3).optional(),
    channel: z.enum(["SMS", "EMAIL", "CALL", "OTHER"]).optional(),
    messagePreview: z.string().max(280).optional(),
    recoveryAttemptId: z.string().min(1).optional(),
    metadata: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();

export type LeadEventIngestInput = z.infer<typeof LeadEventIngestSchema>;

export const LeadEventSchema = LeadEventIngestSchema.extend({
  eventId: z.string().min(1),
  recordRevision: z.number().int().positive(),
  recordedAt: z.string().datetime(),
  /** Server-assigned only. */
  trustProvenance: z.enum(TRUST_PROVENANCE_CLASSES),
}).strict();

export type LeadEvent = z.infer<typeof LeadEventSchema>;

export function parseLeadEvent(input: unknown): LeadEvent {
  return LeadEventSchema.parse(input);
}

export function parseLeadEventIngest(input: unknown): LeadEventIngestInput {
  return LeadEventIngestSchema.parse(input);
}

export function leadEventIdentityKey(input: {
  customerAccountId: string;
  leadId: string;
  source: string;
  externalEventId: string;
}): string {
  return `${input.customerAccountId}|${input.leadId}|${input.source}|${input.externalEventId}`;
}

export function newLeadEventId(input: {
  customerAccountId: string;
  leadId: string;
  source: string;
  externalEventId: string;
}): string {
  return `levt_${hashCanonical(leadEventIdentityKey(input)).slice(0, 24)}`;
}

export const QUALIFYING_HUMAN_RESPONSE_KINDS: readonly LeadEventKind[] = [
  "INBOUND_MESSAGE",
  "CALL_CONNECTED",
  "APPOINTMENT_BOOKED",
  "SALE_RECORDED",
  "PAYMENT_RECORDED",
];

export const SUPPRESSION_EVENT_KINDS: readonly LeadEventKind[] = [
  "DO_NOT_CONTACT",
  "CONSENT_REVOKED",
];
