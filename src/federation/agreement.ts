import { createHash } from "node:crypto";
import { z } from "zod";
import { FEDERATION_ACTIONS } from "./doctrine.js";
import {
  canonicalizeParticipantIds,
  computeParticipantSetHash,
  computeScopeHash,
  FederationScopeSchema,
} from "./scope.js";

export const FEDERATION_AGREEMENT_STATUSES = [
  "DRAFT",
  "PROPOSED",
  "RATIFYING",
  "ACTIVE",
  "SUSPENDED",
  "SUPERSEDED",
  "REVOKED",
  "EXPIRED",
] as const;

export type FederationAgreementStatus =
  (typeof FEDERATION_AGREEMENT_STATUSES)[number];

export const FederationAgreementSchema = z
  .object({
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    baseAgreementVersion: z.number().int().positive().optional(),
    baseAgreementHash: z.string().min(1).optional(),
    participantInstitutionIds: z.array(z.string().min(1)).min(2),
    participantSetHash: z.string().min(1),
    scope: FederationScopeSchema,
    scopeHash: z.string().min(1),
    allowedActions: z.array(z.enum(FEDERATION_ACTIONS)).min(1),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime().optional(),
    expiresAt: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
    proposedAt: z.string().datetime().optional(),
    proposedByPrincipalId: z.string().min(1),
    proposingInstitutionId: z.string().min(1),
    status: z.enum(FEDERATION_AGREEMENT_STATUSES),
    baseFederationStateFingerprint: z.string().min(1),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type FederationAgreement = z.infer<typeof FederationAgreementSchema>;

export function computeAgreementHash(
  input: Omit<
    FederationAgreement,
    "agreementHash" | "recordRevision" | "status"
  > & { status?: FederationAgreementStatus },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        baseAgreementVersion: input.baseAgreementVersion ?? null,
        baseAgreementHash: input.baseAgreementHash ?? null,
        participantInstitutionIds: [...input.participantInstitutionIds].sort(),
        participantSetHash: input.participantSetHash,
        scopeHash: input.scopeHash,
        allowedActions: [...input.allowedActions].sort(),
        effectiveFrom: input.effectiveFrom,
        effectiveUntil: input.effectiveUntil ?? null,
        expiresAt: input.expiresAt ?? null,
        createdAt: input.createdAt,
        proposedAt: input.proposedAt ?? null,
        proposedByPrincipalId: input.proposedByPrincipalId,
        proposingInstitutionId: input.proposingInstitutionId,
        baseFederationStateFingerprint: input.baseFederationStateFingerprint,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withAgreementHash(
  input: Omit<FederationAgreement, "agreementHash">,
): FederationAgreement {
  const { recordRevision, status, scope, ...rest } = input;
  const participants = canonicalizeParticipantIds(
    input.participantInstitutionIds,
  );
  const participantSetHash = computeParticipantSetHash(participants);
  const scopeHash = computeScopeHash({
    ...scope,
    participantInstitutionIds: participants,
  });
  const material = {
    ...rest,
    participantInstitutionIds: participants,
    participantSetHash,
    scope: {
      ...scope,
      participantInstitutionIds: participants,
    },
    scopeHash,
    status,
  };
  const agreementHash = computeAgreementHash(material);
  return FederationAgreementSchema.parse({
    ...material,
    agreementHash,
    recordRevision,
  });
}

export function mintFederationId(input: {
  participantInstitutionIds: readonly string[];
  createdAt: string;
}): string {
  const sorted = canonicalizeParticipantIds(input.participantInstitutionIds);
  return `fed_${createHash("sha256")
    .update(JSON.stringify({ participants: sorted, createdAt: input.createdAt }), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function mintAgreementId(input: {
  federationId: string;
  agreementVersion: number;
  createdAt: string;
}): string {
  return `fag_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function isAgreementMaterialImmutable(
  status: FederationAgreementStatus,
): boolean {
  return status !== "DRAFT";
}
