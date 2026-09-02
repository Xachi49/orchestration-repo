import { createHash } from "node:crypto";
import { z } from "zod";

export const InstitutionalAuthorizationProofSchema = z
  .object({
    institutionalAuthorizationProofId: z.string().min(1),
    governanceCaseId: z.string().min(1),
    governanceCaseHash: z.string().min(1),
    subjectType: z.string().min(1),
    subjectId: z.string().min(1),
    subjectVersion: z.number().int().positive().optional(),
    subjectHash: z.string().min(1),
    mandateIds: z.array(z.string().min(1)).min(1),
    mandateHashes: z.array(z.string().min(1)).min(1),
    attestationIds: z.array(z.string().min(1)).min(1),
    attestationHashes: z.array(z.string().min(1)).min(1),
    authoritySnapshotIds: z.array(z.string().min(1)).default([]),
    authoritySnapshotHashes: z.array(z.string().min(1)).default([]),
    projectScope: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    quorumResult: z.literal("SATISFIED"),
    separationOfDutyProof: z.array(z.string().min(1)).default([]),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    proofHash: z.string().min(1),
    status: z.enum(["ACTIVE", "STALE", "REVOKED"]).default("ACTIVE"),
  })
  .strict();

export type InstitutionalAuthorizationProof = z.infer<
  typeof InstitutionalAuthorizationProofSchema
>;

export function computeProofHash(
  input: Omit<InstitutionalAuthorizationProof, "proofHash" | "status">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        governanceCaseId: input.governanceCaseId,
        governanceCaseHash: input.governanceCaseHash,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        subjectVersion: input.subjectVersion ?? null,
        subjectHash: input.subjectHash,
        mandateIds: [...input.mandateIds].sort(),
        mandateHashes: [...input.mandateHashes].sort(),
        attestationIds: [...input.attestationIds].sort(),
        attestationHashes: [...input.attestationHashes].sort(),
        authoritySnapshotIds: [...input.authoritySnapshotIds].sort(),
        authoritySnapshotHashes: [...input.authoritySnapshotHashes].sort(),
        projectScope: [...input.projectScope].sort(),
        environmentScope: [...input.environmentScope].sort(),
        quorumResult: input.quorumResult,
        separationOfDutyProof: [...input.separationOfDutyProof].sort(),
        createdAt: input.createdAt,
        expiresAt: input.expiresAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withProofHash(
  input: Omit<InstitutionalAuthorizationProof, "proofHash">,
): InstitutionalAuthorizationProof {
  const { status, ...rest } = input;
  const proofHash = computeProofHash(rest);
  return InstitutionalAuthorizationProofSchema.parse({
    ...input,
    proofHash,
  });
}

export function mintProofId(caseHash: string): string {
  return `iap_${caseHash.slice(0, 24)}`;
}

export const PROOF_NOT_BUSINESS_AUTHORIZATION = {
  notAuthorizationRecord: "InstitutionalAuthorizationProof != AuthorizationRecord",
  notPortfolio: "InstitutionalAuthorizationProof != Portfolio authorization",
  notExperiment: "InstitutionalAuthorizationProof != Experiment sponsorship",
  notStrategy: "InstitutionalAuthorizationProof != Strategy selection",
  notCausal: "InstitutionalAuthorizationProof != Causal promotion",
  notDecisionPolicy:
    "InstitutionalAuthorizationProof != Decision Policy activation",
  notExecution: "InstitutionalAuthorizationProof != execution authority",
  onlyPrerequisite: "It is only an additional prerequisite",
} as const;
