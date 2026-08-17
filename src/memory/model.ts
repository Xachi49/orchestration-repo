import { z } from "zod";
import { LearningCandidateTypeSchema } from "../domain/memory/candidate.js";
import { ScopeClassSchema, RiskClassSchema } from "../domain/memory/applicability.js";
import type { HistoricalRunRecord } from "../domain/memory/historical-run.js";
import type { LearningCandidate } from "../domain/memory/candidate.js";

export const LearningModelSuggestionSchema = z
  .object({
    statement: z.string().min(1),
    candidateType: LearningCandidateTypeSchema,
    suggestedScopeClass: ScopeClassSchema.optional(),
    suggestedRiskClass: RiskClassSchema.optional(),
    possibleContradictionThemes: z.array(z.string()).default([]),
    /** Advisory only — never authoritative for promotion. */
    suggestedAction: z
      .enum(["NONE", "REVIEW", "PROMOTE"])
      .default("NONE"),
    claimedActionTypes: z.array(z.string()).optional(),
    claimedCapabilityIds: z.array(z.string()).optional(),
    claimedFindingIds: z.array(z.string()).optional(),
    claimedCriterionIds: z.array(z.string()).optional(),
    claimedCriterionVerdicts: z.array(z.string()).optional(),
    claimedVerificationMethods: z.array(z.string()).optional(),
    containmentReason: z.string().min(1).optional(),
    resourceObservation: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();

export type LearningModelSuggestion = z.infer<
  typeof LearningModelSuggestionSchema
>;

export const LearningModelOutputSchema = z
  .object({
    suggestions: z.array(LearningModelSuggestionSchema).default([]),
  })
  .strict();

export type LearningModelOutput = z.infer<typeof LearningModelOutputSchema>;

export interface LearningModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LearningModelInput {
  historicalRun: HistoricalRunRecord;
  deterministicCandidates: readonly LearningCandidate[];
}

export interface LearningModel {
  readonly provider: string;
  readonly modelId: string;
  assess(input: LearningModelInput): Promise<{
    value: LearningModelOutput;
    usage?: LearningModelTokenUsage;
  }>;
}

export function parseLearningModelOutput(input: unknown): LearningModelOutput {
  return LearningModelOutputSchema.parse(input);
}
