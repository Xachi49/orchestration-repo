import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canTransitionCausalQuestion,
  type CausalQuestionState,
} from "./causal-state.js";
import { CausalError } from "./errors.js";
import { QuantityUnitSchema } from "./variables.js";

export const INITIAL_CAUSAL_QUESTION_VERSION = 1;

export const CausalAnalysisBudgetSchema = z
  .object({
    maximumGraphModelCalls: z.number().int().nonnegative(),
    maximumModelTokens: z.number().int().nonnegative(),
    maximumEstimators: z.number().int().nonnegative(),
    maximumSynthesisOperations: z.number().int().nonnegative(),
  })
  .strict();

export type CausalAnalysisBudget = z.infer<typeof CausalAnalysisBudgetSchema>;

export const CausalQuestionSchema = z
  .object({
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    projectIds: z.array(z.string().min(1)).min(1),
    sourceDecisionProblemIds: z.array(z.string().min(1)).default([]),
    sourceExperimentIds: z.array(z.string().min(1)).default([]),
    sourceAssumptionIds: z.array(z.string().min(1)).default([]),
    intervention: z.string().min(1).max(2000),
    outcome: z.string().min(1).max(2000),
    interventionUnit: QuantityUnitSchema,
    outcomeUnit: QuantityUnitSchema,
    targetPopulation: z.string().min(1).max(500),
    targetEnvironment: z.string().min(1).max(200),
    timeHorizon: z.string().min(1).max(200),
    candidateConfounders: z.array(z.string().min(1)).default([]),
    candidateMediators: z.array(z.string().min(1)).default([]),
    candidateModerators: z.array(z.string().min(1)).default([]),
    businessDecisionContext: z.string().min(1).max(4000),
    materialityThreshold: z.number().finite(),
    constraints: z.array(z.string()).default([]),
    nonGoals: z.array(z.string()).default([]),
    budgetEnvelope: CausalAnalysisBudgetSchema,
    createdBy: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: z.enum([
      "DRAFT",
      "ADMITTED",
      "GRAPH_PROPOSED",
      "IDENTIFICATION_ANALYSIS",
      "ESTIMATING",
      "SYNTHESIZING",
      "VALIDATING",
      "AWAITING_CAUSAL_REVIEW",
      "REVIEWED",
      "PROMOTED",
      "REJECTED",
      "INCONCLUSIVE",
      "STALE",
      "SUPERSEDED",
      "CANCELLED",
    ]),
    idempotencyKey: z.string().min(1),
    contentFingerprint: z.string().min(1),
    recordRevision: z.number().int().min(1),
    correlationId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .strict();

export type CausalQuestion = z.infer<typeof CausalQuestionSchema>;

export function parseCausalQuestion(input: unknown): CausalQuestion {
  return CausalQuestionSchema.parse(input);
}

export function assertCausalQuestionTransition(
  from: CausalQuestionState,
  to: CausalQuestionState,
): void {
  if (!canTransitionCausalQuestion(from, to)) {
    throw new CausalError(
      "INVALID_CAUSAL_TRANSITION",
      `Illegal causal question transition ${from} → ${to}`,
      { from, to },
    );
  }
}

export function mintCausalQuestionId(input: {
  projectIds: readonly string[];
  intervention: string;
  outcome: string;
  createdAt: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        projectIds: [...input.projectIds].sort(),
        intervention: input.intervention,
        outcome: input.outcome,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return `cq_${digest}`;
}

export function causalQuestionContentFingerprint(input: {
  projectIds: readonly string[];
  intervention: string;
  outcome: string;
  targetPopulation: string;
  targetEnvironment: string;
  timeHorizon: string;
  materialityThreshold: number;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        projectIds: [...input.projectIds].sort(),
        intervention: input.intervention,
        outcome: input.outcome,
        targetPopulation: input.targetPopulation,
        targetEnvironment: input.targetEnvironment,
        timeHorizon: input.timeHorizon,
        materialityThreshold: input.materialityThreshold,
      }),
      "utf8",
    )
    .digest("hex");
}

export function causalQuestionIdempotencyKey(input: {
  contentFingerprint: string;
  createdBy: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
