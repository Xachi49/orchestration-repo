import { createHash } from "node:crypto";
import { z } from "zod";
import { CausalError } from "./errors.js";
import {
  assertCompatibleUnits,
  QuantityUnitSchema,
  type QuantityUnit,
} from "./variables.js";

export const UncertaintyRepresentationSchema = z
  .object({
    kind: z.enum([
      "STANDARD_ERROR",
      "INTERVAL",
      "BOOTSTRAP_INTERVAL",
      "BOUNDS",
      "UNKNOWN",
    ]),
    standardError: z.number().finite().nonnegative().optional(),
    lower: z.number().finite().optional(),
    upper: z.number().finite().optional(),
    /** Only when mathematically justified by estimator assumptions. */
    confidenceLevel: z.number().gt(0).lt(1).optional(),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export type UncertaintyRepresentation = z.infer<
  typeof UncertaintyRepresentationSchema
>;

export const CausalEstimateSchema = z
  .object({
    causalEstimateId: z.string().min(1),
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    intervention: z.string().min(1),
    outcome: z.string().min(1),
    graphHash: z.string().min(1),
    identificationAnalysisId: z.string().min(1),
    identificationFingerprint: z.string().min(1),
    identificationStrategy: z.string().min(1),
    evidenceBundleId: z.string().min(1),
    evidenceBundleHash: z.string().min(1),
    outcomeVerificationIds: z.array(z.string().min(1)).default([]),
    assignmentFingerprint: z.string().min(1),
    measurementDefinition: z.string().min(1),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    estimatorId: z.string().min(1),
    estimatorVersion: z.string().min(1),
    pointEstimate: z.number().finite(),
    unit: QuantityUnitSchema,
    treatmentMean: z.number().finite(),
    controlMean: z.number().finite(),
    treatmentSampleCount: z.number().int().positive(),
    controlSampleCount: z.number().int().positive(),
    uncertainty: UncertaintyRepresentationSchema,
    estimatorAssumptions: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
    evidenceRefIds: z.array(z.string().min(1)).default([]),
    estimateHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalEstimate = z.infer<typeof CausalEstimateSchema>;

export interface CausalEffectEstimatorInput {
  treatmentMeasurements: readonly number[];
  controlMeasurements: readonly number[];
  unit: QuantityUnit;
  evidenceRefIds: readonly string[];
  createdAt: string;
  causalQuestionId: string;
  causalQuestionVersion: number;
  intervention: string;
  outcome: string;
  graphHash: string;
  identificationAnalysisId: string;
  identificationFingerprint: string;
  identificationStrategy: string;
  evidenceBundleId: string;
  evidenceBundleHash: string;
  outcomeVerificationIds: readonly string[];
  assignmentFingerprint: string;
  measurementDefinition: string;
  populationScope: string;
  environmentScope: string;
}

export interface CausalEffectEstimator {
  readonly estimatorId: string;
  readonly estimatorVersion: string;
  estimate(input: CausalEffectEstimatorInput): CausalEstimate;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) {
    throw new CausalError(
      "UNSUPPORTED_ESTIMATOR",
      "Cannot estimate with empty measurements",
    );
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sampleVariance(values: readonly number[], m: number): number {
  if (values.length < 2) return 0;
  return (
    values.reduce((acc, v) => acc + (v - m) * (v - m), 0) /
    (values.length - 1)
  );
}

/**
 * Difference-in-means for valid randomized experiments.
 * Does not fabricate p-values. SE provided when samples support it.
 * Estimate identity binds full evidence provenance — no mutable repointing.
 */
export class DifferenceInMeansEstimator implements CausalEffectEstimator {
  readonly estimatorId = "difference_in_means";
  readonly estimatorVersion = "difference_in_means_v1";

  estimate(input: CausalEffectEstimatorInput): CausalEstimate {
    if (
      input.treatmentMeasurements.length === 0 ||
      input.controlMeasurements.length === 0
    ) {
      throw new CausalError(
        "UNSUPPORTED_ESTIMATOR",
        "DifferenceInMeans requires non-empty treatment and control samples",
      );
    }
    const treatmentMean = mean(input.treatmentMeasurements);
    const controlMean = mean(input.controlMeasurements);
    const pointEstimate = treatmentMean - controlMean;
    const nT = input.treatmentMeasurements.length;
    const nC = input.controlMeasurements.length;
    const varT = sampleVariance(input.treatmentMeasurements, treatmentMean);
    const varC = sampleVariance(input.controlMeasurements, controlMean);
    const se =
      nT >= 2 && nC >= 2 ? Math.sqrt(varT / nT + varC / nC) : undefined;
    const uncertainty: UncertaintyRepresentation =
      se !== undefined
        ? {
            kind: "STANDARD_ERROR",
            standardError: se,
            notes: [
              "SE under independent samples assumption; no confidence interval claimed",
            ],
          }
        : {
            kind: "UNKNOWN",
            notes: ["Insufficient sample to justify standard error"],
          };

    const bindingPayload = {
      causalQuestionId: input.causalQuestionId,
      causalQuestionVersion: input.causalQuestionVersion,
      intervention: input.intervention,
      outcome: input.outcome,
      graphHash: input.graphHash,
      identificationAnalysisId: input.identificationAnalysisId,
      identificationFingerprint: input.identificationFingerprint,
      identificationStrategy: input.identificationStrategy,
      evidenceBundleId: input.evidenceBundleId,
      evidenceBundleHash: input.evidenceBundleHash,
      outcomeVerificationIds: [...input.outcomeVerificationIds].sort(),
      assignmentFingerprint: input.assignmentFingerprint,
      measurementDefinition: input.measurementDefinition,
      unit: input.unit,
      populationScope: input.populationScope,
      environmentScope: input.environmentScope,
      estimatorId: this.estimatorId,
      estimatorVersion: this.estimatorVersion,
      pointEstimate,
      treatmentMean,
      controlMean,
      treatmentSampleCount: nT,
      controlSampleCount: nC,
      uncertainty,
    };
    const estimateHash = createHash("sha256")
      .update(JSON.stringify(bindingPayload), "utf8")
      .digest("hex");
    const causalEstimateId = `ce_${estimateHash.slice(0, 16)}`;
    return CausalEstimateSchema.parse({
      causalEstimateId,
      causalQuestionId: input.causalQuestionId,
      causalQuestionVersion: input.causalQuestionVersion,
      intervention: input.intervention,
      outcome: input.outcome,
      graphHash: input.graphHash,
      identificationAnalysisId: input.identificationAnalysisId,
      identificationFingerprint: input.identificationFingerprint,
      identificationStrategy: input.identificationStrategy,
      evidenceBundleId: input.evidenceBundleId,
      evidenceBundleHash: input.evidenceBundleHash,
      outcomeVerificationIds: [...input.outcomeVerificationIds],
      assignmentFingerprint: input.assignmentFingerprint,
      measurementDefinition: input.measurementDefinition,
      populationScope: input.populationScope,
      environmentScope: input.environmentScope,
      estimatorId: this.estimatorId,
      estimatorVersion: this.estimatorVersion,
      pointEstimate,
      unit: input.unit,
      treatmentMean,
      controlMean,
      treatmentSampleCount: nT,
      controlSampleCount: nC,
      uncertainty,
      estimatorAssumptions: [
        "independent samples",
        "same outcome unit",
        "randomized assignment already identified separately",
        "measurements resolved from authoritative ExperimentEvidenceBundle",
      ],
      limitations: [
        "Does not adjust for covariates",
        "Does not fabricate p-values",
        "CALLER-SUPPLIED SAMPLE VALUES != CAUSAL ESTIMATION AUTHORITY",
      ],
      evidenceRefIds: [...input.evidenceRefIds],
      estimateHash,
      createdAt: input.createdAt,
    });
  }
}

export function assertSameUnitForPooling(
  a: QuantityUnit,
  b: QuantityUnit,
): void {
  assertCompatibleUnits(a, b, "pool causal estimates");
}

export function unsupportedEstimator(name: string): never {
  throw new CausalError(
    "UNSUPPORTED_ESTIMATOR",
    `Estimator ${name} is not implemented; prefer UNSUPPORTED over fake sophistication`,
    { name },
  );
}
