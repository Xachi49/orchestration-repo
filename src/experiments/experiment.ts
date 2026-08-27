import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExperimentHypothesisSchema,
  ExperimentMeasurementSchema,
  QuantityUnitSchema,
} from "./hypothesis.js";
import {
  canTransitionExperiment,
  ExperimentStateSchema,
} from "./experiment-state-schema.js";
import { ExperimentError } from "./errors.js";

export const INITIAL_EXPERIMENT_VERSION = 1;

export const ExperimentAssumptionBindingSchema = z
  .object({
    experimentId: z.string().min(1),
    hypothesisId: z.string().min(1),
    assumptionId: z.string().min(1),
    scenarioSetId: z.string().min(1).optional(),
    scenarioSetVersion: z.number().int().positive().optional(),
    priorAssumptionValue: z.number().finite().optional(),
    priorUnit: QuantityUnitSchema.optional(),
    priorLowerBound: z.number().finite().optional(),
    priorUpperBound: z.number().finite().optional(),
    expectedInformationContribution: z.enum([
      "LOW",
      "MEDIUM",
      "HIGH",
      "UNKNOWN",
    ]),
  })
  .strict();

export type ExperimentAssumptionBinding = z.infer<
  typeof ExperimentAssumptionBindingSchema
>;

export const ExperimentBudgetEnvelopeSchema = z
  .object({
    maximumActions: z.number().int().positive().max(1000),
    maximumDurationHours: z.number().positive().max(8760),
    maximumModelCalls: z.number().int().nonnegative(),
    maximumTotalTokens: z.number().int().nonnegative(),
    maximumSampleSize: z.number().int().positive().max(1_000_000),
    maximumEstimatedCost: z.number().nonnegative(),
    maximumExternalSideEffects: z.number().int().nonnegative().max(100),
  })
  .strict();

export type ExperimentBudgetEnvelope = z.infer<
  typeof ExperimentBudgetEnvelopeSchema
>;

export const GovernedExperimentSchema = z
  .object({
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    projectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    sourceDecisionProblemId: z.string().min(1).optional(),
    sourceDecisionProblemVersion: z.number().int().positive().optional(),
    sourceScenarioSetId: z.string().min(1).optional(),
    sourceScenarioSetVersion: z.number().int().positive().optional(),
    sourceAssumptionIds: z.array(z.string().min(1)).default([]),
    /** Canonical hash of the Phase 16 AssumptionSet bound at admission (immutable). */
    sourceAssumptionSetHash: z.string().min(1).optional(),
    sourcePortfolioId: z.string().min(1).optional(),
    sourcePortfolioVersion: z.number().int().positive().optional(),
    objective: z.string().min(1).max(4000),
    constraints: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    budgetEnvelope: ExperimentBudgetEnvelopeSchema,
    hypotheses: z.array(ExperimentHypothesisSchema).default([]),
    measurements: z.array(ExperimentMeasurementSchema).default([]),
    assumptionBindings: z.array(ExperimentAssumptionBindingSchema).default([]),
    status: ExperimentStateSchema,
    experimentPlanVersion: z.number().int().positive().optional(),
    experimentPlanHash: z.string().min(1).optional(),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    truthSnapshotFingerprint: z.string().min(1).optional(),
    failureReasonCode: z.string().min(1).optional(),
    createdBy: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1).default(1),
    correlationId: z.string().min(1),
    traceId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    contentFingerprint: z.string().min(1),
  })
  .strict();

export type GovernedExperiment = z.infer<typeof GovernedExperimentSchema>;

export function parseGovernedExperiment(input: unknown): GovernedExperiment {
  return GovernedExperimentSchema.parse(input);
}

export function assertExperimentTransition(
  from: GovernedExperiment["status"],
  to: GovernedExperiment["status"],
): void {
  if (!canTransitionExperiment(from, to)) {
    throw new ExperimentError(
      "INVALID_EXPERIMENT_TRANSITION",
      `Illegal experiment transition ${from} → ${to}`,
      { from, to },
    );
  }
}

export function experimentContentFingerprint(input: {
  projectId: string;
  objective: string;
  sourceAssumptionIds: readonly string[];
  sourceDecisionProblemId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        objective: input.objective,
        projectId: input.projectId,
        sourceAssumptionIds: [...input.sourceAssumptionIds].sort(),
        sourceDecisionProblemId: input.sourceDecisionProblemId ?? null,
      }),
      "utf8",
    )
    .digest("hex");
}

export function experimentIdempotencyKey(input: {
  projectId: string;
  contentFingerprint: string;
  createdBy: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintExperimentId(input: {
  projectId: string;
  contentFingerprint: string;
  admittedAt: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `exp_${digest}`;
}
