import { createHash } from "node:crypto";
import { z } from "zod";

export const FederationActivationRecordSchema = z
  .object({
    activationRecordId: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    participantInstitutionIds: z.array(z.string().min(1)).min(2),
    ratificationIds: z.array(z.string().min(1)).min(2),
    ratificationHashes: z.array(z.string().min(1)).min(2),
    baseFederationStateFingerprint: z.string().min(1),
    targetFederationStateFingerprint: z.string().min(1),
    activatedAt: z.string().datetime(),
    activationHash: z.string().min(1),
    status: z.enum(["ACTIVATED"]).default("ACTIVATED"),
  })
  .strict();

export type FederationActivationRecord = z.infer<
  typeof FederationActivationRecordSchema
>;

export function computeActivationRecordHash(
  input: Omit<FederationActivationRecord, "activationHash" | "status">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        activationRecordId: input.activationRecordId,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        participantInstitutionIds: [
          ...input.participantInstitutionIds,
        ].sort(),
        ratificationIds: [...input.ratificationIds].sort(),
        ratificationHashes: [...input.ratificationHashes].sort(),
        baseFederationStateFingerprint: input.baseFederationStateFingerprint,
        targetFederationStateFingerprint:
          input.targetFederationStateFingerprint,
        activatedAt: input.activatedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withActivationRecordHash(
  input: Omit<FederationActivationRecord, "activationHash">,
): FederationActivationRecord {
  const { status, ...rest } = input;
  return FederationActivationRecordSchema.parse({
    ...input,
    activationHash: computeActivationRecordHash(rest),
  });
}

export function mintActivationRecordId(input: {
  agreementId: string;
  agreementVersion: number;
  activatedAt: string;
}): string {
  return `fac_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}
