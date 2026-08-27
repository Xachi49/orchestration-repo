import { z } from "zod";

export const QualitativeClassSchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "UNKNOWN",
]);
export type QualitativeClass = z.infer<typeof QualitativeClassSchema>;

export const ValueOfInformationResultSchema = z
  .object({
    assumptionId: z.string().min(1),
    informationPriority: QualitativeClassSchema,
    expectedDecisionImpact: QualitativeClassSchema,
    costToLearn: QualitativeClassSchema,
    timeToLearn: QualitativeClassSchema,
    riskToLearn: QualitativeClassSchema,
    recommended: z.boolean(),
    rationale: z.string().min(1),
    /** Explicit: no fabricated numeric precision. */
    precisionDisclaimer: z.literal(
      "Qualitative classes only — no invented probabilities",
    ),
  })
  .strict();

export type ValueOfInformationResult = z.infer<
  typeof ValueOfInformationResultSchema
>;

export const ActiveLearningCandidateSchema = z
  .object({
    assumptionId: z.string().min(1),
    decisionProblemId: z.string().min(1),
    sensitivityRank: z.number().int().positive(),
    decisionFlipRisk: QualitativeClassSchema,
    evidenceGap: QualitativeClassSchema,
    candidateExperimentIds: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ActiveLearningCandidate = z.infer<
  typeof ActiveLearningCandidateSchema
>;

/**
 * Deterministic VOI ranking — qualitative only when probabilities unknown.
 */
export function analyzeValueOfInformation(input: {
  assumptionId: string;
  assumptionMateriality: QualitativeClass;
  sensitivityRank: number;
  experimentCostClass: QualitativeClass;
  timeClass: QualitativeClass;
  riskClass: QualitativeClass;
  evidenceQualityExpected: QualitativeClass;
}): ValueOfInformationResult {
  const impact =
    input.assumptionMateriality === "HIGH" || input.sensitivityRank <= 2
      ? "HIGH"
      : input.assumptionMateriality === "MEDIUM"
        ? "MEDIUM"
        : input.assumptionMateriality === "UNKNOWN"
          ? "UNKNOWN"
          : "LOW";

  const recommended =
    impact === "HIGH" &&
    input.experimentCostClass !== "HIGH" &&
    input.riskClass !== "HIGH" &&
    input.evidenceQualityExpected !== "UNKNOWN";

  return ValueOfInformationResultSchema.parse({
    assumptionId: input.assumptionId,
    informationPriority: impact,
    expectedDecisionImpact: impact,
    costToLearn: input.experimentCostClass,
    timeToLearn: input.timeClass,
    riskToLearn: input.riskClass,
    recommended,
    rationale: recommended
      ? "Material assumption with bounded learning cost/risk"
      : "Insufficient expected decision impact or elevated cost/risk/unknown quality",
    precisionDisclaimer:
      "Qualitative classes only — no invented probabilities",
  });
}

export function rankActiveLearningCandidates(
  candidates: readonly ActiveLearningCandidate[],
): ActiveLearningCandidate[] {
  return [...candidates].sort((a, b) => {
    const rank = a.sensitivityRank - b.sensitivityRank;
    if (rank !== 0) return rank;
    const flipOrder = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 } as const;
    return flipOrder[a.decisionFlipRisk] - flipOrder[b.decisionFlipRisk];
  });
}
