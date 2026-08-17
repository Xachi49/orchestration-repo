import { z } from "zod";
import { HistoricalOutcomeSchema } from "./historical-run.js";
import {
  PrecedentApplicabilitySchema,
  RiskClassSchema,
} from "./applicability.js";
import { PrecedentProvenanceSchema } from "./provenance.js";
import {
  CandidateOriginSchema,
  ClaimGroundingResultSchema,
  LearningClaimSchema,
} from "./claim.js";

/**
 * Candidate types are descriptive/advisory. POLICY_RULE is intentionally absent.
 */
export const LearningCandidateTypeSchema = z.enum([
  "SUCCESS_PATTERN",
  "FAILURE_PATTERN",
  "CONTAINMENT_PATTERN",
  "RESOURCE_PATTERN",
  "VERIFICATION_PATTERN",
  "DEPENDENCY_PATTERN",
  "SECURITY_PATTERN",
  "PROCESS_PATTERN",
  "EVIDENCE_GAP_PATTERN",
]);
export type LearningCandidateType = z.infer<typeof LearningCandidateTypeSchema>;

export const ConfidenceClassSchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
]);
export type ConfidenceClass = z.infer<typeof ConfidenceClassSchema>;

export const LearningCandidateStatusSchema = z.enum([
  "OBSERVED",
  "CANDIDATE",
  "PROMOTED",
  "REJECTED",
  "SUPERSEDED",
  "RETIRED",
]);
export type LearningCandidateStatus = z.infer<
  typeof LearningCandidateStatusSchema
>;

export const LearningCandidateSchema = z
  .object({
    learningCandidateId: z.string().min(1),
    sourceHistoricalRunRecordId: z.string().min(1),
    projectId: z.string().min(1),
    candidateType: LearningCandidateTypeSchema,
    origin: CandidateOriginSchema,
    claim: LearningClaimSchema,
    grounding: ClaimGroundingResultSchema,
    statement: z.string().min(1),
    applicabilityProposal: PrecedentApplicabilitySchema,
    provenance: PrecedentProvenanceSchema,
    supportingEvidenceRefs: z.array(z.string()).default([]),
    supportingFindingRefs: z.array(z.string()).default([]),
    sourceOutcome: HistoricalOutcomeSchema,
    confidenceClass: ConfidenceClassSchema.default("MEDIUM"),
    riskClass: RiskClassSchema.default("LOW"),
    createdAt: z.string().datetime(),
    candidateHash: z.string().min(1),
    status: LearningCandidateStatusSchema.default("CANDIDATE"),
    containsAuthorityLikeLanguage: z.boolean().default(false),
  })
  .strict();

export type LearningCandidate = z.infer<typeof LearningCandidateSchema>;

export function parseLearningCandidate(input: unknown): LearningCandidate {
  return LearningCandidateSchema.parse(input);
}
