import { createHash } from "node:crypto";
import { z } from "zod";
import { ScenarioComparisonResultSchema } from "./comparison.js";
import {
  DecisionCriterionSchema,
  type DecisionCriterion,
} from "./decision-problem.js";
import { ScenarioError } from "./errors.js";
import { SensitivityAnalysisResultSchema } from "./sensitivity.js";
import { ScenarioSimulationResultSchema } from "./simulation-result.js";
import { ScenarioSetSchema } from "./scenario.js";

export const INITIAL_DECISION_PACKAGE_VERSION = 1;

/**
 * MODEL_SUGGESTED_WEIGHT ≠ AUTHORITATIVE_DECISION_WEIGHT.
 * Only DecisionProblem.decisionCriteria (or explicit governance config) may
 * appear here and drive comparison / recommendations.
 */
export const MODEL_WEIGHT_AUTHORITY = {
  modelSuggested: "MODEL_SUGGESTED_WEIGHT",
  authoritative: "AUTHORITATIVE_DECISION_WEIGHT",
} as const;

export const StrategicDecisionPackageSchema = z
  .object({
    decisionPackageId: z.string().min(1),
    decisionPackageVersion: z.number().int().positive(),
    decisionPackageHash: z.string().min(1),
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    scenarioSetId: z.string().min(1),
    scenarioSetVersion: z.number().int().positive(),
    scenarioSetHash: z.string().min(1),
    /** Frozen copy of DecisionProblem.decisionCriteria at package build time. */
    authoritativeDecisionCriteria: z.array(DecisionCriterionSchema).min(1),
    simulationResults: z.array(ScenarioSimulationResultSchema),
    comparison: ScenarioComparisonResultSchema,
    sensitivity: SensitivityAnalysisResultSchema,
    recommendedScenarioIds: z.array(z.string().min(1)),
    limitations: z.array(z.string()).default([]),
    requiredHumanDecisions: z
      .array(z.literal("STRATEGY_SELECTOR"))
      .default(["STRATEGY_SELECTOR"]),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    truthSnapshotFingerprint: z.string().min(1),
    assumptionSetHash: z.string().min(1),
    generationModelId: z.string().min(1),
    generationModelVersion: z.string().min(1),
    simulationEngineVersion: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type StrategicDecisionPackage = z.infer<
  typeof StrategicDecisionPackageSchema
>;

export function decisionPackageCanonicalPayload(
  pkg: Omit<StrategicDecisionPackage, "decisionPackageHash">,
): Record<string, unknown> {
  return {
    assumptionSetHash: pkg.assumptionSetHash,
    authoritativeDecisionCriteria: pkg.authoritativeDecisionCriteria,
    capabilitySetFingerprint: pkg.capabilitySetFingerprint,
    comparison: pkg.comparison,
    createdAt: pkg.createdAt,
    decisionPackageId: pkg.decisionPackageId,
    decisionPackageVersion: pkg.decisionPackageVersion,
    decisionProblemId: pkg.decisionProblemId,
    decisionProblemVersion: pkg.decisionProblemVersion,
    generationModelId: pkg.generationModelId,
    generationModelVersion: pkg.generationModelVersion,
    limitations: pkg.limitations,
    policyBundleFingerprint: pkg.policyBundleFingerprint,
    projectConfigurationFingerprint: pkg.projectConfigurationFingerprint,
    recommendedScenarioIds: [...pkg.recommendedScenarioIds].sort(),
    requiredHumanDecisions: pkg.requiredHumanDecisions,
    scenarioSetHash: pkg.scenarioSetHash,
    scenarioSetId: pkg.scenarioSetId,
    scenarioSetVersion: pkg.scenarioSetVersion,
    sensitivity: pkg.sensitivity,
    simulationEngineVersion: pkg.simulationEngineVersion,
    simulationResults: [...pkg.simulationResults].sort((a, b) =>
      a.scenarioId.localeCompare(b.scenarioId),
    ),
    truthSnapshotFingerprint: pkg.truthSnapshotFingerprint,
  };
}

export function computeDecisionPackageHash(
  pkg: Omit<StrategicDecisionPackage, "decisionPackageHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(decisionPackageCanonicalPayload(pkg)), "utf8")
    .digest("hex");
}

export function withDecisionPackageHash(
  pkg: Omit<StrategicDecisionPackage, "decisionPackageHash">,
): StrategicDecisionPackage {
  validateDecisionPackageStructure(pkg);
  const hash = computeDecisionPackageHash(pkg);
  return StrategicDecisionPackageSchema.parse({
    ...pkg,
    decisionPackageHash: hash,
  });
}

export function validateDecisionPackageStructure(
  pkg: Omit<StrategicDecisionPackage, "decisionPackageHash">,
): void {
  if (!pkg.requiredHumanDecisions.includes("STRATEGY_SELECTOR")) {
    throw new ScenarioError(
      "DECISION_PACKAGE_INVALID",
      "Decision package must require STRATEGY_SELECTOR human decision",
    );
  }
  if (pkg.authoritativeDecisionCriteria.length === 0) {
    throw new ScenarioError(
      "DECISION_PACKAGE_INVALID",
      "Authoritative decision criteria required",
    );
  }
  ScenarioSetSchema.pick({
    scenarioSetId: true,
    scenarioSetVersion: true,
    scenarioSetHash: true,
  }).parse({
    scenarioSetId: pkg.scenarioSetId,
    scenarioSetVersion: pkg.scenarioSetVersion,
    scenarioSetHash: pkg.scenarioSetHash,
  });
}

export function mintDecisionPackageId(input: {
  decisionProblemId: string;
  decisionPackageVersion: number;
}): string {
  return `sdpkg_${input.decisionProblemId}_${input.decisionPackageVersion}`.slice(
    0,
    120,
  );
}

export function assertAuthoritativeCriteriaMatchProblem(
  packageCriteria: readonly DecisionCriterion[],
  problemCriteria: readonly DecisionCriterion[],
): void {
  const a = JSON.stringify(packageCriteria);
  const b = JSON.stringify(problemCriteria);
  if (a !== b) {
    throw new ScenarioError(
      "DECISION_PACKAGE_INVALID",
      "Package authoritativeDecisionCriteria must match DecisionProblem.decisionCriteria",
    );
  }
}

export function assertModelWeightsNotUsedAsAuthority(): void {
  // Documentation / test hook: model-suggested weights never enter comparison.
  void MODEL_WEIGHT_AUTHORITY;
}
