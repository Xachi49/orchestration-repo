import { z } from "zod";
import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentHypothesis } from "./hypothesis.js";
import type { ExperimentMeasurement } from "./hypothesis.js";
import type { ExperimentAssumptionBinding } from "./experiment.js";
import type { ExperimentStoppingRule } from "./plan.js";

export const ExperimentDesignProposalSchema = z
  .object({
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
    hypotheses: z.array(z.unknown()),
    measurements: z.array(z.unknown()),
    procedure: z.string().min(1),
    stoppingRules: z.array(z.unknown()),
    successRules: z.array(z.string()),
    inconclusiveRules: z.array(z.string()),
    evidenceRequirements: z.array(z.string()),
    riskAssessment: z.string().min(1),
    /** UNTRUSTED — never authoritative for authorization/truth. */
    untrustedSuggestedRiskClass: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  })
  .strict();

export type ExperimentDesignProposal = z.infer<
  typeof ExperimentDesignProposalSchema
>;

export interface ExperimentDesignModel {
  readonly modelId: string;
  readonly modelVersion: string;
  design(input: {
    experiment: GovernedExperiment;
  }): Promise<ExperimentDesignProposal>;
}

/**
 * Deterministic fake design model — proposals only, never authority.
 */
export class FakeExperimentDesignModel implements ExperimentDesignModel {
  readonly modelId = "fake-experiment-design";
  readonly modelVersion = "1.0.0";

  async design(input: {
    experiment: GovernedExperiment;
  }): Promise<ExperimentDesignProposal> {
    const { experiment } = input;
    const assumptionId =
      experiment.sourceAssumptionIds[0] ?? "asm_unknown_material";
    const hypothesisId = `hyp_${experiment.experimentId}_primary`;
    const measurementId = `meas_${experiment.experimentId}_primary`;

    const hypotheses: ExperimentHypothesis[] = [
      {
        hypothesisId,
        statement: `Learning ${assumptionId} changes strategic decision materially`,
        nullHypothesis: `No material change in decision from learning ${assumptionId}`,
        alternativeHypothesis: `Learning ${assumptionId} flips or materially shifts preferred scenario`,
        sourceAssumptionId: assumptionId,
        expectedDirection: "UNKNOWN",
        materiality: "HIGH",
        decisionImpact: "HIGH",
        successCriterion: "Observed effect exceeds minimum detectable effect with VALIDATED quality",
        failureCriterion: "Observed effect opposite to expected direction with VALIDATED quality",
        inconclusiveCriterion:
          "Sample insufficient, quality UNKNOWN/DEGRADED, or effect within noise band",
      },
    ];

    const measurements: ExperimentMeasurement[] = [
      {
        measurementId,
        name: "Primary bounded outcome metric",
        unit: "RATIO",
        source: "governed_execution_artifact",
        collectionMethod: "Phase 8 verified outcome extract",
        baseline: 1.0,
        target: 1.1,
        minimumDetectableEffect: 0.05,
        measurementWindow: experiment.budgetEnvelope.maximumDurationHours + "h",
        samplingFrequency: "per_execution",
        evidenceClass: "VERIFIED_PROGRAM_OUTCOME",
        requiredForDecision: true,
        qualityRequirements: ["VALIDATED"],
      },
    ];

    const bindings: ExperimentAssumptionBinding[] = [
      {
        experimentId: experiment.experimentId,
        hypothesisId,
        assumptionId,
        expectedInformationContribution: "HIGH",
        ...(experiment.sourceScenarioSetId
          ? { scenarioSetId: experiment.sourceScenarioSetId }
          : {}),
        ...(experiment.sourceScenarioSetVersion !== undefined
          ? { scenarioSetVersion: experiment.sourceScenarioSetVersion }
          : {}),
      },
    ];

    const stoppingRules: ExperimentStoppingRule[] = [
      {
        ruleId: "stop_max_duration",
        kind: "MAXIMUM_DURATION",
        threshold: experiment.budgetEnvelope.maximumDurationHours,
        description: "Stop when maximum duration hours reached",
      },
      {
        ruleId: "stop_max_samples",
        kind: "MAXIMUM_OBSERVATIONS",
        threshold: experiment.budgetEnvelope.maximumSampleSize,
        description: "Stop when maximum sample size reached",
      },
      {
        ruleId: "stop_safety",
        kind: "SAFETY_THRESHOLD",
        threshold: "safety_boundary_crossed",
        description: "Stop new progression on safety boundary violation",
      },
      {
        ruleId: "stop_authority_drift",
        kind: "AUTHORITY_DRIFT",
        threshold: "material_authority_change",
        description: "Fail closed on material authority drift",
      },
    ];

    return {
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      hypotheses,
      measurements,
      procedure:
        "Bounded governed experiment: compile to Objective, Phase 6 authorize, execute, Phase 8 verify, build evidence bundle.",
      stoppingRules,
      successRules: ["Hypothesis SUPPORTED with VALIDATED evidence quality"],
      inconclusiveRules: [
        "UNKNOWN or DEGRADED evidence quality",
        "Insufficient sample",
      ],
      evidenceRequirements: [
        "PHASE_8_VERIFICATION",
        "MEASUREMENT_ARTIFACT_REF",
      ],
      riskAssessment: `Risk class ${experiment.riskClass}; external side effects capped at ${experiment.budgetEnvelope.maximumExternalSideEffects}`,
      // Deliberately untrusted — must not override experiment.riskClass.
      untrustedSuggestedRiskClass: "LOW",
      // Bindings travel with plan construction in the service, not model authority.
      ...({} as Record<string, never>),
    };
  }
}

/** Expose bindings helper for Fake model consumers. */
export function fakeAssumptionBindingsFor(
  experiment: GovernedExperiment,
): ExperimentAssumptionBinding[] {
  const assumptionId =
    experiment.sourceAssumptionIds[0] ?? "asm_unknown_material";
  return [
    {
      experimentId: experiment.experimentId,
      hypothesisId: `hyp_${experiment.experimentId}_primary`,
      assumptionId,
      expectedInformationContribution: "HIGH",
      ...(experiment.sourceScenarioSetId
        ? { scenarioSetId: experiment.sourceScenarioSetId }
        : {}),
      ...(experiment.sourceScenarioSetVersion !== undefined
        ? { scenarioSetVersion: experiment.sourceScenarioSetVersion }
        : {}),
    },
  ];
}
