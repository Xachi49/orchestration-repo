import { z } from "zod";
import type { ScenarioAssumption } from "./assumptions.js";
import type { DecisionProblem } from "./decision-problem.js";
import type { ScenarioComparisonResult } from "./comparison.js";
import type { ScenarioSimulationResult } from "./simulation-result.js";

export const SensitivityFindingSchema = z
  .object({
    findingId: z.string().min(1),
    assumptionId: z.string().min(1),
    scenarioId: z.string().min(1),
    perturbedValue: z.number().finite(),
    baselineValue: z.number().finite(),
    scoreDelta: z.number().finite(),
    rankChanged: z.boolean(),
    winnerChanged: z.boolean(),
  })
  .strict();

export type SensitivityFinding = z.infer<typeof SensitivityFindingSchema>;

export const SensitivityAnalysisResultSchema = z
  .object({
    findings: z.array(SensitivityFindingSchema),
    fragileWinnerScenarioId: z.string().min(1).optional(),
    robustWinnerScenarioId: z.string().min(1).optional(),
    evaluationsPerformed: z.number().int().nonnegative(),
    evaluationBudget: z.number().int().nonnegative(),
    truncated: z.boolean(),
  })
  .strict();

export type SensitivityAnalysisResult = z.infer<
  typeof SensitivityAnalysisResultSchema
>;

export interface ScenarioRobustnessAnalyzer {
  runSensitivity(input: {
    decisionProblem: DecisionProblem;
    assumptions: readonly ScenarioAssumption[];
    results: readonly ScenarioSimulationResult[];
    comparison: ScenarioComparisonResult;
    evaluatePerturbation: (input: {
      assumptionId: string;
      perturbedValue: number;
      scenarioId: string;
    }) => Promise<number>;
  }): Promise<SensitivityAnalysisResult>;
}

function mintFindingId(input: {
  assumptionId: string;
  scenarioId: string;
  perturbedValue: number;
}): string {
  return `sens_${input.assumptionId}_${input.scenarioId}_${input.perturbedValue}`.slice(
    0,
    120,
  );
}

export async function runSensitivity(input: {
  decisionProblem: DecisionProblem;
  assumptions: readonly ScenarioAssumption[];
  results: readonly ScenarioSimulationResult[];
  comparison: ScenarioComparisonResult;
  evaluatePerturbation: (input: {
    assumptionId: string;
    perturbedValue: number;
    scenarioId: string;
  }) => Promise<number>;
}): Promise<SensitivityAnalysisResult> {
  const budget = input.decisionProblem.maximumSensitivityEvaluations;
  const eligible = input.assumptions.filter(
    (a) =>
      a.sensitivityEligible &&
      a.lowerBound !== undefined &&
      a.upperBound !== undefined,
  );

  const topRanked = input.comparison.rankedScenarios[0]?.scenarioId;
  const findings: SensitivityFinding[] = [];
  let evaluationsPerformed = 0;
  let truncated = false;
  let winnerChangeCount = 0;
  const winnerChangeByScenario = new Map<string, number>();

  for (const assumption of eligible) {
    if (evaluationsPerformed >= budget) {
      truncated = true;
      break;
    }
    const perturbations = [assumption.lowerBound!, assumption.upperBound!];
    for (const perturbedValue of perturbations) {
      if (evaluationsPerformed >= budget) {
        truncated = true;
        break;
      }
      for (const result of input.results) {
        if (evaluationsPerformed >= budget) {
          truncated = true;
          break;
        }
        const baselineScore =
          input.comparison.rankedScenarios.find(
            (r) => r.scenarioId === result.scenarioId,
          )?.weightedScore ?? 0;
        const perturbedScore = await input.evaluatePerturbation({
          assumptionId: assumption.assumptionId,
          perturbedValue,
          scenarioId: result.scenarioId,
        });
        evaluationsPerformed += 1;

        const rankChanged = Math.abs(perturbedScore - baselineScore) > 0.05;
        const winnerChanged =
          topRanked !== undefined &&
          result.scenarioId === topRanked &&
          perturbedScore < baselineScore * 0.9;
        if (winnerChanged) {
          winnerChangeCount += 1;
          winnerChangeByScenario.set(
            result.scenarioId,
            (winnerChangeByScenario.get(result.scenarioId) ?? 0) + 1,
          );
        }

        findings.push({
          findingId: mintFindingId({
            assumptionId: assumption.assumptionId,
            scenarioId: result.scenarioId,
            perturbedValue,
          }),
          assumptionId: assumption.assumptionId,
          scenarioId: result.scenarioId,
          perturbedValue,
          baselineValue: assumption.value,
          scoreDelta: perturbedScore - baselineScore,
          rankChanged,
          winnerChanged,
        });
      }
    }
  }

  let fragileWinnerScenarioId: string | undefined;
  let robustWinnerScenarioId: string | undefined;
  if (topRanked) {
    const changes = winnerChangeByScenario.get(topRanked) ?? 0;
    if (changes > 0) {
      fragileWinnerScenarioId = topRanked;
    } else {
      robustWinnerScenarioId = topRanked;
    }
  }

  return SensitivityAnalysisResultSchema.parse({
    findings,
    fragileWinnerScenarioId,
    robustWinnerScenarioId,
    evaluationsPerformed,
    evaluationBudget: budget,
    truncated,
  });
}

export class DefaultScenarioRobustnessAnalyzer
  implements ScenarioRobustnessAnalyzer
{
  async runSensitivity(input: {
    decisionProblem: DecisionProblem;
    assumptions: readonly ScenarioAssumption[];
    results: readonly ScenarioSimulationResult[];
    comparison: ScenarioComparisonResult;
    evaluatePerturbation: (input: {
      assumptionId: string;
      perturbedValue: number;
      scenarioId: string;
    }) => Promise<number>;
  }): Promise<SensitivityAnalysisResult> {
    return runSensitivity(input);
  }
}
