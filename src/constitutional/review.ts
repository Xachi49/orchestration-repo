import { createHash } from "node:crypto";
import { z } from "zod";

export const ConstitutionalReviewDecisionSchema = z
  .object({
    decisionId: z.string().min(1),
    proposalId: z.string().min(1),
    proposalHash: z.string().min(1),
    proposalVersion: z.number().int().positive(),
    baseGovernanceFingerprint: z.string().min(1),
    reviewerPrincipalId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().max(4000).optional(),
    decisionHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ConstitutionalReviewDecision = z.infer<
  typeof ConstitutionalReviewDecisionSchema
>;

export function computeReviewDecisionHash(
  input: Omit<ConstitutionalReviewDecision, "decisionHash" | "decisionId">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function withReviewDecisionHash(
  input: Omit<ConstitutionalReviewDecision, "decisionHash">,
): ConstitutionalReviewDecision {
  const decisionHash = computeReviewDecisionHash(input);
  return ConstitutionalReviewDecisionSchema.parse({ ...input, decisionHash });
}

export function mintReviewDecisionId(input: {
  proposalId: string;
  reviewerPrincipalId: string;
  createdAt: string;
}): string {
  return `crd_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 20)}`;
}

export const CONSTITUTIONAL_REVIEW_SUBJECT_TYPE =
  "CONSTITUTIONAL_CHANGE_REVIEW" as const;
export const CONSTITUTIONAL_ACTIVATION_SUBJECT_TYPE =
  "CONSTITUTIONAL_CHANGE_ACTIVATION" as const;

export function compileReviewSubjectBinding(input: {
  proposalId: string;
  proposalVersion: number;
  proposalHash: string;
}) {
  return {
    subjectType: CONSTITUTIONAL_REVIEW_SUBJECT_TYPE,
    subjectId: input.proposalId,
    subjectVersion: input.proposalVersion,
    subjectHash: input.proposalHash,
    requiredRole: "CONSTITUTIONAL_REVIEWER" as const,
  };
}

export function compileActivationSubjectBinding(input: {
  proposalId: string;
  proposalVersion: number;
  proposalHash: string;
}) {
  return {
    subjectType: CONSTITUTIONAL_ACTIVATION_SUBJECT_TYPE,
    subjectId: input.proposalId,
    subjectVersion: input.proposalVersion,
    subjectHash: input.proposalHash,
    requiredRole: "CONSTITUTIONAL_ACTIVATOR" as const,
  };
}
