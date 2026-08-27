import { z } from "zod";
import { ExperimentError } from "./errors.js";

/** Reuse Phase 15/16 dimensional units — no mixing. */
export const QUANTITY_UNITS = [
  "USD",
  "TOKENS",
  "PERCENT",
  "RATIO",
  "DAYS",
  "HOURS",
  "COUNT",
  "SCORE",
  "DIMENSIONLESS",
] as const;

export const QuantityUnitSchema = z.enum(QUANTITY_UNITS);
export type QuantityUnit = z.infer<typeof QuantityUnitSchema>;

export function assertCompatibleUnits(
  a: QuantityUnit,
  b: QuantityUnit,
  operation: string,
): void {
  if (a !== b) {
    throw new ExperimentError(
      "UNIT_MIXING_REJECTED",
      `Cannot ${operation} incompatible units ${a} + ${b}`,
      { a, b, operation },
    );
  }
}

export const ExperimentHypothesisSchema = z
  .object({
    hypothesisId: z.string().min(1),
    statement: z.string().min(1).max(4000),
    nullHypothesis: z.string().min(1).max(2000),
    alternativeHypothesis: z.string().min(1).max(2000),
    sourceAssumptionId: z.string().min(1),
    expectedDirection: z.enum(["INCREASE", "DECREASE", "NO_CHANGE", "UNKNOWN"]),
    materiality: z.enum(["LOW", "MEDIUM", "HIGH"]),
    decisionImpact: z.enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]),
    successCriterion: z.string().min(1).max(2000),
    failureCriterion: z.string().min(1).max(2000),
    inconclusiveCriterion: z.string().min(1).max(2000),
  })
  .strict();

export type ExperimentHypothesis = z.infer<typeof ExperimentHypothesisSchema>;

export const ExperimentMeasurementSchema = z
  .object({
    measurementId: z.string().min(1),
    name: z.string().min(1),
    unit: QuantityUnitSchema,
    source: z.string().min(1),
    collectionMethod: z.string().min(1),
    baseline: z.number().finite().optional(),
    target: z.number().finite().optional(),
    minimumDetectableEffect: z.number().finite().optional(),
    measurementWindow: z.string().min(1),
    samplingFrequency: z.string().min(1),
    evidenceClass: z.enum([
      "OBSERVATIONAL_DATA",
      "VERIFIED_PROGRAM_OUTCOME",
      "EXTERNAL_REFERENCE_DATA",
      "ASSUMPTION",
      "MODEL_ESTIMATE",
    ]),
    requiredForDecision: z.boolean(),
    qualityRequirements: z.array(z.string()).default([]),
  })
  .strict();

export type ExperimentMeasurement = z.infer<typeof ExperimentMeasurementSchema>;

export function validateHypothesisMeasurability(
  hypothesis: ExperimentHypothesis,
): void {
  if (
    !hypothesis.successCriterion.trim() ||
    !hypothesis.failureCriterion.trim() ||
    !hypothesis.inconclusiveCriterion.trim()
  ) {
    throw new ExperimentError(
      "HYPOTHESIS_INVALID",
      `Hypothesis ${hypothesis.hypothesisId} requires measurable decision rules`,
    );
  }
}

export function validateMeasurement(measurement: ExperimentMeasurement): void {
  ExperimentMeasurementSchema.parse(measurement);
  if (
    measurement.baseline !== undefined &&
    measurement.target !== undefined
  ) {
    // Same unit — schema already enforces single unit per measurement.
  }
}
