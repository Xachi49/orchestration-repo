import type { DecisionPolicyState } from "../decision-policies/policy-state.js";
import type { SchedulerWorkKind } from "./work-kind.js";
import { createHash } from "node:crypto";

/**
 * AWAITING_APPROVAL / AWAITING_ACTIVATION are human gates.
 * Producer materializes routing work only — never decides.
 */
export function candidateDecisionPolicyWorkKinds(
  status: DecisionPolicyState,
): readonly SchedulerWorkKind[] {
  switch (status) {
    case "DRAFT":
      return ["SYNTHESIZE_DECISION_POLICY"];
    case "SYNTHESIZED":
      return ["VALIDATE_DECISION_POLICY"];
    case "VALIDATED":
      return ["EVALUATE_DECISION_POLICY"];
    case "AWAITING_APPROVAL":
      return ["ROUTE_POLICY_APPROVAL"];
    case "APPROVED_FOR_SHADOW":
      return ["RUN_POLICY_SHADOW"];
    case "SHADOW_RUNNING":
      return ["EVALUATE_POLICY_SHADOW"];
    case "AWAITING_ACTIVATION":
      return ["ROUTE_POLICY_ACTIVATION"];
    case "ACTIVE":
      return ["GENERATE_DECISION_RECOMMENDATION"];
    case "PAUSED":
      return ["PROPOSE_POLICY_REVISION"];
    default:
      return [];
  }
}

export function decisionPolicyWorkBindingHash(input: {
  workKind: SchedulerWorkKind;
  decisionPolicyId: string;
  decisionPolicyVersion: number;
  policyHash: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}
