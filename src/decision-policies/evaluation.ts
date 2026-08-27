import { createHash } from "node:crypto";
import { z } from "zod";
import type { DecisionContext } from "./context.js";
import type { DecisionPolicyCandidate } from "./policy.js";
import {
  evaluatePredicate,
  type DecisionStateValues,
} from "./predicates.js";

export const CounterfactualSupportStatusSchema = z.enum([
  "SUPPORTED_BY_PROMOTED_CAUSAL",
  "SUPPORTED_BY_SCENARIO_SIMULATION",
  "COUNTERFACTUAL_UNSUPPORTED",
]);
export type CounterfactualSupportStatus = z.infer<
  typeof CounterfactualSupportStatusSchema
>;

export const RegretEstimabilitySchema = z.enum([
  "ESTIMABLE",
  "PARTIALLY_ESTIMABLE",
  "NOT_ESTIMABLE",
]);
export type RegretEstimability = z.infer<typeof RegretEstimabilitySchema>;

export const DecisionPolicyValueEstimateSchema = z
  .object({
    estimatedBenefit: z.number().finite().optional(),
    estimatedCost: z.number().finite().optional(),
    estimatedRisk: z.number().finite().optional(),
    estimatedDecisionCoverage: z.number().min(0).max(1),
    estimatedUnsupportedRate: z.number().min(0).max(1),
    uncertainty: z.enum(["LOW", "MEDIUM", "HIGH", "UNSUPPORTED"]),
    evidenceQuality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    limitations: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type DecisionPolicyValueEstimate = z.infer<
  typeof DecisionPolicyValueEstimateSchema
>;

export const EstimatedRegretSchema = z
  .object({
    status: RegretEstimabilitySchema,
    estimatedRegret: z.number().finite().optional(),
    observedRegret: z.number().finite().optional(),
    counterfactualSupport: CounterfactualSupportStatusSchema,
    limitations: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type EstimatedRegret = z.infer<typeof EstimatedRegretSchema>;

export const HistoricalDecisionCaseSchema = z
  .object({
    caseId: z.string().min(1),
    stateValues: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
    observedActionId: z.string().min(1).optional(),
    observedOutcome: z.number().finite().optional(),
    /** Only when Phase 18/16 support exists for the alternate action. */
    counterfactualOutcome: z.number().finite().optional(),
    counterfactualSupport: CounterfactualSupportStatusSchema.default(
      "COUNTERFACTUAL_UNSUPPORTED",
    ),
  })
  .strict();

export type HistoricalDecisionCase = z.infer<
  typeof HistoricalDecisionCaseSchema
>;

export const DecisionPolicyEvaluationSchema = z
  .object({
    decisionPolicyEvaluationId: z.string().min(1),
    decisionPolicyId: z.string().min(1),
    decisionPolicyVersion: z.number().int().positive(),
    policyHash: z.string().min(1),
    coverage: z.number().min(0).max(1),
    eligibleDecisions: z.number().int().nonnegative(),
    recommendedActionCounts: z.record(z.string(), z.number().int().nonnegative()),
    constraintViolations: z.number().int().nonnegative(),
    estimatedOutcome: z.number().finite().optional(),
    estimatedResourceUse: z
      .object({
        tokens: z.number().nonnegative().optional(),
        usd: z.number().nonnegative().optional(),
      })
      .strict()
      .default({}),
    uncertainty: z.enum(["LOW", "MEDIUM", "HIGH", "UNSUPPORTED"]),
    unsupportedStateRate: z.number().min(0).max(1),
    evidenceQuality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    valueEstimate: DecisionPolicyValueEstimateSchema,
    regret: EstimatedRegretSchema,
    limitations: z.array(z.string().min(1)).default([]),
    evaluationHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyEvaluation = z.infer<
  typeof DecisionPolicyEvaluationSchema
>;

export function selectActionForState(input: {
  policy: DecisionPolicyCandidate;
  context: DecisionContext;
  stateValues: DecisionStateValues;
}): {
  actionId: string;
  matchedRuleId: string | null;
  unsupported: boolean;
} {
  const sorted = [...input.policy.rules].sort(
    (a, b) => a.priority - b.priority || a.decisionRuleId.localeCompare(b.decisionRuleId),
  );
  for (const rule of sorted) {
    try {
      if (evaluatePredicate(rule.predicate, input.stateValues)) {
        const eligible = input.context.eligibleActions.some(
          (a) => a.actionId === rule.actionId,
        );
        if (!eligible) {
          return {
            actionId: input.policy.defaultActionId,
            matchedRuleId: null,
            unsupported: true,
          };
        }
        return {
          actionId: rule.actionId,
          matchedRuleId: rule.decisionRuleId,
          unsupported: false,
        };
      }
    } catch {
      return {
        actionId: input.policy.defaultActionId,
        matchedRuleId: null,
        unsupported: true,
      };
    }
  }
  return {
    actionId: input.policy.defaultActionId,
    matchedRuleId: null,
    unsupported: false,
  };
}

export function evaluateDecisionPolicyOffline(input: {
  policy: DecisionPolicyCandidate;
  context: DecisionContext;
  cases: readonly HistoricalDecisionCase[];
  nowIso: string;
}): DecisionPolicyEvaluation {
  const recommendedActionCounts: Record<string, number> = {};
  let unsupported = 0;
  let constraintViolations = 0;
  let estimatedOutcomeSum = 0;
  let estimatedOutcomeCount = 0;
  let regretSum = 0;
  let regretCount = 0;
  let observedRegretSum = 0;
  let observedRegretCount = 0;
  let anyCounterfactualSupported = false;
  let allCounterfactualSupported = true;

  for (const c of input.cases) {
    const selected = selectActionForState({
      policy: input.policy,
      context: input.context,
      stateValues: c.stateValues,
    });
    recommendedActionCounts[selected.actionId] =
      (recommendedActionCounts[selected.actionId] ?? 0) + 1;
    if (selected.unsupported) unsupported += 1;

    const action = input.context.eligibleActions.find(
      (a) => a.actionId === selected.actionId,
    );
    if (
      action &&
      riskRank(action.riskClass) >
        riskRank(input.policy.riskConstraints.maxRiskClass)
    ) {
      constraintViolations += 1;
    }

    if (
      c.counterfactualSupport === "COUNTERFACTUAL_UNSUPPORTED" ||
      c.counterfactualOutcome === undefined
    ) {
      allCounterfactualSupported = false;
    } else {
      anyCounterfactualSupported = true;
      if (c.observedOutcome !== undefined) {
        // Estimated regret: observed under historical action vs counterfactual
        // under recommended — NEVER labeled observed regret unless alternate
        // was actually observed.
        const delta = c.counterfactualOutcome - c.observedOutcome;
        regretSum += Math.max(0, -delta);
        regretCount += 1;
      }
    }
    if (
      c.observedActionId !== undefined &&
      c.observedOutcome !== undefined &&
      selected.actionId === c.observedActionId
    ) {
      estimatedOutcomeSum += c.observedOutcome;
      estimatedOutcomeCount += 1;
    }
  }

  const n = input.cases.length;
  const unsupportedStateRate = n === 0 ? 1 : unsupported / n;
  const coverage = n === 0 ? 0 : 1 - unsupportedStateRate;

  let regretStatus: EstimatedRegret["status"] = "NOT_ESTIMABLE";
  let counterfactualSupport: CounterfactualSupportStatus =
    "COUNTERFACTUAL_UNSUPPORTED";
  if (allCounterfactualSupported && regretCount > 0) {
    regretStatus = "ESTIMABLE";
    counterfactualSupport =
      input.cases[0]?.counterfactualSupport ?? "COUNTERFACTUAL_UNSUPPORTED";
  } else if (anyCounterfactualSupported && regretCount > 0) {
    regretStatus = "PARTIALLY_ESTIMABLE";
    counterfactualSupport = "SUPPORTED_BY_PROMOTED_CAUSAL";
  }

  const limitations = [
    "OFFLINE_EVALUATION != LIVE_OUTCOME",
    "Observed outcome under chosen action != counterfactual under alternative",
  ];
  if (regretStatus === "NOT_ESTIMABLE") {
    limitations.push("COUNTERFACTUAL_UNSUPPORTED for regret estimation");
  }

  const valueEstimate = DecisionPolicyValueEstimateSchema.parse({
    ...(estimatedOutcomeCount > 0
      ? { estimatedBenefit: estimatedOutcomeSum / estimatedOutcomeCount }
      : {}),
    estimatedDecisionCoverage: coverage,
    estimatedUnsupportedRate: unsupportedStateRate,
    uncertainty:
      regretStatus === "ESTIMABLE"
        ? "MEDIUM"
        : regretStatus === "PARTIALLY_ESTIMABLE"
          ? "HIGH"
          : "UNSUPPORTED",
    evidenceQuality: "PARTIAL",
    limitations: [...limitations],
  });

  const regret = EstimatedRegretSchema.parse({
    status: regretStatus,
    ...(regretCount > 0
      ? { estimatedRegret: regretSum / regretCount }
      : {}),
    ...(observedRegretCount > 0
      ? { observedRegret: observedRegretSum / observedRegretCount }
      : {}),
    counterfactualSupport,
    limitations:
      regretStatus === "NOT_ESTIMABLE"
        ? ["Do not call offline counterfactual differences observed regret"]
        : ["estimatedRegret != observedRegret"],
  });

  const base = {
    decisionPolicyEvaluationId: mintEvaluationId({
      policyHash: input.policy.policyHash,
      createdAt: input.nowIso,
    }),
    decisionPolicyId: input.policy.decisionPolicyId,
    decisionPolicyVersion: input.policy.decisionPolicyVersion,
    policyHash: input.policy.policyHash,
    coverage,
    eligibleDecisions: n,
    recommendedActionCounts,
    constraintViolations,
    ...(estimatedOutcomeCount > 0
      ? { estimatedOutcome: estimatedOutcomeSum / estimatedOutcomeCount }
      : {}),
    estimatedResourceUse: {},
    uncertainty: valueEstimate.uncertainty,
    unsupportedStateRate,
    evidenceQuality: valueEstimate.evidenceQuality,
    valueEstimate,
    regret,
    limitations,
    createdAt: input.nowIso,
  };

  const evaluationHash = createHash("sha256")
    .update(JSON.stringify(base), "utf8")
    .digest("hex");

  return DecisionPolicyEvaluationSchema.parse({
    ...base,
    evaluationHash,
  });
}

function mintEvaluationId(input: {
  policyHash: string;
  createdAt: string;
}): string {
  return `dpev_${createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16)}`;
}

function riskRank(risk: string): number {
  switch (risk) {
    case "LOW":
      return 1;
    case "MEDIUM":
      return 2;
    case "HIGH":
      return 3;
    case "CRITICAL":
      return 4;
    default:
      return 99;
  }
}
