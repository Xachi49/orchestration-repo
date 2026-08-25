import type { ProgramState } from "../programs/program-state.js";
import type { ProgramSchedulerWorkKind } from "./work-kind.js";

/**
 * Maps Program durable state to next Phase 14 scheduler work kinds.
 * AWAITING_MATERIALIZATION_APPROVAL yields only ROUTE_PROGRAM_MATERIALIZATION
 * (never MATERIALIZE_PROGRAM) — human gate.
 */
export function candidateProgramWorkKinds(
  status: ProgramState,
  paused: boolean,
): readonly ProgramSchedulerWorkKind[] {
  if (paused) {
    return [];
  }
  switch (status) {
    case "ADMITTED":
    case "DECOMPOSING":
      return ["DECOMPOSE_PROGRAM"];
    case "DECOMPOSED":
    case "VALIDATING":
      return ["VALIDATE_PROGRAM"];
    case "AWAITING_MATERIALIZATION_APPROVAL":
      return ["ROUTE_PROGRAM_MATERIALIZATION"];
    case "MATERIALIZING":
      return ["MATERIALIZE_PROGRAM"];
    case "ACTIVE":
      return ["RECONCILE_PROGRAM", "VERIFY_PROGRAM"];
    case "VERIFYING":
      return ["VERIFY_PROGRAM"];
    default:
      return [];
  }
}

export function programWorkBindingHash(input: {
  workKind: ProgramSchedulerWorkKind;
  programId: string;
  programVersion: number;
  delegationEnvelopeHash: string;
  policyBundleHash: string;
  capabilitySetFingerprint: string;
  programPlanVersion?: number;
  programPlanHash?: string;
  materializationSubjectHash?: string;
  budgetAllocationFingerprint?: string;
}): string {
  switch (input.workKind) {
    case "DECOMPOSE_PROGRAM":
      return `decompose:${input.programId}:${input.programVersion}:${input.delegationEnvelopeHash}:${input.policyBundleHash}:${input.capabilitySetFingerprint}`;
    case "VALIDATE_PROGRAM":
      return `validate:${input.programId}:${input.programPlanVersion ?? 0}:${input.programPlanHash ?? "none"}`;
    case "ROUTE_PROGRAM_MATERIALIZATION":
      return `route_mat:${input.programId}:${input.programPlanVersion ?? 0}:${input.programPlanHash ?? "none"}:${input.delegationEnvelopeHash}`;
    case "MATERIALIZE_PROGRAM":
      return `materialize:${input.programId}:${input.materializationSubjectHash ?? "none"}:${input.programPlanHash ?? "none"}:${input.budgetAllocationFingerprint ?? "none"}`;
    case "RECONCILE_PROGRAM":
      return `reconcile:${input.programId}:${input.programPlanVersion ?? 0}:${input.programPlanHash ?? "none"}`;
    case "VERIFY_PROGRAM":
      return `verify_prog:${input.programId}:${input.programPlanVersion ?? 0}:${input.programPlanHash ?? "none"}`;
    default: {
      const _exhaustive: never = input.workKind;
      return _exhaustive;
    }
  }
}
