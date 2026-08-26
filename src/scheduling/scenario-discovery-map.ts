import type { DecisionProblemState } from "../scenarios/decision-state.js";
import type { ScenarioSchedulerWorkKind } from "../scheduling/work-kind.js";

/**
 * Maps decision problem durable state to Phase 16 scheduler work kinds.
 * AWAITING_SELECTION yields only ROUTE_STRATEGY_SELECTION — human gate.
 */
export function candidateScenarioWorkKinds(
  status: DecisionProblemState,
): readonly ScenarioSchedulerWorkKind[] {
  switch (status) {
    case "ADMITTED":
      return ["GROUND_DECISION_PROBLEM"];
    case "GROUNDING":
      return ["GENERATE_SCENARIOS"];
    case "SCENARIOS_PROPOSED":
      return ["SIMULATE_SCENARIOS"];
    case "SIMULATING":
      return ["SIMULATE_SCENARIOS", "ANALYZE_SCENARIOS"];
    case "ANALYZING":
      return ["ANALYZE_SCENARIOS"];
    case "VALIDATING":
      return ["VALIDATE_DECISION_PACKAGE"];
    case "AWAITING_SELECTION":
      return ["ROUTE_STRATEGY_SELECTION"];
    case "SELECTED":
      return ["MATERIALIZE_PORTFOLIO_PROPOSAL"];
    case "STALE":
      return ["GROUND_DECISION_PROBLEM"];
    default:
      return [];
  }
}

export function scenarioWorkBindingHash(input: {
  workKind: ScenarioSchedulerWorkKind;
  decisionProblemId: string;
  decisionProblemVersion: number;
  policyBundleFingerprint: string;
  capabilitySetFingerprint: string;
  truthSnapshotFingerprint?: string;
  scenarioSetVersion?: number;
  scenarioSetHash?: string;
  decisionPackageHash?: string;
}): string {
  switch (input.workKind) {
    case "GROUND_DECISION_PROBLEM":
      return `ground_sdp:${input.decisionProblemId}:${input.decisionProblemVersion}:${input.policyBundleFingerprint}:${input.capabilitySetFingerprint}`;
    case "GENERATE_SCENARIOS":
      return `gen_scn:${input.decisionProblemId}:${input.truthSnapshotFingerprint ?? "none"}`;
    case "SIMULATE_SCENARIOS":
      return `sim_scn:${input.decisionProblemId}:${input.scenarioSetHash ?? "none"}`;
    case "ANALYZE_SCENARIOS":
      return `analyze_scn:${input.decisionProblemId}:${input.scenarioSetHash ?? "none"}`;
    case "VALIDATE_DECISION_PACKAGE":
      return `validate_sdpkg:${input.decisionProblemId}:${input.scenarioSetHash ?? "none"}`;
    case "ROUTE_STRATEGY_SELECTION":
      return `route_ssel:${input.decisionProblemId}:${input.decisionPackageHash ?? "none"}`;
    case "MATERIALIZE_PORTFOLIO_PROPOSAL":
      return `mat_pfo_prop:${input.decisionProblemId}:${input.decisionPackageHash ?? "none"}`;
    default: {
      const _exhaustive: never = input.workKind;
      return _exhaustive;
    }
  }
}
