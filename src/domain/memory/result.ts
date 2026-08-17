import { z } from "zod";
import { LearningCandidateTypeSchema } from "./candidate.js";
import { PrecedentApplicabilitySchema } from "./applicability.js";
import { PrecedentTrustClassSchema } from "./precedent.js";
import { HistoricalOutcomeSchema } from "./historical-run.js";
import { MemoryQualityFindingSchema } from "./finding.js";
import {
  CandidateOriginSchema,
  LearningClaimSchema,
} from "./claim.js";

export const RetrievedPrecedentContextSchema = z
  .object({
    precedentId: z.string().min(1),
    precedentVersion: z.number().int().positive(),
    precedentHash: z.string().min(1),
    origin: CandidateOriginSchema,
    claim: LearningClaimSchema,
    statement: z.string().min(1),
    candidateType: LearningCandidateTypeSchema,
    applicability: PrecedentApplicabilitySchema,
    trustClass: PrecedentTrustClassSchema,
    sourceOutcome: HistoricalOutcomeSchema,
    relevanceScore: z.number(),
    relevanceMetadata: z.record(z.string(), z.unknown()).default({}),
    provenanceSummary: z
      .object({
        sourceHistoricalRunRecordId: z.string().min(1),
        runId: z.string().min(1),
        outcome: HistoricalOutcomeSchema,
        provenanceHash: z.string().min(1),
      })
      .strict(),
    contradictionWarning: z.string().optional(),
    label: z.literal("ADVISORY_PRECEDENT"),
  })
  .strict();

export type RetrievedPrecedentContext = z.infer<
  typeof RetrievedPrecedentContextSchema
>;

export const GovernedMemoryResultSchema = z
  .object({
    runId: z.string().min(1),
    historicalRunRecordId: z.string().min(1),
    candidateIds: z.array(z.string()),
    promotedPrecedentIds: z.array(z.string()),
    reviewRequiredCandidateIds: z.array(z.string()),
    contradictionIds: z.array(z.string()),
    qualityFindings: z.array(MemoryQualityFindingSchema),
    processedAt: z.string().datetime(),
  })
  .strict();

export type GovernedMemoryResult = z.infer<typeof GovernedMemoryResultSchema>;

export function parseRetrievedPrecedentContext(
  input: unknown,
): RetrievedPrecedentContext {
  return RetrievedPrecedentContextSchema.parse(input);
}

export function parseGovernedMemoryResult(
  input: unknown,
): GovernedMemoryResult {
  return GovernedMemoryResultSchema.parse(input);
}
