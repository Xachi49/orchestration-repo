import { createHash } from "node:crypto";
import { z } from "zod";

export const FederationParticipationChangeSchema = z
  .object({
    changeId: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    institutionId: z.string().min(1),
    changeType: z.enum(["WITHDRAW", "SUSPEND"]),
    actorPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    proofHash: z.string().min(1),
    effectiveAt: z.string().datetime(),
    changeHash: z.string().min(1),
  })
  .strict();

export type FederationParticipationChange = z.infer<
  typeof FederationParticipationChangeSchema
>;

export function computeParticipationChangeHash(
  input: Omit<FederationParticipationChange, "changeHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        changeId: input.changeId,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        institutionId: input.institutionId,
        changeType: input.changeType,
        actorPrincipalId: input.actorPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId,
        proofHash: input.proofHash,
        effectiveAt: input.effectiveAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withParticipationChangeHash(
  input: Omit<FederationParticipationChange, "changeHash">,
): FederationParticipationChange {
  return FederationParticipationChangeSchema.parse({
    ...input,
    changeHash: computeParticipationChangeHash(input),
  });
}

export function mintParticipationChangeId(input: {
  agreementId: string;
  institutionId: string;
  effectiveAt: string;
}): string {
  return `fpc_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function compileWithdrawalSubjectBinding(input: {
  federationId: string;
  agreementId: string;
  agreementVersion: number;
  agreementHash: string;
  institutionId: string;
}): {
  subjectType: "FEDERATION_PARTICIPATION_WITHDRAWAL";
  subjectId: string;
  subjectHash: string;
  subjectVersion: number;
  requiredRole: "FEDERATION_RATIFIER";
  action: "FEDERATION_PARTICIPATION_WITHDRAWAL";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        institutionId: input.institutionId,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "FEDERATION_PARTICIPATION_WITHDRAWAL",
    subjectId: `${input.agreementId}:${input.institutionId}:withdraw`,
    subjectHash,
    subjectVersion: input.agreementVersion,
    requiredRole: "FEDERATION_RATIFIER",
    action: "FEDERATION_PARTICIPATION_WITHDRAWAL",
  };
}
