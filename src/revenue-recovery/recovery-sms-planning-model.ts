/**
 * Planning model that proposes exactly one bounded SEND_RECOVERY_SMS step.
 * Targets name case/lead/template only — recipient resolves from the canonical lead.
 */
import { FakePlanningModel } from "../planning/fake-planning-model.js";
import type { PlanningContext } from "../planning/context.js";
import type { PlanningModelOutput } from "../planning/model.js";
import type { GapAnalysis, PlanProposal } from "../planning/proposal.js";
import { parsePlanProposal } from "../planning/proposal.js";
import { proposeBindingsForSteps } from "../planning/verification-bindings.js";

export const RECOVERY_SMS_POSTCONDITION =
  "Bounded recovery outreach attempt recorded";

export type RecoverySmsPlanBinding = {
  recoveryCaseId: string;
  leadId: string;
  templateId: string;
  templateVersion: number;
};

/**
 * Mutable binding object so Postgres suites can create the stack before the
 * RecoveryCase exists, then fill IDs before planning.
 */
export function createRecoverySmsPlanningModel(
  binding: RecoverySmsPlanBinding,
): FakePlanningModel {
  return new RecoverySmsPlanningModel(binding);
}

class RecoverySmsPlanningModel extends FakePlanningModel {
  constructor(private readonly binding: RecoverySmsPlanBinding) {
    super();
  }

  override async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    this.callCount += 1;
    if (
      !this.binding.recoveryCaseId ||
      !this.binding.leadId ||
      !this.binding.templateId
    ) {
      throw new Error(
        "Recovery SMS planning binding is incomplete — set case/lead/template before plan()",
      );
    }
    const steps: PlanProposal["steps"] = [
      {
        stepId: "step_recovery_sms",
        actionType: "SEND_RECOVERY_SMS",
        description: "Send one bounded recovery SMS to the canonical lead",
        targetIds: [
          `rr_case:${this.binding.recoveryCaseId}`,
          `rr_lead:${this.binding.leadId}`,
          `rr_template:${this.binding.templateId}@${this.binding.templateVersion}`,
        ],
        evidenceRefs: input.context.contextMetadata.selectedEvidenceIds.slice(
          0,
          2,
        ),
        dependsOn: [],
        preconditions: [
          "Recovery case is active and contact policy permits SMS",
        ],
        expectedPostconditions: [RECOVERY_SMS_POSTCONDITION],
        resourceEstimate: {
          durationMs: 20_000,
          tokenEstimate: 200,
          costEstimateUsd: 0.01,
        },
        risk: { level: "MEDIUM", categories: ["external-communication"] },
        validationChecks: [
          "Recovery attempt recorded against the bound template identity",
        ],
        rollbackStrategy: "NONE",
      },
    ];

    return {
      value: parsePlanProposal({
        gapAnalysis: input.gapAnalysis,
        workstreams: [
          {
            workstreamId: "ws_recovery",
            name: "Bounded recovery outreach",
            stepIds: ["step_recovery_sms"],
          },
        ],
        steps,
        successDefinition: [...input.context.objective.acceptanceCriteria],
        assumptions: [...input.gapAnalysis.assumptions],
        unknowns: [...input.gapAnalysis.unknowns],
        proposedRisks: ["Outreach cannot be recalled once delivered"],
        proposedVerificationChecks: [
          "Exactly one recovery attempt exists for the case",
        ],
        proposedRollbackApproach:
          "Outreach cannot be unsent; suppression stops further contact",
        proposedResourceTotals: {
          estimatedDurationMinutes: 1,
          estimatedLlmTokens: 500,
          estimatedApiCalls: 1,
          estimatedHumanMinutes: 2,
          estimatedCost: 0.02,
          maximumParallelWorkstreams: 1,
          estimatedLlmCalls: 1,
        },
        acceptanceCriterionVerificationBindings: proposeBindingsForSteps({
          acceptanceCriteria: input.context.objective.acceptanceCriteria,
          steps,
        }),
        conciseRationale:
          "One bounded outreach step whose recipient resolves from the canonical lead.",
      }),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}
