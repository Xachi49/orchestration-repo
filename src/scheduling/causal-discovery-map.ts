import type { CausalQuestionState } from "../causal/causal-state.js";
import type { CausalSchedulerWorkKind } from "../scheduling/work-kind.js";

/**
 * Maps causal question durable state to Phase 18 scheduler work kinds.
 * AWAITING_CAUSAL_REVIEW is a human gate — only ROUTE_CAUSAL_REVIEW.
 */
export function candidateCausalWorkKinds(
  status: CausalQuestionState,
): readonly CausalSchedulerWorkKind[] {
  switch (status) {
    case "ADMITTED":
      return ["PROPOSE_CAUSAL_GRAPH"];
    case "GRAPH_PROPOSED":
      return ["ANALYZE_IDENTIFICATION"];
    case "IDENTIFICATION_ANALYSIS":
      return ["ANALYZE_IDENTIFICATION"];
    case "ESTIMATING":
      return ["ESTIMATE_CAUSAL_EFFECT"];
    case "SYNTHESIZING":
      return ["SYNTHESIZE_CAUSAL_EVIDENCE"];
    case "VALIDATING":
      return ["VALIDATE_CAUSAL_CLAIM"];
    case "AWAITING_CAUSAL_REVIEW":
      return ["ROUTE_CAUSAL_REVIEW"];
    case "REVIEWED":
      return ["PROMOTE_CAUSAL_CLAIM", "PROPOSE_MODEL_CALIBRATION"];
    default:
      return [];
  }
}

export function causalWorkBindingHash(input: {
  workKind: CausalSchedulerWorkKind;
  causalQuestionId: string;
  causalQuestionVersion: number;
  graphHash?: string;
  identificationFingerprint?: string;
  claimHash?: string;
}): string {
  switch (input.workKind) {
    case "PROPOSE_CAUSAL_GRAPH":
      return `propose_cg:${input.causalQuestionId}:${input.causalQuestionVersion}`;
    case "ANALYZE_IDENTIFICATION":
      return `identify_cg:${input.causalQuestionId}:${input.graphHash ?? "none"}`;
    case "ESTIMATE_CAUSAL_EFFECT":
      return `estimate_cg:${input.causalQuestionId}:${input.identificationFingerprint ?? "none"}`;
    case "SYNTHESIZE_CAUSAL_EVIDENCE":
      return `synthesize_cg:${input.causalQuestionId}:${input.identificationFingerprint ?? "none"}`;
    case "VALIDATE_CAUSAL_CLAIM":
      return `validate_cg:${input.causalQuestionId}:${input.identificationFingerprint ?? "none"}`;
    case "ROUTE_CAUSAL_REVIEW":
      return `route_crr:${input.causalQuestionId}:${input.claimHash ?? "none"}`;
    case "PROMOTE_CAUSAL_CLAIM":
      return `promote_cg:${input.causalQuestionId}:${input.claimHash ?? "none"}`;
    case "PROPOSE_MODEL_CALIBRATION":
      return `calibrate_cg:${input.causalQuestionId}:${input.claimHash ?? "none"}`;
    default: {
      const _exhaustive: never = input.workKind;
      return _exhaustive;
    }
  }
}
