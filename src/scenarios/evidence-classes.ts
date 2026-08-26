import { z } from "zod";

/**
 * Evidence authority classes for strategic scenario intelligence.
 * Never flatten known / observed / assumed / estimated into one blob.
 */
export const SCENARIO_EVIDENCE_AUTHORITY_CLASSES = [
  "CURRENT_CONTROL_PLANE_TRUTH",
  "VERIFIED_PROGRAM_OUTCOME",
  "VERIFIED_PORTFOLIO_OUTCOME",
  "OBSERVATIONAL_DATA",
  "GOVERNED_PRECEDENT",
  "EXTERNAL_REFERENCE_DATA",
  "ASSUMPTION",
  "MODEL_ESTIMATE",
] as const;

export const ScenarioEvidenceAuthorityClassSchema = z.enum(
  SCENARIO_EVIDENCE_AUTHORITY_CLASSES,
);
export type ScenarioEvidenceAuthorityClass = z.infer<
  typeof ScenarioEvidenceAuthorityClassSchema
>;

export const LabeledScenarioEvidenceSchema = z
  .object({
    authorityClass: ScenarioEvidenceAuthorityClassSchema,
    label: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

export type LabeledScenarioEvidence = z.infer<
  typeof LabeledScenarioEvidenceSchema
>;

export function labelScenarioEvidence(
  authorityClass: ScenarioEvidenceAuthorityClass,
  label: string,
  payload: unknown,
): LabeledScenarioEvidence {
  return { authorityClass, label, payload };
}

/** Doctrine hooks for tests / reviews. */
export const SCENARIO_DOCTRINE = {
  currentTruthNotAssumption: "CurrentTruth != Assumption",
  assumptionNotEvidence: "Assumption != Evidence",
  scenarioNotPrediction: "Scenario != Prediction",
  forecastNotVerifiedOutcome: "Forecast != VerifiedOutcome",
  expectedValueNotAuthorization: "ExpectedValue != Authorization",
  modelProbabilityNotGroundTruth: "ModelProbability != GroundTruthProbability",
  recommendationNotSelection: "ScenarioRecommendation != HumanSelection",
  selectionNotPortfolioAuthorization:
    "HumanSelection != PortfolioAuthorization",
} as const;
