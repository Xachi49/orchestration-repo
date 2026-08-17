import { z } from "zod";
import { HistoricalOutcomeSchema } from "./historical-run.js";
import { LearningCandidateTypeSchema } from "./candidate.js";
import { PrecedentApplicabilitySchema } from "./applicability.js";
import { PrecedentProvenanceSchema } from "./provenance.js";
import {
  CandidateOriginSchema,
  ClaimGroundingResultSchema,
  LearningClaimSchema,
} from "./claim.js";

/** Never AUTHORITATIVE — precedents advise; they do not authorize. */
export const PrecedentTrustClassSchema = z.enum([
  "EVIDENCE_BACKED_LOCAL",
  "HUMAN_REVIEWED",
  "MULTI_RUN_CORROBORATED",
]);
export type PrecedentTrustClass = z.infer<typeof PrecedentTrustClassSchema>;

export const PrecedentStatusSchema = z.enum([
  "ACTIVE",
  "SUPERSEDED",
  "RETIRED",
]);
export type PrecedentStatus = z.infer<typeof PrecedentStatusSchema>;

export const PrecedentPromotionMethodSchema = z.enum([
  "AUTO_PROMOTE",
  "HUMAN_REVIEW",
]);
export type PrecedentPromotionMethod = z.infer<
  typeof PrecedentPromotionMethodSchema
>;

export const PromotedPrecedentSchema = z
  .object({
    precedentId: z.string().min(1),
    version: z.number().int().positive(),
    candidateId: z.string().min(1),
    candidateHash: z.string().min(1),
    projectId: z.string().min(1),
    candidateType: LearningCandidateTypeSchema,
    origin: CandidateOriginSchema,
    claim: LearningClaimSchema,
    grounding: ClaimGroundingResultSchema,
    statement: z.string().min(1),
    applicability: PrecedentApplicabilitySchema,
    provenance: PrecedentProvenanceSchema,
    sourceOutcome: HistoricalOutcomeSchema,
    trustClass: PrecedentTrustClassSchema,
    promotionMethod: PrecedentPromotionMethodSchema,
    promotionDecisionId: z.string().min(1).optional(),
    supersedesPrecedentIds: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
    precedentHash: z.string().min(1),
    status: PrecedentStatusSchema.default("ACTIVE"),
    label: z.literal("ADVISORY_PRECEDENT").default("ADVISORY_PRECEDENT"),
  })
  .strict();

export type PromotedPrecedent = z.infer<typeof PromotedPrecedentSchema>;

export function parsePromotedPrecedent(input: unknown): PromotedPrecedent {
  return PromotedPrecedentSchema.parse(input);
}
