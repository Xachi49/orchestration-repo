import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const SystemCertificateRevocationSchema = z
  .object({
    revocationId: z.string().min(1),
    certificateId: z.string().min(1),
    certificateHash: z.string().min(1),
    reason: z.string().min(1),
    revokedByPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    proofHash: z.string().min(1),
    effectiveAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    revocationHash: z.string().min(1),
  })
  .strict();

export type SystemCertificateRevocation = z.infer<
  typeof SystemCertificateRevocationSchema
>;

export function computeRevocationHash(
  input: Omit<SystemCertificateRevocation, "revocationHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        revocationId: input.revocationId,
        certificateId: input.certificateId,
        certificateHash: input.certificateHash,
        reason: input.reason,
        revokedByPrincipalId: input.revokedByPrincipalId,
        institutionalAuthorizationProofId:
          input.institutionalAuthorizationProofId,
        proofHash: input.proofHash,
        effectiveAt: input.effectiveAt,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withRevocationHash(
  input: Omit<SystemCertificateRevocation, "revocationHash">,
): SystemCertificateRevocation {
  return SystemCertificateRevocationSchema.parse({
    ...input,
    revocationHash: computeRevocationHash(input),
  });
}

export function mintRevocationId(): string {
  return `arev_${randomUUID()}`;
}
