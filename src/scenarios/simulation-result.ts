import { createHash } from "node:crypto";
import { z } from "zod";
import { QuantityUnitSchema, QuantifiedValueSchema } from "./assumptions.js";

export const SIMULATION_ENGINE_VERSION = "fake-scenario-sim-1.0.0";

export const UncertaintyRepresentationSchema = z
  .object({
    estimate: QuantifiedValueSchema.optional(),
    lowerBound: QuantifiedValueSchema.optional(),
    upperBound: QuantifiedValueSchema.optional(),
    assumptionSensitivity: z.enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]).default(
      "UNKNOWN",
    ),
    evidenceQuality: z.enum(["HIGH", "MEDIUM", "LOW", "UNKNOWN"]).default(
      "UNKNOWN",
    ),
    modelUncertaintyClass: z
      .enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"])
      .default("UNKNOWN"),
    /** Naked confidence without provenance is forbidden — use UNKNOWN. */
    confidenceWithoutProvenance: z.literal("UNKNOWN").default("UNKNOWN"),
  })
  .strict();

export type UncertaintyRepresentation = z.infer<
  typeof UncertaintyRepresentationSchema
>;

export const ScenarioSimulationResultSchema = z
  .object({
    simulationRunId: z.string().min(1),
    scenarioId: z.string().min(1),
    scenarioSetId: z.string().min(1),
    scenarioSetVersion: z.number().int().positive(),
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    inputFingerprint: z.string().min(1),
    assumptionSetHash: z.string().min(1),
    truthSnapshotFingerprint: z.string().min(1),
    engineVersion: z.string().min(1),
    configurationFingerprint: z.string().min(1),
    randomSeed: z.string().min(1),
    expectedOutcomes: z.array(z.string()).default([]),
    riskMetrics: z
      .array(
        z
          .object({
            name: z.string().min(1),
            quantity: QuantifiedValueSchema,
          })
          .strict(),
      )
      .default([]),
    resourceRequirements: z
      .array(
        z
          .object({
            name: z.string().min(1),
            quantity: QuantifiedValueSchema,
          })
          .strict(),
      )
      .default([]),
    estimatedPortfolioEffects: z.array(z.string()).default([]),
    goalEffects: z.array(z.string()).default([]),
    distributionSummary: z.string().default(""),
    uncertainty: UncertaintyRepresentationSchema,
    sensitivityCandidates: z.array(z.string()).default([]),
    limitations: z.array(z.string()).default([]),
    criterionScores: z.record(z.string(), z.number().finite()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ScenarioSimulationResult = z.infer<
  typeof ScenarioSimulationResultSchema
>;

export function simulationInputFingerprint(input: {
  decisionProblemVersion: number;
  scenarioId: string;
  assumptionSetHash: string;
  truthSnapshotFingerprint: string;
  engineVersion: string;
  configurationFingerprint: string;
  randomSeed: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintSimulationRunId(input: {
  scenarioId: string;
  inputFingerprint: string;
}): string {
  return `sim_${input.scenarioId}_${input.inputFingerprint.slice(0, 16)}`.slice(
    0,
    120,
  );
}

export function simulationConfigurationFingerprint(input: {
  maximumScenarioCount: number;
  maximumSimulationRuns: number;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

/** All simulation quantities are estimates — never verified facts. */
export const SIMULATION_RESULT_CAVEAT =
  "Forecasts are estimates, not facts. ScenarioSimulationResult values are MODEL_ESTIMATE class.";

export { QuantityUnitSchema, QuantifiedValueSchema };
