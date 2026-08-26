import { z } from "zod";
import type { DecisionCriterion } from "./decision-problem.js";
import type { ScenarioSimulationResult } from "./simulation-result.js";

export const CriterionDeltaSchema = z
  .object({
    criterionId: z.string().min(1),
    baselineScore: z.number().finite(),
    scenarioScore: z.number().finite(),
    delta: z.number().finite(),
    higherIsBetter: z.boolean(),
  })
  .strict();

export type CriterionDelta = z.infer<typeof CriterionDeltaSchema>;

export const HardConstraintViolationSchema = z
  .object({
    scenarioId: z.string().min(1),
    criterionId: z.string().min(1),
    score: z.number().finite(),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .strict();

export type HardConstraintViolation = z.infer<
  typeof HardConstraintViolationSchema
>;

export const RankedScenarioSchema = z
  .object({
    scenarioId: z.string().min(1),
    weightedScore: z.number().finite(),
    rank: z.number().int().positive(),
    /** Recommendation only — not human selection. */
    recommendationNote: z.string().default(""),
  })
  .strict();

export type RankedScenario = z.infer<typeof RankedScenarioSchema>;

export const ScenarioComparisonResultSchema = z
  .object({
    baselineScenarioId: z.string().min(1),
    deltasByScenario: z.record(z.string(), z.array(CriterionDeltaSchema)),
    dominanceMatrix: z.record(
      z.string(),
      z.record(z.string(), z.boolean()),
    ),
    hardConstraintViolations: z.array(HardConstraintViolationSchema),
    rankedScenarios: z.array(RankedScenarioSchema),
    /** Non-authoritative model ranking — human STRATEGY_SELECTOR decides. */
    rankingDisclaimer: z.string().min(1),
  })
  .strict();

export type ScenarioComparisonResult = z.infer<
  typeof ScenarioComparisonResultSchema
>;

export interface ScenarioComparisonService {
  compareScenarios(input: {
    criteria: readonly DecisionCriterion[];
    baselineScenarioId: string;
    results: readonly ScenarioSimulationResult[];
  }): ScenarioComparisonResult;
}

/**
 * Authoritative weights come only from DecisionProblem.decisionCriteria.
 * MODEL_SUGGESTED_WEIGHT ≠ AUTHORITATIVE_DECISION_WEIGHT.
 *
 * When all authoritative weights sum to 0, apply the explicit deterministic
 * EQUAL_WEIGHT_FALLBACK — never import model-suggested weights.
 */
export const AUTHORITATIVE_WEIGHT_POLICY = {
  source: "DecisionProblem.decisionCriteria",
  modelSuggestedNeverAuthoritative: true,
  zeroSumFallback: "EQUAL_WEIGHT_FALLBACK",
} as const;

export function normalizeAuthoritativeWeights(
  criteria: readonly DecisionCriterion[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (criteria.length === 0) {
    return map;
  }
  const sum = criteria.reduce((acc, c) => acc + c.weight, 0);
  if (sum <= 0) {
    const equal = 1 / criteria.length;
    for (const c of criteria) map.set(c.criterionId, equal);
    return map;
  }
  for (const c of criteria) map.set(c.criterionId, c.weight / sum);
  return map;
}

/** @deprecated Use normalizeAuthoritativeWeights */
function normalizeWeights(
  criteria: readonly DecisionCriterion[],
): Map<string, number> {
  return normalizeAuthoritativeWeights(criteria);
}

function scoreBetter(
  score: number,
  other: number,
  higherIsBetter: boolean,
): boolean {
  return higherIsBetter ? score >= other : score <= other;
}

function scoreStrictlyBetter(
  score: number,
  other: number,
  higherIsBetter: boolean,
): boolean {
  return higherIsBetter ? score > other : score < other;
}

export function scenarioDominates(
  a: ScenarioSimulationResult,
  b: ScenarioSimulationResult,
  criteria: readonly DecisionCriterion[],
): boolean {
  let strictlyBetterOnOne = false;
  for (const c of criteria) {
    const scoreA = a.criterionScores[c.criterionId] ?? 0;
    const scoreB = b.criterionScores[c.criterionId] ?? 0;
    if (!scoreBetter(scoreA, scoreB, c.higherIsBetter)) {
      return false;
    }
    if (scoreStrictlyBetter(scoreA, scoreB, c.higherIsBetter)) {
      strictlyBetterOnOne = true;
    }
  }
  return strictlyBetterOnOne;
}

export function checkHardConstraints(
  result: ScenarioSimulationResult,
  criteria: readonly DecisionCriterion[],
): HardConstraintViolation[] {
  const violations: HardConstraintViolation[] = [];
  for (const c of criteria) {
    if (!c.hardConstraint) continue;
    const score = result.criterionScores[c.criterionId];
    if (score === undefined) continue;
    const { min, max } = c.hardConstraint;
    if (min !== undefined && score < min) {
      violations.push({
        scenarioId: result.scenarioId,
        criterionId: c.criterionId,
        score,
        min,
      });
    }
    if (max !== undefined && score > max) {
      violations.push({
        scenarioId: result.scenarioId,
        criterionId: c.criterionId,
        score,
        max,
      });
    }
  }
  return violations;
}

export function compareScenarios(input: {
  criteria: readonly DecisionCriterion[];
  baselineScenarioId: string;
  results: readonly ScenarioSimulationResult[];
}): ScenarioComparisonResult {
  const { criteria, baselineScenarioId, results } = input;
  const baseline = results.find((r) => r.scenarioId === baselineScenarioId);
  const weights = normalizeWeights(criteria);

  const deltasByScenario: Record<string, CriterionDelta[]> = {};
  const dominanceMatrix: Record<string, Record<string, boolean>> = {};
  const hardConstraintViolations: HardConstraintViolation[] = [];

  for (const result of results) {
    hardConstraintViolations.push(...checkHardConstraints(result, criteria));
    dominanceMatrix[result.scenarioId] = {};
    if (!baseline) continue;

    const deltas: CriterionDelta[] = [];
    for (const c of criteria) {
      const baselineScore = baseline.criterionScores[c.criterionId] ?? 0;
      const scenarioScore = result.criterionScores[c.criterionId] ?? 0;
      deltas.push({
        criterionId: c.criterionId,
        baselineScore,
        scenarioScore,
        delta: scenarioScore - baselineScore,
        higherIsBetter: c.higherIsBetter,
      });
    }
    deltasByScenario[result.scenarioId] = deltas;
  }

  for (const a of results) {
    for (const b of results) {
      if (a.scenarioId === b.scenarioId) {
        dominanceMatrix[a.scenarioId]![b.scenarioId] = false;
        continue;
      }
      dominanceMatrix[a.scenarioId]![b.scenarioId] = scenarioDominates(
        a,
        b,
        criteria,
      );
    }
  }

  const violatingScenarioIds = new Set(
    hardConstraintViolations.map((v) => v.scenarioId),
  );

  // Hard-constraint violators are never recommended, even if weighted score is highest.
  const eligible = results.filter(
    (result) => !violatingScenarioIds.has(result.scenarioId),
  );

  const rankedScenarios: RankedScenario[] = eligible
    .map((result) => {
      let weightedScore = 0;
      for (const c of criteria) {
        const score = result.criterionScores[c.criterionId] ?? 0;
        const w = weights.get(c.criterionId) ?? 0;
        const normalized = c.higherIsBetter ? score : 1 - score;
        weightedScore += w * normalized;
      }
      return {
        scenarioId: result.scenarioId,
        weightedScore: Math.round(weightedScore * 10000) / 10000,
        rank: 0,
        recommendationNote:
          "Weighted ranking uses authoritative DecisionProblem.decisionCriteria only — never model-suggested weights",
      };
    })
    .sort((a, b) => b.weightedScore - a.weightedScore)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return ScenarioComparisonResultSchema.parse({
    baselineScenarioId,
    deltasByScenario,
    dominanceMatrix,
    hardConstraintViolations,
    rankedScenarios,
    rankingDisclaimer:
      "RankedScenario is a recommendation only; human STRATEGY_SELECTOR required. Hard-constraint violators excluded.",
  });
}

export class DefaultScenarioComparisonService implements ScenarioComparisonService {
  compareScenarios(input: {
    criteria: readonly DecisionCriterion[];
    baselineScenarioId: string;
    results: readonly ScenarioSimulationResult[];
  }): ScenarioComparisonResult {
    return compareScenarios(input);
  }
}
