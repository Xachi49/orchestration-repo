import { createHash } from "node:crypto";
import type { DecisionCriterion } from "./decision-problem.js";
import type { ScenarioDefinition } from "./scenario.js";
import {
  SIMULATION_ENGINE_VERSION,
  SIMULATION_RESULT_CAVEAT,
  mintSimulationRunId,
  simulationConfigurationFingerprint,
  simulationInputFingerprint,
  type ScenarioSimulationResult,
} from "./simulation-result.js";

export interface ScenarioSimulationInput {
  decisionProblemId: string;
  decisionProblemVersion: number;
  scenario: ScenarioDefinition;
  scenarioSetId: string;
  scenarioSetVersion: number;
  assumptionSetHash: string;
  truthSnapshotFingerprint: string;
  randomSeed: string;
  decisionCriteria: readonly DecisionCriterion[];
  maximumScenarioCount: number;
  maximumSimulationRuns: number;
  createdAt: string;
}

export interface ScenarioSimulationEngine {
  readonly engineVersion: string;
  simulate(input: ScenarioSimulationInput): Promise<ScenarioSimulationResult>;
}

function hashToUnit(input: string): number {
  const digest = createHash("sha256").update(input, "utf8").digest("hex");
  const slice = parseInt(digest.slice(0, 8), 16);
  return slice / 0xffffffff;
}

function deriveCriterionScores(
  scenarioId: string,
  assumptionSetHash: string,
  seed: string,
  criteria: readonly DecisionCriterion[],
): Record<string, number> {
  const scores: Record<string, number> = {};
  for (const c of criteria) {
    const raw = hashToUnit(
      `${scenarioId}:${assumptionSetHash}:${seed}:${c.criterionId}`,
    );
    scores[c.criterionId] = Math.round(raw * 10000) / 10000;
  }
  return scores;
}

/**
 * Deterministic fake simulation engine.
 * Same scenarioId + assumptionSetHash + seed → identical result.
 */
export class FakeScenarioSimulationEngine implements ScenarioSimulationEngine {
  readonly engineVersion = SIMULATION_ENGINE_VERSION;

  async simulate(
    input: ScenarioSimulationInput,
  ): Promise<ScenarioSimulationResult> {
    const configurationFingerprint = simulationConfigurationFingerprint({
      maximumScenarioCount: input.maximumScenarioCount,
      maximumSimulationRuns: input.maximumSimulationRuns,
    });
    const inputFingerprint = simulationInputFingerprint({
      decisionProblemVersion: input.decisionProblemVersion,
      scenarioId: input.scenario.scenarioId,
      assumptionSetHash: input.assumptionSetHash,
      truthSnapshotFingerprint: input.truthSnapshotFingerprint,
      engineVersion: this.engineVersion,
      configurationFingerprint,
      randomSeed: input.randomSeed,
    });
    const simulationRunId = mintSimulationRunId({
      scenarioId: input.scenario.scenarioId,
      inputFingerprint,
    });
    const baseScore = hashToUnit(
      `${input.scenario.scenarioId}:${input.assumptionSetHash}:${input.randomSeed}`,
    );
    const criterionScores = deriveCriterionScores(
      input.scenario.scenarioId,
      input.assumptionSetHash,
      input.randomSeed,
      input.decisionCriteria,
    );

    return {
      simulationRunId,
      scenarioId: input.scenario.scenarioId,
      scenarioSetId: input.scenarioSetId,
      scenarioSetVersion: input.scenarioSetVersion,
      decisionProblemId: input.decisionProblemId,
      decisionProblemVersion: input.decisionProblemVersion,
      inputFingerprint,
      assumptionSetHash: input.assumptionSetHash,
      truthSnapshotFingerprint: input.truthSnapshotFingerprint,
      engineVersion: this.engineVersion,
      configurationFingerprint,
      randomSeed: input.randomSeed,
      expectedOutcomes: [
        `Estimated outcome score ${(baseScore * 100).toFixed(1)}% for ${input.scenario.name}`,
      ],
      riskMetrics: [
        {
          name: "downside_exposure",
          quantity: { value: baseScore * 0.3, unit: "SCORE" },
        },
      ],
      resourceRequirements: [
        {
          name: "estimated_tokens",
          quantity: {
            value: Math.floor(baseScore * 1_000_000),
            unit: "TOKENS",
          },
        },
      ],
      estimatedPortfolioEffects: input.scenario.strategicActionsProposed,
      goalEffects: [],
      distributionSummary: `Deterministic estimate from seed ${input.randomSeed}`,
      uncertainty: {
        assumptionSensitivity: "MEDIUM",
        evidenceQuality: "LOW",
        modelUncertaintyClass: "HIGH",
        confidenceWithoutProvenance: "UNKNOWN",
      },
      sensitivityCandidates: input.scenario.assumptionOverrides.map(
        (a) => a.assumptionId,
      ),
      limitations: [
        SIMULATION_RESULT_CAVEAT,
        "All criterion scores and quantities are hash-derived estimates",
        "Values must not be treated as verified outcomes",
      ],
      criterionScores,
      createdAt: input.createdAt,
    };
  }
}
