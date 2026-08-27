import type { RunState } from "../domain/run/run-state.js";
import { isTerminalRunState } from "../domain/run/run-state.js";
import type { SchedulerWorkKind } from "./work-kind.js";

/**
 * Deterministic mapping from durable Run state (+ known artifacts) to
 * candidate next work kinds. Does not invent illegal transitions.
 *
 * HUMAN APPROVAL BARRIER: AWAITING_APPROVAL yields no EXECUTE_PLAN and no
 * autonomous approval. ROUTE_AUTHORIZATION only creates the approval request.
 */
export interface DiscoveryContext {
  runState: RunState;
  hasVerifiedRepository?: boolean;
  hasPlan?: boolean;
  hasValidationPassOrApprovalRequired?: boolean;
  hasAuthorizationRecord?: boolean;
  hasExecutionTerminalForVerification?: boolean;
  hasCompletionRecord?: boolean;
  hasLearned?: boolean;
  hasObservabilitySnapshot?: boolean;
}

/**
 * Run states from which `candidateWorkKinds` can yield work. Discovery scans
 * only these, so polling stays bounded and terminal or in-flight runs are never
 * re-examined. AWAITING_APPROVAL is absent: waiting on a human yields no work.
 */
export const DISCOVERABLE_RUN_STATES = [
  "ADMITTED",
  "INGESTING",
  "VALIDATING",
  "REVISING",
  "APPROVED",
  "EXECUTING",
  "COMPLETED",
] as const satisfies readonly RunState[];

export function candidateWorkKinds(
  context: DiscoveryContext,
): readonly SchedulerWorkKind[] {
  const { runState } = context;
  // Terminal states yield no work. COMPLETED is the sole exception: learning
  // and observability still run after a run finishes.
  if (isTerminalRunState(runState) && runState !== "COMPLETED") {
    return [];
  }
  // Non-terminal states awaiting human or recovery action. CONTAINED is
  // terminal and already excluded above.
  if (
    runState === "BLOCKED" ||
    runState === "ESCALATED" ||
    runState === "ROLLBACK_REQUIRED"
  ) {
    return [];
  }

  switch (runState) {
    case "ADMITTED":
      return ["INGEST_REPOSITORY"];
    case "INGESTING":
      return context.hasVerifiedRepository ? ["PLAN_RUN"] : [];
    case "PLANNING":
      // In-flight planning; coordinator owns progress.
      return [];
    case "VALIDATING":
      if (!context.hasValidationPassOrApprovalRequired) {
        return context.hasPlan ? ["VALIDATE_PLAN"] : [];
      }
      // Validation terminal (PASS / HUMAN_APPROVAL_REQUIRED) → route to human gate.
      // Not approval — creates ApprovalRequest and AWAITING_APPROVAL only.
      return ["ROUTE_AUTHORIZATION"];
    case "REVISING":
      return context.hasPlan ? ["VALIDATE_PLAN"] : ["PLAN_RUN"];
    case "AWAITING_APPROVAL":
      // CRITICAL: no autonomous execution / approval work.
      return [];
    case "APPROVED":
      return ["EXECUTE_PLAN"];
    case "EXECUTING":
      return context.hasExecutionTerminalForVerification
        ? ["VERIFY_OUTCOME"]
        : [];
    case "VERIFYING":
      // In-flight verification.
      return [];
    case "COMPLETED": {
      const kinds: SchedulerWorkKind[] = [];
      if (!context.hasLearned) {
        kinds.push("LEARN_FROM_RUN");
      }
      if (!context.hasObservabilitySnapshot) {
        kinds.push("BUILD_OBSERVABILITY");
      }
      return kinds;
    }
    case "RECEIVED":
      // Not yet admitted; admission owns the next move.
      return [];
    default: {
      // Terminal states are excluded above; any remaining state is a new
      // non-terminal state that must be mapped explicitly.
      const _exhaustive: never = runState;
      return _exhaustive;
    }
  }
}

/**
 * Binding hash for a work kind given known durable fingerprints.
 * Stale work is rejected when live binding differs.
 */
export function bindingHashForWorkKind(
  kind: SchedulerWorkKind,
  fingerprints: {
    repositoryFingerprint?: string;
    planVersion?: number;
    planHash?: string;
    authorizationRecordId?: string;
    validationDecisionId?: string;
    executionAttemptId?: string;
    completionRecordId?: string;
    runId: string;
  },
): string {
  switch (kind) {
    case "INGEST_REPOSITORY":
      return `ingest:${fingerprints.runId}`;
    case "PLAN_RUN":
      return `plan:${fingerprints.repositoryFingerprint ?? "none"}`;
    case "VALIDATE_PLAN":
      return `validate:${fingerprints.planVersion ?? 0}:${fingerprints.planHash ?? "none"}`;
    case "ROUTE_AUTHORIZATION":
      return `route:${fingerprints.validationDecisionId ?? "none"}:${fingerprints.planHash ?? "none"}`;
    case "EXECUTE_PLAN":
      return `execute:${fingerprints.authorizationRecordId ?? "none"}:${fingerprints.planHash ?? "none"}`;
    case "VERIFY_OUTCOME":
      return `verify:${fingerprints.executionAttemptId ?? "none"}`;
    case "LEARN_FROM_RUN":
      return `learn:${fingerprints.completionRecordId ?? "none"}`;
    case "BUILD_OBSERVABILITY":
      return `observe:${fingerprints.runId}:${fingerprints.completionRecordId ?? "none"}`;
    case "DECOMPOSE_PROGRAM":
    case "VALIDATE_PROGRAM":
    case "ROUTE_PROGRAM_MATERIALIZATION":
    case "MATERIALIZE_PROGRAM":
    case "RECONCILE_PROGRAM":
    case "VERIFY_PROGRAM":
      // Program work uses programWorkBindingHash; this path is fail-closed.
      return `program_misbound:${kind}:${fingerprints.runId}`;
    case "ANALYZE_PORTFOLIO":
    case "PLAN_PORTFOLIO":
    case "VALIDATE_PORTFOLIO":
    case "ROUTE_PORTFOLIO_AUTHORIZATION":
    case "MATERIALIZE_PORTFOLIO_PROGRAMS":
    case "RECONCILE_PORTFOLIO":
    case "VERIFY_PORTFOLIO":
    case "REBALANCE_PORTFOLIO":
      // Portfolio work uses portfolioWorkBindingHash; this path is fail-closed.
      return `portfolio_misbound:${kind}:${fingerprints.runId}`;
    case "GROUND_DECISION_PROBLEM":
    case "GENERATE_SCENARIOS":
    case "SIMULATE_SCENARIOS":
    case "ANALYZE_SCENARIOS":
    case "VALIDATE_DECISION_PACKAGE":
    case "ROUTE_STRATEGY_SELECTION":
    case "MATERIALIZE_PORTFOLIO_PROPOSAL":
      // Scenario work uses scenarioWorkBindingHash; this path is fail-closed.
      return `scenario_misbound:${kind}:${fingerprints.runId}`;
    case "DESIGN_EXPERIMENT":
    case "VALIDATE_EXPERIMENT":
    case "ROUTE_EXPERIMENT_AUTHORIZATION":
    case "COMPILE_EXPERIMENT_EXECUTION":
    case "RECONCILE_EXPERIMENT":
    case "VERIFY_EXPERIMENT":
    case "BUILD_EVIDENCE_BUNDLE":
    case "PROPOSE_ASSUMPTION_UPDATE":
      // Experiment work uses experimentWorkBindingHash; this path is fail-closed.
      return `experiment_misbound:${kind}:${fingerprints.runId}`;
    case "PROPOSE_CAUSAL_GRAPH":
    case "ANALYZE_IDENTIFICATION":
    case "ESTIMATE_CAUSAL_EFFECT":
    case "SYNTHESIZE_CAUSAL_EVIDENCE":
    case "VALIDATE_CAUSAL_CLAIM":
    case "ROUTE_CAUSAL_REVIEW":
    case "PROMOTE_CAUSAL_CLAIM":
    case "PROPOSE_MODEL_CALIBRATION":
      // Causal work uses causalWorkBindingHash; this path is fail-closed.
      return `causal_misbound:${kind}:${fingerprints.runId}`;
    case "SYNTHESIZE_DECISION_POLICY":
    case "VALIDATE_DECISION_POLICY":
    case "EVALUATE_DECISION_POLICY":
    case "ROUTE_POLICY_APPROVAL":
    case "RUN_POLICY_SHADOW":
    case "EVALUATE_POLICY_SHADOW":
    case "ROUTE_POLICY_ACTIVATION":
    case "GENERATE_DECISION_RECOMMENDATION":
    case "PROPOSE_POLICY_REVISION":
      return `decision_policy_misbound:${kind}:${fingerprints.runId}`;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
