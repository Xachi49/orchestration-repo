import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * CAUSAL_REVIEWER ≠ APPROVER ≠ EXPERIMENT_SPONSOR ≠ STRATEGY_SELECTOR
 * ≠ PORTFOLIO_ALLOCATOR ≠ PROGRAM_MATERIALIZER.
 *
 * Human review does NOT create factual evidence.
 */
export const CAUSAL_REVIEWER_AUTHORITY_BOUNDARIES = {
  causalReviewer:
    "CAUSAL_REVIEWER may promote bounded causal knowledge — not policy or execution",
  approver: "Phase 6 APPROVER authorizes operational execution — not causal promotion",
  experimentSponsor:
    "EXPERIMENT_SPONSOR sponsors experiments — not causal claim promotion",
  strategySelector:
    "STRATEGY_SELECTOR chooses scenarios — not causal claim promotion",
  portfolioAllocator:
    "PORTFOLIO_ALLOCATOR authorizes capital — not causal claim promotion",
  programMaterializer:
    "PROGRAM_MATERIALIZER approves decomposition — not causal claim promotion",
  reviewNotEvidence: "HUMAN REVIEW != FACTUAL EVIDENCE",
  promotedNotPolicy: "PROMOTED CAUSAL CLAIM != POLICY",
} as const;

export const CausalReviewDecisionSchema = z.enum([
  "PROMOTE",
  "REJECT",
  "REQUEST_REVISION",
]);
export type CausalReviewDecision = z.infer<typeof CausalReviewDecisionSchema>;

export const CausalReviewRequestSchema = z
  .object({
    reviewRequestId: z.string().min(1),
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    claimId: z.string().min(1),
    claimVersion: z.number().int().positive(),
    claimHash: z.string().min(1),
    graphHash: z.string().min(1),
    identificationAnalysisId: z.string().min(1),
    evidenceSynthesisHash: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "DECIDED", "EXPIRED"]),
    reviewerId: z.string().min(1).optional(),
    decision: CausalReviewDecisionSchema.optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type CausalReviewRequest = z.infer<typeof CausalReviewRequestSchema>;

export const CausalReviewRecordSchema = z
  .object({
    reviewRecordId: z.string().min(1),
    reviewRequestId: z.string().min(1),
    causalQuestionId: z.string().min(1),
    claimId: z.string().min(1),
    claimVersion: z.number().int().positive(),
    claimHash: z.string().min(1),
    reviewerId: z.string().min(1),
    decision: CausalReviewDecisionSchema,
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    decidedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalReviewRecord = z.infer<typeof CausalReviewRecordSchema>;

export function computeCausalReviewSubjectHash(input: {
  causalQuestionId: string;
  causalQuestionVersion: number;
  claimId: string;
  claimVersion: number;
  claimHash: string;
  graphHash: string;
  identificationAnalysisId: string;
  evidenceSynthesisHash: string;
  populationScope: string;
  environmentScope: string;
  policyBundleFingerprint: string;
  capabilitySetFingerprint: string;
  expiresAt: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintCausalReviewRequestId(input: {
  causalQuestionId: string;
  claimHash: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `crr_${input.causalQuestionId}_${digest}`.slice(0, 120);
}

export function mintCausalReviewRecordId(input: {
  reviewRequestId: string;
  decidedAt: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `crrrec_${digest}`;
}
