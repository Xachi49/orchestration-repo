import type { ExperimentPlan } from "./plan.js";
import type { PlanningModel, PlanningModelOutput } from "../planning/model.js";
import type { PlanningContext } from "../planning/context.js";
import {
  type ExperimentPlanningProvenanceDeps,
  planningContextIdentity,
  resolveVerifiedExperimentPlanningOrigin,
} from "./planning-provenance.js";
import {
  parsePlanProposal,
  type GapAnalysis,
  type PlanProposal,
  type ProposedAcceptanceCriterionVerificationBinding,
  type ProposedStep,
} from "../planning/proposal.js";
import { normalizeCriterionText } from "../domain/objective/criterion-identity.js";

/** Canonical experiment acceptance criteria — bound via STEP_POSTCONDITION only. */
export const EXPERIMENT_MEASUREMENT_CRITERION =
  "Experiment measurements collected under plan hash binding";

export const EXPERIMENT_PHASE8_CRITERION =
  "Phase 8 verification required before authoritative evidence";

export const EXPERIMENT_ACCEPTANCE_CRITERIA = [
  EXPERIMENT_MEASUREMENT_CRITERION,
  EXPERIMENT_PHASE8_CRITERION,
] as const;

export interface ExperimentObjectiveConstraints {
  experimentId: string;
  experimentPlanHash: string;
}

export function parseExperimentObjectiveConstraints(
  constraints: readonly string[],
): ExperimentObjectiveConstraints | null {
  let experimentId: string | undefined;
  let experimentPlanHash: string | undefined;
  for (const constraint of constraints) {
    if (constraint.startsWith("experimentId=")) {
      experimentId = constraint.slice("experimentId=".length);
    }
    if (constraint.startsWith("experimentPlanHash=")) {
      experimentPlanHash = constraint.slice("experimentPlanHash=".length);
    }
  }
  if (!experimentId || !experimentPlanHash) {
    return null;
  }
  return { experimentId, experimentPlanHash };
}

export function compileExperimentAcceptanceCriteria(
  _plan: Pick<ExperimentPlan, "experimentPlanHash">,
): readonly string[] {
  return EXPERIMENT_ACCEPTANCE_CRITERIA;
}

export function experimentExecutionStepIds(experimentPlanHash: string): {
  measure: string;
  verify: string;
} {
  const suffix = experimentPlanHash.slice(0, 12);
  return {
    measure: `step_exp_${suffix}_measure`,
    verify: `step_exp_${suffix}_verify`,
  };
}

/**
 * Deterministic bounded execution steps for compiled experiment Objectives.
 * Postconditions match canonical acceptance criteria exactly for STEP_POSTCONDITION binding.
 */
export function compileExperimentExecutionSteps(
  experimentPlanHash: string,
): ProposedStep[] {
  const stepIds = experimentExecutionStepIds(experimentPlanHash);
  return [
    {
      stepId: stepIds.measure,
      actionType: "CREATE_LOCAL_PATCH",
      description: `Collect bounded experiment measurements under plan ${experimentPlanHash.slice(0, 12)}`,
      targetIds: ["experiment-measurements"],
      evidenceRefs: [],
      dependsOn: [],
      preconditions: [
        `Authorized experiment plan hash ${experimentPlanHash} bound`,
      ],
      expectedPostconditions: [EXPERIMENT_MEASUREMENT_CRITERION],
      resourceEstimate: {
        durationMs: 180_000,
        tokenEstimate: 2_000,
        costEstimateUsd: 0.05,
      },
      risk: { level: "MEDIUM", categories: ["experiment-measurement"] },
      validationChecks: [
        `Measurements bound to experimentPlanHash=${experimentPlanHash}`,
      ],
      rollbackStrategy: "MANUAL",
      rollbackInstructions: ["Discard experiment measurement artifact"],
    },
    {
      stepId: stepIds.verify,
      actionType: "RUN_TESTS",
      description: "Execute bounded verification before authoritative evidence",
      targetIds: ["UNIT_TESTS"],
      evidenceRefs: [],
      dependsOn: [stepIds.measure],
      preconditions: [EXPERIMENT_MEASUREMENT_CRITERION],
      expectedPostconditions: [EXPERIMENT_PHASE8_CRITERION],
      resourceEstimate: {
        durationMs: 300_000,
        tokenEstimate: 500,
        costEstimateUsd: 0.02,
      },
      risk: { level: "LOW", categories: ["experiment-verification"] },
      validationChecks: [
        "Phase 8 outcome verification record required before evidence",
      ],
      rollbackStrategy: "NONE",
    },
  ];
}

/**
 * Explicit verification bindings derived from experiment plan hash and step postconditions.
 * No heuristic inference — every criterion maps to a STEP_POSTCONDITION on a bound step.
 */
export function compileExperimentVerificationBindings(input: {
  acceptanceCriteria: readonly string[];
  steps: readonly ProposedStep[];
}): ProposedAcceptanceCriterionVerificationBinding[] {
  const stepByPostcondition = new Map<string, ProposedStep>();
  for (const step of input.steps) {
    for (const postcondition of step.expectedPostconditions) {
      stepByPostcondition.set(normalizeCriterionText(postcondition), step);
    }
  }

  const bindings: ProposedAcceptanceCriterionVerificationBinding[] = [];
  for (const criterionText of input.acceptanceCriteria) {
    const step = stepByPostcondition.get(normalizeCriterionText(criterionText));
    if (!step) {
      continue;
    }
    bindings.push({
      criterionText,
      verificationMethod: "STEP_POSTCONDITION",
      stepIds: [step.stepId],
      postconditionTexts: [criterionText],
      verificationCheckTexts: step.validationChecks.slice(0, 1),
      requireAll: true,
    });
  }
  return bindings;
}

export function buildExperimentPlanProposal(input: {
  context: PlanningContext;
  gapAnalysis: GapAnalysis;
  plan: ExperimentPlan;
}): PlanProposal {
  const steps = compileExperimentExecutionSteps(input.plan.experimentPlanHash);
  const acceptanceCriteria = input.context.objective.acceptanceCriteria;
  return parsePlanProposal({
    gapAnalysis: input.gapAnalysis,
    workstreams: [
      {
        workstreamId: `ws_exp_${input.plan.experimentPlanHash.slice(0, 8)}`,
        name: "Bounded experiment execution",
        stepIds: steps.map((step) => step.stepId),
      },
    ],
    steps,
    successDefinition: [...acceptanceCriteria],
    assumptions: [...input.gapAnalysis.assumptions],
    unknowns: [...input.gapAnalysis.unknowns],
    proposedRisks: ["Experiment measurements may require Phase 8 verification"],
    proposedVerificationChecks: [
      "Collect measurements under plan hash binding",
      "Require Phase 8 verification before evidence",
    ],
    proposedRollbackApproach: "Discard experiment measurement artifacts",
    proposedResourceTotals: {
      estimatedDurationMinutes: 12,
      estimatedLlmTokens: 3_000,
      estimatedApiCalls: 2,
      estimatedHumanMinutes: 8,
      estimatedCost: 0.08,
      maximumParallelWorkstreams: 1,
      estimatedLlmCalls: 2,
    },
    acceptanceCriterionVerificationBindings: compileExperimentVerificationBindings(
      {
        acceptanceCriteria,
        steps,
      },
    ),
    conciseRationale:
      "Deterministic experiment execution proposal with explicit verification bindings.",
  });
}

/**
 * Delegates to the inner model unless durable ExperimentExecutionLineage verifies origin.
 */
export function createExperimentAwarePlanningModel(
  delegate: PlanningModel,
  provenance: ExperimentPlanningProvenanceDeps,
): PlanningModel {
  return new ExperimentAwarePlanningModel(delegate, provenance);
}

class ExperimentAwarePlanningModel implements PlanningModel {
  constructor(
    private readonly delegate: PlanningModel,
    private readonly provenance: ExperimentPlanningProvenanceDeps,
  ) {}

  get provider(): string {
    return this.delegate.provider;
  }

  get modelId(): string {
    return this.delegate.modelId;
  }

  get toolsEnabled(): false {
    return false;
  }

  async analyzeGaps(input: {
    context: PlanningContext;
    promptVersion: string;
  }): Promise<PlanningModelOutput<GapAnalysis>> {
    return this.delegate.analyzeGaps(input);
  }

  async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    const origin = await resolveVerifiedExperimentPlanningOrigin(
      this.provenance,
      planningContextIdentity(input.context),
    );
    if (!origin) {
      return this.delegate.proposePlan(input);
    }

    const value = buildExperimentPlanProposal({
      context: input.context,
      gapAnalysis: input.gapAnalysis,
      plan: origin.plan,
    });
    return {
      value,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
    };
  }
}
