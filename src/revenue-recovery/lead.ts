import { z } from "zod";
import { hashCanonical } from "./hash.js";

export const LEAD_SOURCES = ["MANUAL", "WEBHOOK", "FAKE_TEST_SOURCE"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LeadConsentSchema = z
  .object({
    smsOptIn: z.boolean().optional(),
    emailOptIn: z.boolean().optional(),
    callOptIn: z.boolean().optional(),
    doNotContact: z.boolean().optional(),
    consentRevokedAt: z.string().datetime().optional(),
    notes: z.string().max(500).optional(),
  })
  .strict();

export type LeadConsent = z.infer<typeof LeadConsentSchema>;

export const LeadIngestSchema = z
  .object({
    customerAccountId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    externalLeadId: z.string().min(1).max(256),
    source: z.enum(LEAD_SOURCES),
    createdAt: z.string().datetime(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    phone: z.string().max(32).optional(),
    email: z.string().email().max(254).optional(),
    serviceRequested: z.string().max(500).optional(),
    serviceArea: z.string().max(200).optional(),
    estimatedValue: z.number().nonnegative().finite().optional(),
    currency: z.string().length(3).optional(),
    consent: LeadConsentSchema.optional(),
    sourceMetadata: z
      .record(z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  })
  .strict();

export type LeadIngestInput = z.infer<typeof LeadIngestSchema>;

export const LeadSchema = LeadIngestSchema.extend({
  leadId: z.string().min(1),
  materialFingerprint: z.string().min(1),
  recordRevision: z.number().int().positive(),
  ingestedAt: z.string().datetime(),
}).strict();

export type Lead = z.infer<typeof LeadSchema>;

export function parseLead(input: unknown): Lead {
  return LeadSchema.parse(input);
}

export function parseLeadIngest(input: unknown): LeadIngestInput {
  return LeadIngestSchema.parse(input);
}

/** Stable identity for idempotent ingest. */
export function leadSourceIdentityKey(input: {
  customerAccountId: string;
  source: LeadSource;
  externalLeadId: string;
}): string {
  return `${input.customerAccountId}|${input.source}|${input.externalLeadId}`;
}

/** Material fields that must not silently diverge on re-ingest. */
export function leadMaterialFingerprint(input: LeadIngestInput): string {
  return hashCanonical({
    customerAccountId: input.customerAccountId,
    projectId: input.projectId,
    externalLeadId: input.externalLeadId,
    source: input.source,
    firstName: input.firstName ?? null,
    lastName: input.lastName ?? null,
    phone: input.phone ?? null,
    email: input.email ?? null,
    serviceRequested: input.serviceRequested ?? null,
    serviceArea: input.serviceArea ?? null,
    estimatedValue: input.estimatedValue ?? null,
    currency: input.currency ?? null,
    consent: input.consent ?? null,
  });
}

export function newLeadId(input: {
  customerAccountId: string;
  source: LeadSource;
  externalLeadId: string;
}): string {
  return `lead_${hashCanonical(leadSourceIdentityKey(input)).slice(0, 24)}`;
}
