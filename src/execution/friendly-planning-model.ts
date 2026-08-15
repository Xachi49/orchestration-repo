import { FakePlanningModel } from "../planning/fake-planning-model.js";
import {
  parsePlanProposal,
  type PlanProposal,
  type GapAnalysis,
} from "../planning/proposal.js";
import type { PlanningContext } from "../planning/context.js";
import type {
  PlanningModelOutput,
  PlanningModelTokenUsage,
} from "../planning/model.js";
import { proposeBindingsForSteps } from "../planning/verification-bindings.js";

export interface ExecutionFriendlyPlanningOptions {
  /**
   * When true, step_patch authorizes a compensating CREATE_TASK step that is
   * not in any workstream (rollback-only).
   */
  withAuthorizedRollback?: boolean;
}

/**
 * Planning helper for Phase 7 execution tests.
 * Emits only Phase 7-supported actions (no READ_FILE).
 */
export function createExecutionFriendlyPlanningModel(
  options?: ExecutionFriendlyPlanningOptions,
): FakePlanningModel {
  return new ExecutionFriendlyPlanningModel(options);
}

class ExecutionFriendlyPlanningModel extends FakePlanningModel {
  constructor(private readonly options?: ExecutionFriendlyPlanningOptions) {
    super();
  }

  override async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    this.callCount += 1;
    const evidenceRefs =
      input.context.contextMetadata.selectedEvidenceIds.slice(0, 2);
    const withRollback = this.options?.withAuthorizedRollback === true;

    const steps: PlanProposal["steps"] = [
      {
        stepId: "step_patch",
        actionType: "CREATE_LOCAL_PATCH",
        description: "Create a local patch for the objective",
        targetIds: ["src/example.ts"],
        evidenceRefs,
        dependsOn: [],
        preconditions: ["Verified repository context available"],
        expectedPostconditions: ["Local patch artifact prepared"],
        resourceEstimate: {
          durationMs: 180_000,
          tokenEstimate: 2_000,
          costEstimateUsd: 0.05,
        },
        risk: { level: "MEDIUM", categories: ["local-mutation"] },
        validationChecks: ["Patch artifact is contained under run storage"],
        rollbackStrategy: withRollback ? "COMPENSATING_ACTION" : "MANUAL",
        ...(withRollback
          ? {
              compensatingStepIds: ["step_discard"],
              rollbackInstructions: [
                "Record discard task via authorized compensating step",
              ],
            }
          : {
              rollbackInstructions: ["Discard local patch artifact"],
            }),
      },
      {
        stepId: "step_test",
        actionType: "RUN_TESTS",
        description: "Run registered unit tests",
        targetIds: ["UNIT_TESTS"],
        evidenceRefs,
        dependsOn: ["step_patch"],
        preconditions: ["Patch prepared"],
        expectedPostconditions: ["Registered test profile executed"],
        resourceEstimate: {
          durationMs: 300_000,
          tokenEstimate: 500,
          costEstimateUsd: 0.02,
        },
        risk: { level: "LOW", categories: ["verification"] },
        validationChecks: ["Test profile exits successfully"],
        rollbackStrategy: "NONE",
      },
    ];

    if (withRollback) {
      steps.push({
        stepId: "step_discard",
        actionType: "CREATE_TASK",
        description: "Record discard of failed local patch",
        targetIds: ["workspace"],
        evidenceRefs,
        dependsOn: [],
        preconditions: ["Authorized compensating rollback triggered"],
        expectedPostconditions: ["Discard task recorded"],
        resourceEstimate: {
          durationMs: 5_000,
          tokenEstimate: 100,
          costEstimateUsd: 0.01,
        },
        risk: { level: "LOW", categories: ["rollback"] },
        validationChecks: ["Task artifact created under run storage"],
        rollbackStrategy: "NONE",
      });
    }

    const value = parsePlanProposal({
      gapAnalysis: input.gapAnalysis,
      workstreams: [
        {
          workstreamId: "ws_exec",
          name: "Bounded execution delivery",
          stepIds: ["step_patch", "step_test"],
        },
      ],
      steps,
      successDefinition: [...input.context.objective.acceptanceCriteria],
      assumptions: [...input.gapAnalysis.assumptions],
      unknowns: [...input.gapAnalysis.unknowns],
      proposedRisks: ["Local patch may require human review before merge"],
      proposedVerificationChecks: ["Run registered tests", "Review patch"],
      proposedRollbackApproach: withRollback
        ? "Execute authorized compensating CREATE_TASK discard step"
        : "Discard local patch artifact",
      proposedResourceTotals: {
        estimatedDurationMinutes: 12,
        estimatedLlmTokens: 3_000,
        estimatedApiCalls: 2,
        estimatedHumanMinutes: 8,
        estimatedCost: 0.08,
        maximumParallelWorkstreams: 1,
        estimatedLlmCalls: 2,
      },
      acceptanceCriterionVerificationBindings: proposeBindingsForSteps({
        acceptanceCriteria: input.context.objective.acceptanceCriteria,
        steps,
      }),
      conciseRationale:
        "Execution-friendly proposal using only Phase 7 actuator actions.",
    });
    const usage: PlanningModelTokenUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    };
    return { value, usage };
  }
}
