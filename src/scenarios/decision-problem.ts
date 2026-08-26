import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canTransitionDecisionProblem,
  DecisionProblemStateSchema,
} from "./decision-state.js";
import { ScenarioError } from "./errors.js";

export const INITIAL_DECISION_PROBLEM_VERSION = 1;

export const DecisionCriterionSchema = z
  .object({
    criterionId: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum([
      "EXPECTED_VALUE",
      "MAXIMUM_DOWNSIDE",
      "CAPITAL_EFFICIENCY",
      "TIME_TO_OUTCOME",
      "REVERSIBILITY",
      "GOAL_COVERAGE",
      "STRATEGIC_OPTIONALITY",
      "RISK",
    ]),
    weight: z.number().min(0).max(1),
    higherIsBetter: z.boolean(),
    hardConstraint: z
      .object({
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type DecisionCriterion = z.infer<typeof DecisionCriterionSchema>;

export const DecisionProblemSchema = z
  .object({
    decisionProblemId: z.string().min(1),
    decisionProblemVersion: z.number().int().positive(),
    primaryProjectId: z.string().min(1),
    question: z.string().min(1).max(4000),
    strategicObjective: z.string().min(1).max(4000),
    decisionCriteria: z.array(DecisionCriterionSchema).min(1),
    timeHorizon: z.string().min(1).max(200),
    constraints: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    allowedProjectIds: z.array(z.string().min(1)).min(1),
    allowedEnvironments: z.array(z.string().min(1)).min(1),
    allowedRepositoryIdentities: z.array(z.string()).default([]),
    riskTolerance: z.enum(["LOW", "MEDIUM", "HIGH"]),
    decisionDeadline: z.string().datetime().optional(),
    createdBy: z.string().min(1),
    status: DecisionProblemStateSchema,
    scenarioSetVersion: z.number().int().positive().optional(),
    scenarioSetHash: z.string().min(1).optional(),
    decisionPackageHash: z.string().min(1).optional(),
    truthSnapshotFingerprint: z.string().min(1).optional(),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    maximumScenarioCount: z.number().int().positive().max(50).default(12),
    maximumSimulationRuns: z.number().int().positive().max(200).default(50),
    maximumModelCalls: z.number().int().nonnegative().default(32),
    maximumSensitivityEvaluations: z
      .number()
      .int()
      .nonnegative()
      .default(64),
    failureReasonCode: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1).default(1),
    correlationId: z.string().min(1),
    traceId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    contentFingerprint: z.string().min(1),
  })
  .strict();

export type DecisionProblem = z.infer<typeof DecisionProblemSchema>;

export function parseDecisionProblem(input: unknown): DecisionProblem {
  return DecisionProblemSchema.parse(input);
}

export function assertDecisionTransition(
  from: DecisionProblem["status"],
  to: DecisionProblem["status"],
): void {
  if (!canTransitionDecisionProblem(from, to)) {
    throw new ScenarioError(
      "INVALID_DECISION_TRANSITION",
      `Illegal decision transition ${from} → ${to}`,
      { from, to },
    );
  }
}

export function validateDecisionCriteria(
  criteria: readonly DecisionCriterion[],
): void {
  const ids = new Set<string>();
  let weightSum = 0;
  for (const c of criteria) {
    if (ids.has(c.criterionId)) {
      throw new ScenarioError(
        "DECISION_PACKAGE_INVALID",
        `Duplicate criterion id ${c.criterionId}`,
      );
    }
    ids.add(c.criterionId);
    weightSum += c.weight;
  }
  if (Math.abs(weightSum - 1) > 1e-9 && weightSum > 0) {
    // Allow non-normalized weights; comparison service normalizes.
  }
}

export function decisionProblemContentFingerprint(input: {
  question: string;
  strategicObjective: string;
  decisionCriteria: readonly DecisionCriterion[];
  primaryProjectId: string;
  allowedProjectIds: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        allowedProjectIds: [...input.allowedProjectIds].sort(),
        decisionCriteria: input.decisionCriteria,
        primaryProjectId: input.primaryProjectId,
        question: input.question,
        strategicObjective: input.strategicObjective,
      }),
      "utf8",
    )
    .digest("hex");
}

export function decisionProblemIdempotencyKey(input: {
  primaryProjectId: string;
  contentFingerprint: string;
  createdBy: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export function mintDecisionProblemId(input: {
  primaryProjectId: string;
  contentFingerprint: string;
  admittedAt: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 24);
  return `sdp_${digest}`;
}
