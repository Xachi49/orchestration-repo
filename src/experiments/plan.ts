import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ExperimentAssumptionBindingSchema,
  ExperimentBudgetEnvelopeSchema,
} from "./experiment.js";
import {
  ExperimentHypothesisSchema,
  ExperimentMeasurementSchema,
} from "./hypothesis.js";
import { ExperimentError } from "./errors.js";

export const INITIAL_EXPERIMENT_PLAN_VERSION = 1;

export const ExperimentStoppingRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    kind: z.enum([
      "MAXIMUM_DURATION",
      "MAXIMUM_OBSERVATIONS",
      "BUDGET_EXHAUSTED",
      "SAFETY_THRESHOLD",
      "MINIMUM_EVIDENCE",
      "FUTILITY",
      "AUTHORITY_DRIFT",
    ]),
    threshold: z.union([z.number().finite(), z.string().min(1)]),
    description: z.string().min(1),
  })
  .strict();

export type ExperimentStoppingRule = z.infer<
  typeof ExperimentStoppingRuleSchema
>;

export const ExperimentPlanSchema = z
  .object({
    experimentId: z.string().min(1),
    experimentVersion: z.number().int().positive(),
    experimentPlanVersion: z.number().int().positive(),
    experimentPlanHash: z.string().min(1),
    hypotheses: z.array(ExperimentHypothesisSchema).min(1),
    measurements: z.array(ExperimentMeasurementSchema).min(1),
    procedure: z.string().min(1).max(8000),
    requiredCapabilities: z.array(z.string().min(1)).default([]),
    requestedActions: z.array(z.string().min(1)).default([]),
    resourceEstimate: ExperimentBudgetEnvelopeSchema,
    riskAssessment: z.string().min(1),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    stoppingRules: z.array(ExperimentStoppingRuleSchema).min(1),
    successRules: z.array(z.string().min(1)).min(1),
    inconclusiveRules: z.array(z.string().min(1)).min(1),
    evidenceRequirements: z.array(z.string().min(1)).min(1),
    assumptionBindings: z.array(ExperimentAssumptionBindingSchema).min(1),
    assignmentMethod: z
      .enum(["NONE", "DETERMINISTIC", "RANDOMIZED"])
      .default("NONE"),
    randomSeed: z.string().min(1).optional(),
    unitOfAssignment: z.string().min(1).optional(),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    designModelId: z.string().min(1),
    designModelVersion: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ExperimentPlan = z.infer<typeof ExperimentPlanSchema>;

export function experimentPlanCanonicalPayload(
  plan: Omit<ExperimentPlan, "experimentPlanHash">,
): Record<string, unknown> {
  return {
    assignmentMethod: plan.assignmentMethod,
    assumptionBindings: plan.assumptionBindings,
    capabilitySetFingerprint: plan.capabilitySetFingerprint,
    createdAt: plan.createdAt,
    designModelId: plan.designModelId,
    designModelVersion: plan.designModelVersion,
    evidenceRequirements: [...plan.evidenceRequirements].sort(),
    experimentId: plan.experimentId,
    experimentPlanVersion: plan.experimentPlanVersion,
    experimentVersion: plan.experimentVersion,
    hypotheses: plan.hypotheses,
    inconclusiveRules: [...plan.inconclusiveRules].sort(),
    measurements: plan.measurements,
    policyBundleFingerprint: plan.policyBundleFingerprint,
    procedure: plan.procedure,
    projectConfigurationFingerprint: plan.projectConfigurationFingerprint,
    randomSeed: plan.randomSeed ?? null,
    requestedActions: [...plan.requestedActions].sort(),
    requiredCapabilities: [...plan.requiredCapabilities].sort(),
    resourceEstimate: plan.resourceEstimate,
    riskAssessment: plan.riskAssessment,
    riskClass: plan.riskClass,
    stoppingRules: plan.stoppingRules,
    successRules: [...plan.successRules].sort(),
    unitOfAssignment: plan.unitOfAssignment ?? null,
  };
}

export function computeExperimentPlanHash(
  plan: Omit<ExperimentPlan, "experimentPlanHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(experimentPlanCanonicalPayload(plan)), "utf8")
    .digest("hex");
}

export function withExperimentPlanHash(
  plan: Omit<ExperimentPlan, "experimentPlanHash">,
): ExperimentPlan {
  if (plan.hypotheses.length === 0) {
    throw new ExperimentError(
      "EXPERIMENT_PLAN_INVALID",
      "Experiment plan requires at least one hypothesis",
    );
  }
  const hash = computeExperimentPlanHash(plan);
  return ExperimentPlanSchema.parse({
    ...plan,
    experimentPlanHash: hash,
  });
}
