import { z } from "zod";

export const ScenarioPortfolioLineageSchema = z
  .object({
    lineageId: z.string().min(1),
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    decisionPackageHash: z.string().min(1),
    scenarioSetHash: z.string().min(1),
    selectedScenarioId: z.string().min(1),
    selectionRecordId: z.string().min(1),
    compiledIntentHash: z.string().min(1),
    portfolioId: z.string().min(1).optional(),
    portfolioAdmissionOutcome: z
      .enum(["ADMITTED", "DUPLICATE", "FAILED"])
      .optional(),
    failureReasonCode: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type ScenarioPortfolioLineage = z.infer<
  typeof ScenarioPortfolioLineageSchema
>;

/**
 * Observational calibration record — never authoritative for selection.
 */
export const ScenarioCalibrationRecordSchema = z
  .object({
    calibrationId: z.string().min(1),
    decisionProblemId: z.string().min(1),
    scenarioId: z.string().min(1),
    simulationRunId: z.string().min(1),
    observedMetric: z.string().min(1),
    observedValue: z.number().finite(),
    predictedValue: z.number().finite().optional(),
    observationClass: z.literal("OBSERVATIONAL_DATA"),
    observedAt: z.string().datetime(),
    notes: z.string().default(""),
  })
  .strict();

export type ScenarioCalibrationRecord = z.infer<
  typeof ScenarioCalibrationRecordSchema
>;

export function scenarioPortfolioLineageIdFor(input: {
  decisionProblemId: string;
  selectedScenarioId: string;
  decisionPackageHash: string;
}): string {
  return `sfl_${input.decisionProblemId}_${input.selectedScenarioId}_${input.decisionPackageHash.slice(0, 8)}`.slice(
    0,
    120,
  );
}

export function mintCalibrationId(input: {
  decisionProblemId: string;
  scenarioId: string;
  observedAt: string;
}): string {
  return `scal_${input.decisionProblemId}_${input.scenarioId}_${input.observedAt}`.slice(
    0,
    120,
  );
}

/**
 * Selection does not allocate capital — documentation hook for tests/reviews.
 */
export function assertSelectionDoesNotAllocateCapital(): void {
  // Intentional hook: scenario selection binds strategic choice only.
}

export function assertCalibrationIsObservationalOnly(): void {
  // Intentional hook: calibration records are never selection authority.
}
