import { createHash } from "node:crypto";
import { z } from "zod";
import { CausalError } from "./errors.js";

/**
 * PromotedCausalClaim is governed causal knowledge / reusable precedent.
 * It is NOT policy, authorization, repository truth, execution permission,
 * strategy selection, or capital allocation.
 *
 * Phase 9 integration: dedicated causal storage with retrieval under the
 * governed-memory boundary (advisory only). No competing generic precedent
 * authority — Phase 9 LEARN_FROM_RUN remains run-centric; PromotedCausalClaim
 * is a specialized governed artifact, not a second Memory authority.
 */
export const PROMOTED_CAUSAL_CLAIM_BOUNDARIES = {
  notPolicy: "PROMOTED CAUSAL CLAIM != POLICY",
  notAuthorization: "PromotedCausalClaim does not create execution authority",
  notStrategy: "PromotedCausalClaim does not select scenarios or allocate capital",
  notControlPlane: "CAUSAL KNOWLEDGE != CURRENT CONTROL-PLANE TRUTH",
  phase9:
    "Dedicated causal storage; advisory retrieval only — no second memory authority",
} as const;

export const PromotedCausalClaimSchema = z
  .object({
    promotedCausalClaimId: z.string().min(1),
    claimId: z.string().min(1),
    claimVersion: z.number().int().positive(),
    claimHash: z.string().min(1),
    claimType: z.string().min(1),
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    reviewRecordId: z.string().min(1),
    identificationAnalysisId: z.string().min(1),
    evidenceSynthesisId: z.string().min(1),
    evidenceSynthesisHash: z.string().min(1),
    synthesisStatus: z.enum([
      "CONSISTENT",
      "MIXED",
      "CONTRADICTORY",
      "INSUFFICIENT",
    ]),
    evidenceHashes: z.array(z.string().min(1)).default([]),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    limitations: z.array(z.string()).default([]),
    contradictoryEvidenceRefs: z.array(z.string().min(1)).default([]),
    promotionBasisHash: z.string().min(1),
    /** ACTIVE for calibration/retrieval; STALE when provenance invalidated. */
    status: z.enum(["ACTIVE", "STALE"]).default("ACTIVE"),
    staleReason: z.string().max(2000).optional(),
    promotedAt: z.string().datetime(),
    promotedBy: z.string().min(1),
  })
  .strict();

export type PromotedCausalClaim = z.infer<typeof PromotedCausalClaimSchema>;

export function computePromotionBasisHash(input: {
  claimId: string;
  claimVersion: number;
  claimHash: string;
  claimType: string;
  reviewRecordId: string;
  identificationAnalysisId: string;
  evidenceSynthesisId: string;
  evidenceSynthesisHash: string;
  synthesisStatus: string;
  evidenceHashes: readonly string[];
  contradictoryEvidenceRefs: readonly string[];
  populationScope: string;
  environmentScope: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ...input,
        evidenceHashes: [...input.evidenceHashes].sort(),
        contradictoryEvidenceRefs: [...input.contradictoryEvidenceRefs].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintPromotedCausalClaimId(input: {
  claimHash: string;
  reviewRecordId: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `pcc_${digest}`;
}

/** Directional claims that require CONSISTENT synthesis to promote. */
export const DIRECTIONAL_CLAIM_TYPES = [
  "POSITIVE_EFFECT",
  "NEGATIVE_EFFECT",
  "NO_MATERIAL_EFFECT_DETECTED",
] as const;

export function isDirectionalClaimType(claimType: string): boolean {
  return (DIRECTIONAL_CLAIM_TYPES as readonly string[]).includes(claimType);
}

/**
 * MIXED/CONTRADICTORY synthesis cannot promote directional claims as if consistent.
 */
export function assertPromotionCompatibleWithSynthesis(input: {
  synthesisStatus: string;
  claimType: string;
}): void {
  if (
    (input.synthesisStatus === "MIXED" ||
      input.synthesisStatus === "CONTRADICTORY") &&
    isDirectionalClaimType(input.claimType)
  ) {
    throw new CausalError(
      "CAUSAL_PROMOTION_REJECTED",
      `Cannot promote directional claim ${input.claimType} under ${input.synthesisStatus} synthesis`,
      input,
    );
  }
}
