import { z } from "zod";
import type { ScenarioAssumption } from "./assumptions.js";
import { withAssumptionSetHash } from "./assumptions.js";
import type { DecisionProblem } from "./decision-problem.js";
import {
  mintScenarioId,
  type ScenarioDefinition,
} from "./scenario.js";

export const ScenarioGenerationProposalSchema = z
  .object({
    assumptions: z.array(z.unknown()),
    scenarios: z.array(z.unknown()),
    riskFactors: z.array(z.string()),
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    /**
     * UNTRUSTED DATA only. Never used as comparison / recommendation authority.
     * MODEL_SUGGESTED_WEIGHT ≠ AUTHORITATIVE_DECISION_WEIGHT.
     */
    untrustedSuggestedCriteriaWeights: z
      .array(
        z
          .object({
            criterionId: z.string().min(1),
            weight: z.number().min(0).max(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ScenarioGenerationProposal = z.infer<
  typeof ScenarioGenerationProposalSchema
>;

export interface ScenarioGenerationModel {
  readonly modelId: string;
  readonly modelVersion: string;
  generate(input: {
    decisionProblem: DecisionProblem;
    truthSnapshotFingerprint: string;
    scenarioSetId: string;
    scenarioSetVersion: number;
  }): Promise<ScenarioGenerationProposal>;
}

/**
 * Deterministic fake generation model.
 * Produces baseline + upside + downside — recommendations only.
 */
export class FakeScenarioGenerationModel implements ScenarioGenerationModel {
  readonly modelId = "fake-scenario-generation";
  readonly modelVersion = "1.0.0";

  constructor(
    private readonly options?: {
      /** Additional OTHER-role scenarios beyond baseline/upside/downside. */
      extraScenarioCount?: number;
    },
  ) {}

  async generate(input: {
    decisionProblem: DecisionProblem;
    truthSnapshotFingerprint: string;
    scenarioSetId: string;
    scenarioSetVersion: number;
  }): Promise<ScenarioGenerationProposal> {
    void input.truthSnapshotFingerprint;
    const { decisionProblem, scenarioSetId } = input;
    const assumptions: ScenarioAssumption[] = [
      {
        assumptionId: "asm_growth_rate",
        name: "Market growth rate",
        description: "Annual market growth assumption for strategic projection",
        value: 0.08,
        unit: "PERCENT",
        sourceClass: "ASSUMPTION",
        confidenceClassification: "MEDIUM",
        lowerBound: 0.02,
        upperBound: 0.15,
        sensitivityEligible: true,
        materiality: "HIGH",
      },
      {
        assumptionId: "asm_cost_inflation",
        name: "Cost inflation",
        description: "Expected cost inflation over decision horizon",
        value: 0.03,
        unit: "PERCENT",
        sourceClass: "ASSUMPTION",
        confidenceClassification: "MEDIUM",
        lowerBound: 0.01,
        upperBound: 0.06,
        sensitivityEligible: true,
        materiality: "MEDIUM",
      },
      {
        assumptionId: "asm_execution_velocity",
        name: "Execution velocity",
        description: "Relative speed of program delivery vs baseline",
        value: 1.0,
        unit: "RATIO",
        sourceClass: "ASSUMPTION",
        confidenceClassification: "LOW",
        lowerBound: 0.7,
        upperBound: 1.3,
        sensitivityEligible: true,
        materiality: "HIGH",
      },
    ];
    withAssumptionSetHash(assumptions);

    const baselineId = mintScenarioId({
      scenarioSetId,
      name: "Baseline continuation",
    });
    const upsideId = mintScenarioId({
      scenarioSetId,
      name: "Upside acceleration",
    });
    const downsideId = mintScenarioId({
      scenarioSetId,
      name: "Downside stress",
    });

    const scenarios: ScenarioDefinition[] = [
      {
        scenarioId: baselineId,
        scenarioSetId,
        name: "Baseline continuation",
        description: `Continuation under current strategy for: ${decisionProblem.question}`,
        roleHint: "BASELINE",
        assumptionOverrides: [],
        strategicActionsProposed: ["Continue current portfolio trajectory"],
        expectedTimeHorizon: decisionProblem.timeHorizon,
        riskFactors: ["Status quo bias", "External shock exposure"],
        dependencies: [],
      },
      {
        scenarioId: upsideId,
        scenarioSetId,
        name: "Upside acceleration",
        description: "Accelerated investment with favorable market conditions",
        roleHint: "UPSIDE",
        assumptionOverrides: [
          {
            ...assumptions[0]!,
            value: 0.12,
          },
          {
            ...assumptions[2]!,
            value: 1.2,
          },
        ],
        strategicActionsProposed: [
          "Increase program concurrency",
          "Expand to adjacent goals",
        ],
        portfolioIntentDelta: {
          riskToleranceProfile: "HIGH",
          capitalAllocationPrinciples: ["Front-load high-ROI initiatives"],
        },
        expectedTimeHorizon: decisionProblem.timeHorizon,
        riskFactors: ["Over-extension", "Resource contention"],
        dependencies: [baselineId],
      },
      {
        scenarioId: downsideId,
        scenarioSetId,
        name: "Downside stress",
        description: "Conservative posture under adverse conditions",
        roleHint: "DOWNSIDE",
        assumptionOverrides: [
          {
            ...assumptions[0]!,
            value: 0.02,
          },
          {
            ...assumptions[1]!,
            value: 0.05,
          },
        ],
        strategicActionsProposed: [
          "Defer non-critical programs",
          "Preserve capital reserves",
        ],
        portfolioIntentDelta: {
          riskToleranceProfile: "LOW",
          capitalAllocationPrinciples: ["Preserve optionality"],
        },
        expectedTimeHorizon: decisionProblem.timeHorizon,
        riskFactors: ["Goal deferral", "Competitive lag"],
        dependencies: [baselineId],
      },
    ];

    const extra = this.options?.extraScenarioCount ?? 0;
    for (let i = 0; i < extra; i++) {
      const name = `Alternate branch ${i + 1}`;
      const sid = mintScenarioId({ scenarioSetId, name });
      scenarios.push({
        scenarioId: sid,
        scenarioSetId,
        name,
        description: `Additional deterministic scenario branch ${i + 1}`,
        roleHint: "OTHER",
        assumptionOverrides: [],
        strategicActionsProposed: [`Explore branch ${i + 1}`],
        expectedTimeHorizon: decisionProblem.timeHorizon,
        riskFactors: [`Branch ${i + 1} uncertainty`],
        dependencies: [baselineId],
      });
    }

    return {
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      assumptions,
      scenarios,
      riskFactors: [
        "Fake model: scenarios are non-authoritative recommendations",
        "Assumptions require human validation before selection",
      ],
      // Deliberately untrusted — orchestrator must ignore for ranking.
      untrustedSuggestedCriteriaWeights:
        decisionProblem.decisionCriteria.map((c, i) => ({
          criterionId: c.criterionId,
          weight: i === 0 ? 0 : 1 / Math.max(1, decisionProblem.decisionCriteria.length - 1),
        })),
    };
  }
}
