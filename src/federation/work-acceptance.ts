import { createHash } from "node:crypto";
import { z } from "zod";

export const FederatedWorkAcceptanceSchema = z
  .object({
    acceptanceId: z.string().min(1),
    intentId: z.string().min(1),
    intentVersion: z.number().int().positive(),
    intentHash: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementVersion: z.number().int().positive(),
    agreementHash: z.string().min(1),
    targetInstitutionId: z.string().min(1),
    targetProjectId: z.string().min(1),
    environment: z.string().min(1),
    decision: z.enum(["ACCEPT", "REJECT"]),
    actorPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    proofHash: z.string().min(1),
    decidedAt: z.string().datetime(),
    acceptanceHash: z.string().min(1),
    reason: z.string().max(4000).optional(),
  })
  .strict();

export type FederatedWorkAcceptance = z.infer<
  typeof FederatedWorkAcceptanceSchema
>;

export function computeAcceptanceHash(
  input: Omit<FederatedWorkAcceptance, "acceptanceHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        acceptanceId: input.acceptanceId,
        intentId: input.intentId,
        intentVersion: input.intentVersion,
        intentHash: input.intentHash,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementVersion: input.agreementVersion,
        agreementHash: input.agreementHash,
        targetInstitutionId: input.targetInstitutionId,
        targetProjectId: input.targetProjectId,
        environment: input.environment,
        decision: input.decision,
        actorPrincipalId: input.actorPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId,
        proofHash: input.proofHash,
        decidedAt: input.decidedAt,
        reason: input.reason ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withAcceptanceHash(
  input: Omit<FederatedWorkAcceptance, "acceptanceHash">,
): FederatedWorkAcceptance {
  return FederatedWorkAcceptanceSchema.parse({
    ...input,
    acceptanceHash: computeAcceptanceHash(input),
  });
}

export function mintAcceptanceId(input: {
  intentId: string;
  decision: string;
  decidedAt: string;
}): string {
  return `fwa_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function compileWorkAcceptanceSubjectBinding(input: {
  federationId: string;
  agreementId: string;
  agreementHash: string;
  intentId: string;
  intentHash: string;
  targetInstitutionId: string;
  targetProjectId: string;
  environment: string;
}): {
  subjectType: "FEDERATION_WORK_ACCEPTANCE";
  subjectId: string;
  subjectHash: string;
  requiredRole: "FEDERATION_WORK_ACCEPTOR";
  action: "FEDERATION_WORK_ACCEPTANCE";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementHash: input.agreementHash,
        intentId: input.intentId,
        intentHash: input.intentHash,
        targetInstitutionId: input.targetInstitutionId,
        targetProjectId: input.targetProjectId,
        environment: input.environment,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "FEDERATION_WORK_ACCEPTANCE",
    subjectId: input.intentId,
    subjectHash,
    requiredRole: "FEDERATION_WORK_ACCEPTOR",
    action: "FEDERATION_WORK_ACCEPTANCE",
  };
}
