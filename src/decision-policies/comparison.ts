import { createHash } from "node:crypto";
import { z } from "zod";
import type { DecisionPolicyEvaluation } from "./evaluation.js";

export const ComparisonCriterionSchema = z
  .object({
    criterionId: z.string().min(1),
    name: z.string().min(1),
    /** Explicit direction — required for Pareto. */
    direction: z.enum(["HIGHER_IS_BETTER", "LOWER_IS_BETTER"]),
    /** Normalized numeric score in [0,1] after configured normalization. */
    championScore: z.number().min(0).max(1),
    challengerScore: z.number().min(0).max(1),
  })
  .strict();

export type ComparisonCriterion = z.infer<typeof ComparisonCriterionSchema>;

export const DecisionPolicyComparisonSchema = z
  .object({
    decisionPolicyComparisonId: z.string().min(1),
    championPolicyId: z.string().min(1),
    championPolicyVersion: z.number().int().positive(),
    championPolicyHash: z.string().min(1),
    challengerPolicyId: z.string().min(1),
    challengerPolicyVersion: z.number().int().positive(),
    challengerPolicyHash: z.string().min(1),
    championEvaluationId: z.string().min(1),
    challengerEvaluationId: z.string().min(1),
    criteria: z.array(ComparisonCriterionSchema).min(1),
    paretoDominance: z.enum([
      "CHAMPION_DOMINATES",
      "CHALLENGER_DOMINATES",
      "NONE",
      "INCOMPARABLE",
    ]),
    automaticWinner: z.enum(["CHAMPION", "CHALLENGER", "NONE"]),
    limitations: z.array(z.string().min(1)).default([]),
    comparisonHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type DecisionPolicyComparison = z.infer<
  typeof DecisionPolicyComparisonSchema
>;

export function assessParetoDominance(
  criteria: readonly ComparisonCriterion[],
): DecisionPolicyComparison["paretoDominance"] {
  let challengerBetterSomewhere = false;
  let championBetterSomewhere = false;
  let challengerNeverWorse = true;
  let championNeverWorse = true;

  for (const c of criteria) {
    const champ =
      c.direction === "HIGHER_IS_BETTER" ? c.championScore : 1 - c.championScore;
    const chall =
      c.direction === "HIGHER_IS_BETTER"
        ? c.challengerScore
        : 1 - c.challengerScore;
    if (chall > champ + 1e-9) {
      challengerBetterSomewhere = true;
      championNeverWorse = false;
    } else if (champ > chall + 1e-9) {
      championBetterSomewhere = true;
      challengerNeverWorse = false;
    }
  }

  if (challengerNeverWorse && challengerBetterSomewhere) {
    return "CHALLENGER_DOMINATES";
  }
  if (championNeverWorse && championBetterSomewhere) {
    return "CHAMPION_DOMINATES";
  }
  if (challengerBetterSomewhere && championBetterSomewhere) {
    return "INCOMPARABLE";
  }
  return "NONE";
}

export function compareChampionChallenger(input: {
  champion: {
    policyId: string;
    version: number;
    policyHash: string;
    evaluation: DecisionPolicyEvaluation;
  };
  challenger: {
    policyId: string;
    version: number;
    policyHash: string;
    evaluation: DecisionPolicyEvaluation;
  };
  nowIso: string;
}): DecisionPolicyComparison {
  const criteria: ComparisonCriterion[] = [
    {
      criterionId: "coverage",
      name: "Coverage",
      direction: "HIGHER_IS_BETTER",
      championScore: input.champion.evaluation.coverage,
      challengerScore: input.challenger.evaluation.coverage,
    },
    {
      criterionId: "unsupported",
      name: "Unsupported state rate",
      direction: "LOWER_IS_BETTER",
      championScore: input.champion.evaluation.unsupportedStateRate,
      challengerScore: input.challenger.evaluation.unsupportedStateRate,
    },
    {
      criterionId: "constraints",
      name: "Constraint violations",
      direction: "LOWER_IS_BETTER",
      championScore: Math.min(
        1,
        input.champion.evaluation.constraintViolations / 10,
      ),
      challengerScore: Math.min(
        1,
        input.challenger.evaluation.constraintViolations / 10,
      ),
    },
  ];

  const paretoDominance = assessParetoDominance(criteria);
  // No automatic winner if material criteria conflict.
  const automaticWinner =
    paretoDominance === "CHALLENGER_DOMINATES"
      ? "CHALLENGER"
      : paretoDominance === "CHAMPION_DOMINATES"
        ? "CHAMPION"
        : "NONE";

  const base = {
    decisionPolicyComparisonId: `dpcmp_${createHash("sha256")
      .update(
        `${input.champion.policyHash}:${input.challenger.policyHash}:${input.nowIso}`,
        "utf8",
      )
      .digest("hex")
      .slice(0, 16)}`,
    championPolicyId: input.champion.policyId,
    championPolicyVersion: input.champion.version,
    championPolicyHash: input.champion.policyHash,
    challengerPolicyId: input.challenger.policyId,
    challengerPolicyVersion: input.challenger.version,
    challengerPolicyHash: input.challenger.policyHash,
    championEvaluationId: input.champion.evaluation.decisionPolicyEvaluationId,
    challengerEvaluationId:
      input.challenger.evaluation.decisionPolicyEvaluationId,
    criteria,
    paretoDominance,
    automaticWinner,
    limitations: [
      "No automatic winner if material criteria conflict",
      "Do not compare heterogeneous raw units without normalization",
    ],
    createdAt: input.nowIso,
  };

  return DecisionPolicyComparisonSchema.parse({
    ...base,
    comparisonHash: createHash("sha256")
      .update(JSON.stringify(base), "utf8")
      .digest("hex"),
  });
}
