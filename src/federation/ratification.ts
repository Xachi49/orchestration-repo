import { createHash } from "node:crypto";
import { z } from "zod";

export const FederationRatificationSchema = z
  .object({
    ratificationId: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    institutionId: z.string().min(1),
    ratifierPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    proofHash: z.string().min(1),
    authoritySnapshotIds: z.array(z.string().min(1)).min(1),
    authoritySnapshotHashes: z.array(z.string().min(1)).min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    ratifiedAt: z.string().datetime(),
    ratificationHash: z.string().min(1),
  })
  .strict();

export type FederationRatification = z.infer<
  typeof FederationRatificationSchema
>;

export function computeRatificationHash(
  input: Omit<FederationRatification, "ratificationHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ratificationId: input.ratificationId,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        institutionId: input.institutionId,
        ratifierPrincipalId: input.ratifierPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId,
        proofHash: input.proofHash,
        authoritySnapshotIds: [...input.authoritySnapshotIds].sort(),
        authoritySnapshotHashes: [...input.authoritySnapshotHashes].sort(),
        projectId: input.projectId,
        environment: input.environment,
        ratifiedAt: input.ratifiedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withRatificationHash(
  input: Omit<FederationRatification, "ratificationHash">,
): FederationRatification {
  return FederationRatificationSchema.parse({
    ...input,
    ratificationHash: computeRatificationHash(input),
  });
}

export function mintRatificationId(input: {
  agreementId: string;
  institutionId: string;
  ratifiedAt: string;
}): string {
  return `frat_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function compileRatificationSubjectBinding(input: {
  federationId: string;
  agreementId: string;
  agreementVersion: number;
  agreementHash: string;
  participantSetHash: string;
  scopeHash: string;
  institutionId: string;
}): {
  subjectType: "FEDERATION_AGREEMENT_RATIFICATION";
  subjectId: string;
  subjectHash: string;
  subjectVersion: number;
  requiredRole: "FEDERATION_RATIFIER";
  action: "FEDERATION_AGREEMENT_RATIFICATION";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        participantSetHash: input.participantSetHash,
        scopeHash: input.scopeHash,
        institutionId: input.institutionId,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "FEDERATION_AGREEMENT_RATIFICATION",
    subjectId: `${input.agreementId}:${input.institutionId}`,
    subjectHash,
    subjectVersion: input.agreementVersion,
    requiredRole: "FEDERATION_RATIFIER",
    action: "FEDERATION_AGREEMENT_RATIFICATION",
  };
}
