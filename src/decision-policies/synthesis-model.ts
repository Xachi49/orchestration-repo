import type { DecisionContext } from "./context.js";
import type { DecisionRule } from "./rules.js";
import { mintDecisionRuleId } from "./rules.js";

/**
 * Model may propose candidate rules — DATA only until deterministically validated.
 * Model may NOT determine authorization, truth, activation, governance, or execution.
 */
export interface DecisionPolicySynthesisProposal {
  rules: DecisionRule[];
  defaultActionId: string;
  objectiveWeights: Record<string, number>;
  notes: string[];
}

export interface DecisionPolicySynthesisModel {
  readonly modelId: string;
  readonly modelVersion: string;
  synthesize(input: {
    context: DecisionContext;
    sourcePromotedCausalClaimIds?: readonly string[];
  }): Promise<DecisionPolicySynthesisProposal>;
}

export class FakeDecisionPolicySynthesisModel
  implements DecisionPolicySynthesisModel
{
  readonly modelId = "fake_decision_policy_synth_v1";
  readonly modelVersion = "1";

  async synthesize(input: {
    context: DecisionContext;
    sourcePromotedCausalClaimIds?: readonly string[];
  }): Promise<DecisionPolicySynthesisProposal> {
    const numericVar =
      input.context.stateVariables.find((v) => v.unit !== "DIMENSIONLESS") ??
      input.context.stateVariables[0]!;
    const action =
      input.context.eligibleActions.find((a) => a.actionClass !== "NO_ACTION") ??
      input.context.eligibleActions[0]!;
    const defaultAction =
      input.context.eligibleActions.find((a) => a.actionClass === "NO_ACTION") ??
      input.context.eligibleActions[0]!;

    const predicate = {
      op: "GTE" as const,
      variableId: numericVar.variableId,
      value: input.context.materialityThreshold,
    };
    const claimIds = [...(input.sourcePromotedCausalClaimIds ?? [])];
    const rule: DecisionRule = {
      decisionRuleId: mintDecisionRuleId({
        actionId: action.actionId,
        predicate,
        priority: 10,
      }),
      name: "fake_threshold_rule",
      predicate,
      actionId: action.actionId,
      priority: 10,
      evidenceRefs: claimIds.length ? [] : ["heuristic_synth_v1"],
      promotedCausalClaimIds: claimIds,
      confidence: "MEDIUM",
      limitations: [
        "MODEL-SUGGESTED_RULE != AUTHORIZED_RULE",
        "Fake synthesis output is DATA until validated",
      ],
      heuristicOnly: claimIds.length === 0,
      uncertainty: { kind: "QUALITATIVE", notes: "Fake model — no precision" },
    };

    const weights: Record<string, number> = {};
    for (const obj of input.context.optimizationObjectives) {
      weights[obj.objectiveId] = obj.weight;
    }

    return {
      rules: [rule],
      defaultActionId: defaultAction.actionId,
      objectiveWeights: weights,
      notes: [
        "FakeDecisionPolicySynthesisModel proposes DATA only",
        "Model cannot authorize, activate, or execute",
      ],
    };
  }
}
