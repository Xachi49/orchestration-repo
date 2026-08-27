import type { ExperimentState } from "../experiments/experiment-state.js";
import type { ExperimentSchedulerWorkKind } from "../scheduling/work-kind.js";

/**
 * Maps experiment durable state to Phase 17 scheduler work kinds.
 * AWAITING_EXECUTION_AUTHORIZATION is a Phase 6 human gate — no auto work.
 */
export function candidateExperimentWorkKinds(
  status: ExperimentState,
): readonly ExperimentSchedulerWorkKind[] {
  switch (status) {
    case "ADMITTED":
    case "DESIGNING":
      return ["DESIGN_EXPERIMENT"];
    case "PLANNED":
    case "VALIDATING":
      return ["VALIDATE_EXPERIMENT"];
    case "AWAITING_AUTHORIZATION":
      return ["ROUTE_EXPERIMENT_AUTHORIZATION"];
    case "AUTHORIZED":
      return ["COMPILE_EXPERIMENT_EXECUTION"];
    case "AWAITING_EXECUTION_AUTHORIZATION":
      return [];
    case "EXECUTING":
      return ["RECONCILE_EXPERIMENT"];
    case "VERIFYING":
      return [
        "VERIFY_EXPERIMENT",
        "BUILD_EVIDENCE_BUNDLE",
        "PROPOSE_ASSUMPTION_UPDATE",
      ];
    default:
      return [];
  }
}

export function experimentWorkBindingHash(input: {
  workKind: ExperimentSchedulerWorkKind;
  experimentId: string;
  experimentVersion: number;
  policyBundleFingerprint: string;
  capabilitySetFingerprint: string;
  truthSnapshotFingerprint?: string;
  experimentPlanVersion?: number;
  experimentPlanHash?: string;
}): string {
  switch (input.workKind) {
    case "DESIGN_EXPERIMENT":
      return `design_exp:${input.experimentId}:${input.experimentVersion}:${input.policyBundleFingerprint}:${input.capabilitySetFingerprint}`;
    case "VALIDATE_EXPERIMENT":
      return `validate_exp:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    case "ROUTE_EXPERIMENT_AUTHORIZATION":
      return `route_eaux:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    case "COMPILE_EXPERIMENT_EXECUTION":
      return `compile_exp:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    case "RECONCILE_EXPERIMENT":
      return `reconcile_exp:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    case "VERIFY_EXPERIMENT":
      return `verify_exp:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    case "BUILD_EVIDENCE_BUNDLE":
      return `eeb_exp:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    case "PROPOSE_ASSUMPTION_UPDATE":
      return `aeuc_exp:${input.experimentId}:${input.experimentPlanHash ?? "none"}`;
    default: {
      const _exhaustive: never = input.workKind;
      return _exhaustive;
    }
  }
}
