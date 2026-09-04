import { createHash } from "node:crypto";
import { z } from "zod";

export const ACTIVATION_STATUSES = [
  "STAGED",
  "ACTIVATED",
  "BLOCKED",
  "STALE",
] as const;

export type ActivationStatus = (typeof ACTIVATION_STATUSES)[number];

export const ConstitutionalActivationRecordSchema = z
  .object({
    activationRecordId: z.string().min(1),
    proposalId: z.string().min(1),
    proposalHash: z.string().min(1),
    proposalVersion: z.number().int().positive(),
    baseGovernanceFingerprint: z.string().min(1),
    targetGovernanceFingerprint: z.string().min(1),
    reviewDecisionId: z.string().min(1),
    activatorPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    effectiveAt: z.string().datetime(),
    status: z.enum(ACTIVATION_STATUSES),
    activationHash: z.string().min(1),
    createdAt: z.string().datetime(),
    activatedAt: z.string().datetime().optional(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ConstitutionalActivationRecord = z.infer<
  typeof ConstitutionalActivationRecordSchema
>;

/** Unforgeable internal token — only ConstitutionalChangeService may construct. */
export const ConstitutionalActivationContextSchema = z
  .object({
    _brand: z.literal("ConstitutionalActivationContext"),
    proposalId: z.string().min(1),
    proposalHash: z.string().min(1),
    activationRecordId: z.string().min(1),
    baseGovernanceFingerprint: z.string().min(1),
    targetGovernanceFingerprint: z.string().min(1),
    activatedByPrincipalId: z.string().min(1),
    institutionId: z.string().min(1),
  })
  .strict();

export type ConstitutionalActivationContext = z.infer<
  typeof ConstitutionalActivationContextSchema
>;

export function createActivationContext(
  input: Omit<ConstitutionalActivationContext, "_brand">,
): ConstitutionalActivationContext {
  return ConstitutionalActivationContextSchema.parse({
    ...input,
    _brand: "ConstitutionalActivationContext",
  });
}

export function computeActivationHash(
  input: Omit<
    ConstitutionalActivationRecord,
    "activationHash" | "activationRecordId" | "recordRevision"
  >,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function withActivationRecordHash(
  input: Omit<ConstitutionalActivationRecord, "activationHash">,
): ConstitutionalActivationRecord {
  const { activationRecordId, recordRevision, ...rest } = input;
  const activationHash = computeActivationHash(rest);
  return ConstitutionalActivationRecordSchema.parse({
    ...input,
    activationHash,
  });
}

export function mintActivationRecordId(input: {
  proposalId: string;
  effectiveAt: string;
}): string {
  return `car_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

export function mintActivationIdempotencyKey(input: {
  proposalId: string;
  proposalVersion: number;
  proposalHash: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
