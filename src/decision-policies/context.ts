import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canTransitionDecisionPolicy,
  type DecisionPolicyState,
} from "./policy-state.js";
import { DecisionPolicyError } from "./errors.js";
import {
  DecisionActionDefinitionSchema,
  DecisionStateVariableSchema,
  RiskClassSchema,
} from "./variables-actions.js";

export const INITIAL_DECISION_CONTEXT_VERSION = 1;

export const DecisionContextStatusSchema = z.enum([
  "DRAFT",
  "ADMITTED",
  "ACTIVE",
  "RETIRED",
  "STALE",
]);
export type DecisionContextStatus = z.infer<typeof DecisionContextStatusSchema>;

export const OptimizationObjectiveSchema = z
  .object({
    objectiveId: z.string().min(1),
    name: z.string().min(1),
    direction: z.enum(["MAXIMIZE", "MINIMIZE"]),
    unit: z.string().min(1),
    weight: z.number().finite().nonnegative().default(1),
  })
  .strict();

export type OptimizationObjective = z.infer<typeof OptimizationObjectiveSchema>;

export const DecisionContextSchema = z
  .object({
    decisionContextId: z.string().min(1),
    decisionContextVersion: z.number().int().positive(),
    projectIds: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    strategicGoalRefs: z.array(z.string().min(1)).default([]),
    portfolioRefs: z.array(z.string().min(1)).default([]),
    programRefs: z.array(z.string().min(1)).default([]),
    decisionProblemRefs: z.array(z.string().min(1)).default([]),
    stateVariables: z.array(DecisionStateVariableSchema).min(1),
    eligibleActions: z.array(DecisionActionDefinitionSchema).min(1),
    constraints: z.array(z.string().min(1)).default([]),
    nonGoals: z.array(z.string().min(1)).default([]),
    optimizationObjectives: z.array(OptimizationObjectiveSchema).min(1),
    riskTolerance: RiskClassSchema,
    materialityThreshold: z.number().finite(),
    timeHorizon: z.string().min(1),
    createdBy: z.string().min(1),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    status: DecisionContextStatusSchema,
    recordRevision: z.number().int().min(1),
    contextHash: z.string().min(1),
  })
  .strict();

export type DecisionContext = z.infer<typeof DecisionContextSchema>;

export function computeDecisionContextHash(
  input: Omit<DecisionContext, "contextHash">,
): string {
  const {
    recordRevision: _recordRevision,
    updatedAt: _updatedAt,
    ...forHash
  } = input;
  void _recordRevision;
  void _updatedAt;
  return createHash("sha256")
    .update(
      JSON.stringify({
        decisionContextId: forHash.decisionContextId,
        decisionContextVersion: forHash.decisionContextVersion,
        projectIds: [...forHash.projectIds].sort(),
        environmentScope: [...forHash.environmentScope].sort(),
        strategicGoalRefs: [...forHash.strategicGoalRefs].sort(),
        portfolioRefs: [...forHash.portfolioRefs].sort(),
        programRefs: [...forHash.programRefs].sort(),
        decisionProblemRefs: [...forHash.decisionProblemRefs].sort(),
        stateVariables: forHash.stateVariables,
        eligibleActions: forHash.eligibleActions,
        constraints: forHash.constraints,
        nonGoals: forHash.nonGoals,
        optimizationObjectives: forHash.optimizationObjectives,
        riskTolerance: forHash.riskTolerance,
        materialityThreshold: forHash.materialityThreshold,
        timeHorizon: forHash.timeHorizon,
        status: forHash.status,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withDecisionContextHash(
  input: Omit<DecisionContext, "contextHash">,
): DecisionContext {
  return DecisionContextSchema.parse({
    ...input,
    contextHash: computeDecisionContextHash(input),
  });
}

export function mintDecisionContextId(input: {
  projectIds: readonly string[];
  createdAt: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        projectIds: [...input.projectIds].sort(),
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 16);
  return `dctx_${digest}`;
}

export function parseDecisionContext(raw: unknown): DecisionContext {
  return DecisionContextSchema.parse(raw);
}

export function assertDecisionPolicyTransition(
  from: DecisionPolicyState,
  to: DecisionPolicyState,
): void {
  if (!canTransitionDecisionPolicy(from, to)) {
    throw new DecisionPolicyError(
      "INVALID_DECISION_POLICY_TRANSITION",
      `Cannot transition decision policy ${from} → ${to}`,
      { from, to },
    );
  }
}
