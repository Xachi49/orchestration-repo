import { z } from "zod";
import { hashCanonical } from "./hash.js";
import { TRUST_PROVENANCE_CLASSES } from "./provenance.js";

export const ATTRIBUTION_TYPES = [
  "APPOINTMENT_VALUE_ESTIMATE",
  "SALE_RECORDED",
  "PAYMENT_COLLECTED",
] as const;

export const ATTRIBUTION_CONFIDENCE = [
  "ESTIMATED",
  "ATTESTED_SALE",
  "ATTESTED_PAYMENT",
  "CONFIRMED_SALE",
  "CONFIRMED_PAYMENT",
] as const;

export const RevenueAttributionSchema = z
  .object({
    attributionId: z.string().min(1),
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    attributionType: z.enum(ATTRIBUTION_TYPES),
    amount: z.number().nonnegative().finite(),
    currency: z.string().length(3),
    sourceEventId: z.string().min(1),
    /** External/source identity label from the event (not trust). */
    sourceIdentity: z.string().min(1),
    /** Server-assigned trust provenance — never caller-elevated. */
    trustProvenance: z.enum(TRUST_PROVENANCE_CLASSES),
    confidenceClass: z.enum(ATTRIBUTION_CONFIDENCE),
    attributionWindowDays: z.number().int().positive(),
    attributionRuleVersion: z.string().min(1),
    attributedAt: z.string().datetime(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type RevenueAttribution = z.infer<typeof RevenueAttributionSchema>;

export function parseRevenueAttribution(input: unknown): RevenueAttribution {
  return RevenueAttributionSchema.parse(input);
}

export function newAttributionId(input: {
  recoveryCaseId: string;
  sourceEventId: string;
  attributionType: string;
}): string {
  return `rattr_${hashCanonical(input).slice(0, 24)}`;
}

export const ATTRIBUTION_RULE_VERSION = "rr-attribution-v2";

export function withinAttributionWindow(input: {
  engagementAt: string;
  eventAt: string;
  windowDays: number;
}): boolean {
  const start = Date.parse(input.engagementAt);
  const end = Date.parse(input.eventAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return false;
  }
  return end - start <= input.windowDays * 24 * 60 * 60 * 1000;
}

export function isConfirmedBookedAttribution(
  a: RevenueAttribution,
): boolean {
  return a.confidenceClass === "CONFIRMED_SALE";
}

export function isConfirmedCollectedAttribution(
  a: RevenueAttribution,
): boolean {
  return a.confidenceClass === "CONFIRMED_PAYMENT";
}

export function isAttestedAttribution(a: RevenueAttribution): boolean {
  return (
    a.confidenceClass === "ATTESTED_SALE" ||
    a.confidenceClass === "ATTESTED_PAYMENT"
  );
}

export function isProductionEconomicsAttribution(
  a: RevenueAttribution,
): boolean {
  return a.trustProvenance !== "FAKE_TEST";
}
