import { createHash } from "node:crypto";
import { z } from "zod";
import { ConstitutionalChangeOperationSchema } from "./operations.js";
import { ConstitutionalRiskClassSchema } from "./operations.js";

export const PROPOSAL_STATUSES = [
  "DRAFT",
  "SUBMITTED",
  "VALIDATED",
  "AWAITING_REVIEW",
  "AUTHORIZED",
  "STAGED",
  "ACTIVATED",
  "REJECTED",
  "CANCELLED",
  "EXPIRED",
  "STALE",
  "FAILED",
] as const;

export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const ConstitutionalChangeProposalSchema = z
  .object({
    constitutionalChangeProposalId: z.string().min(1),
    institutionId: z.string().min(1),
    proposalVersion: z.number().int().positive(),
    title: z.string().min(1).max(500),
    rationale: z.string().min(1).max(8000),
    changeOperations: z.array(ConstitutionalChangeOperationSchema).min(1),
    riskClass: ConstitutionalRiskClassSchema,
    proposedByPrincipalId: z.string().min(1),
    baseGovernanceFingerprint: z.string().min(1),
    proposalHash: z.string().min(1),
    status: z.enum(PROPOSAL_STATUSES),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    submittedAt: z.string().datetime().optional(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ConstitutionalChangeProposal = z.infer<
  typeof ConstitutionalChangeProposalSchema
>;

export function computeProposalHash(
  input: Omit<
    ConstitutionalChangeProposal,
    "proposalHash" | "recordRevision" | "status"
  > & { status?: ProposalStatus },
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        constitutionalChangeProposalId:
          input.constitutionalChangeProposalId,
        institutionId: input.institutionId,
        proposalVersion: input.proposalVersion,
        title: input.title,
        rationale: input.rationale,
        changeOperations: input.changeOperations,
        riskClass: input.riskClass,
        proposedByPrincipalId: input.proposedByPrincipalId,
        baseGovernanceFingerprint: input.baseGovernanceFingerprint,
        createdAt: input.createdAt,
        expiresAt: input.expiresAt ?? null,
        submittedAt: input.submittedAt ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withProposalHash(
  input: Omit<ConstitutionalChangeProposal, "proposalHash">,
): ConstitutionalChangeProposal {
  const { recordRevision, ...rest } = input;
  const proposalHash = computeProposalHash(rest);
  return ConstitutionalChangeProposalSchema.parse({ ...input, proposalHash });
}

export function mintProposalId(input: {
  institutionId: string;
  createdAt: string;
  title: string;
}): string {
  return `ccp_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

export function isProposalMaterialImmutable(status: ProposalStatus): boolean {
  return status !== "DRAFT" && status !== "CANCELLED";
}
