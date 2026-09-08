import { createHash } from "node:crypto";
import { z } from "zod";

export const FederatedEvidenceEnvelopeSchema = z
  .object({
    envelopeId: z.string().min(1),
    envelopeHash: z.string().min(1),
    federationId: z.string().min(1),
    agreementId: z.string().min(1),
    agreementHash: z.string().min(1),
    intentId: z.string().min(1).optional(),
    sourceInstitutionId: z.string().min(1),
    sourceProjectId: z.string().min(1),
    sourceEvidenceId: z.string().min(1),
    sourceVerificationId: z.string().min(1).optional(),
    contentHash: z.string().min(1),
    destinationInstitutionId: z.string().min(1),
    destinationProjectId: z.string().min(1),
    dataClassification: z.string().min(1),
    provenance: z.string().min(1),
    /** Receiving-side trust status — never auto-promoted. */
    receivingStatus: z.literal("EXTERNAL_UNVERIFIED"),
    sharedByPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1).optional(),
    sharedAt: z.string().datetime(),
  })
  .strict();

export type FederatedEvidenceEnvelope = z.infer<
  typeof FederatedEvidenceEnvelopeSchema
>;

export function computeEnvelopeHash(
  input: Omit<FederatedEvidenceEnvelope, "envelopeHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        envelopeId: input.envelopeId,
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementHash: input.agreementHash,
        intentId: input.intentId ?? null,
        sourceInstitutionId: input.sourceInstitutionId,
        sourceProjectId: input.sourceProjectId,
        sourceEvidenceId: input.sourceEvidenceId,
        sourceVerificationId: input.sourceVerificationId ?? null,
        contentHash: input.contentHash,
        destinationInstitutionId: input.destinationInstitutionId,
        destinationProjectId: input.destinationProjectId,
        dataClassification: input.dataClassification,
        provenance: input.provenance,
        receivingStatus: input.receivingStatus,
        sharedByPrincipalId: input.sharedByPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId ?? null,
        sharedAt: input.sharedAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withEnvelopeHash(
  input: Omit<FederatedEvidenceEnvelope, "envelopeHash">,
): FederatedEvidenceEnvelope {
  return FederatedEvidenceEnvelopeSchema.parse({
    ...input,
    envelopeHash: computeEnvelopeHash(input),
  });
}

export function mintEnvelopeId(input: {
  sourceEvidenceId: string;
  destinationInstitutionId: string;
  sharedAt: string;
}): string {
  return `fee_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24)}`;
}

export function compileEvidenceShareSubjectBinding(input: {
  federationId: string;
  agreementId: string;
  agreementHash: string;
  envelopeId: string;
  contentHash: string;
  sourceInstitutionId: string;
  destinationInstitutionId: string;
}): {
  subjectType: "FEDERATION_EVIDENCE_SHARE";
  subjectId: string;
  subjectHash: string;
  requiredRole: "FEDERATION_EVIDENCE_SHARER";
  action: "FEDERATION_EVIDENCE_SHARE";
} {
  const subjectHash = createHash("sha256")
    .update(
      JSON.stringify({
        federationId: input.federationId,
        agreementId: input.agreementId,
        agreementHash: input.agreementHash,
        envelopeId: input.envelopeId,
        contentHash: input.contentHash,
        sourceInstitutionId: input.sourceInstitutionId,
        destinationInstitutionId: input.destinationInstitutionId,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    subjectType: "FEDERATION_EVIDENCE_SHARE",
    subjectId: input.envelopeId,
    subjectHash,
    requiredRole: "FEDERATION_EVIDENCE_SHARER",
    action: "FEDERATION_EVIDENCE_SHARE",
  };
}
