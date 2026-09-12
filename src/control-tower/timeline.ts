import type { RunState } from "../domain/run/run-state.js";

export type TimelineStageId =
  | "ADMISSION"
  | "REPOSITORY_TRUTH"
  | "PLANNING"
  | "VALIDATION"
  | "AUTHORIZATION"
  | "EXECUTION"
  | "VERIFICATION"
  | "COMPLETION";

export type TimelineUiStatus =
  | "NOT_STARTED"
  | "IN_PROGRESS"
  | "SUCCESS"
  | "AWAITING_ACTION"
  | "FAILED"
  | "BLOCKED";

export type TimelineStageView = {
  stageId: TimelineStageId;
  label: string;
  status: TimelineUiStatus;
};

const FAILED: ReadonlySet<RunState> = new Set([
  "ADMISSION_REJECTED",
  "REJECTED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
  "SUPERSEDED",
  "CONTAINED",
]);

const BLOCKED: ReadonlySet<RunState> = new Set([
  "BLOCKED",
  "ESCALATED",
  "ROLLBACK_REQUIRED",
]);

/**
 * Derive timeline UI from canonical run state only.
 * Does not invent APPROVED from PASS, VERIFIED from EXECUTION_SUCCEEDED,
 * or COMPLETED without CompletionRecord (caller must pass hasCompletion).
 */
export function deriveRunTimeline(input: {
  state: RunState;
  hasCompletion: boolean;
}): TimelineStageView[] {
  const { state, hasCompletion } = input;
  const failed = FAILED.has(state);
  const blocked = BLOCKED.has(state);

  const stage = (
    stageId: TimelineStageId,
    label: string,
    status: TimelineUiStatus,
  ): TimelineStageView => ({ stageId, label, status });

  if (state === "RECEIVED") {
    return [
      stage("ADMISSION", "Admission", "IN_PROGRESS"),
      stage("REPOSITORY_TRUTH", "Repository Truth", "NOT_STARTED"),
      stage("PLANNING", "Planning", "NOT_STARTED"),
      stage("VALIDATION", "Validation", "NOT_STARTED"),
      stage("AUTHORIZATION", "Authorization", "NOT_STARTED"),
      stage("EXECUTION", "Execution", "NOT_STARTED"),
      stage("VERIFICATION", "Verification", "NOT_STARTED"),
      stage("COMPLETION", "Completion", "NOT_STARTED"),
    ];
  }

  if (state === "ADMISSION_REJECTED") {
    return [
      stage("ADMISSION", "Admission", "FAILED"),
      stage("REPOSITORY_TRUTH", "Repository Truth", "NOT_STARTED"),
      stage("PLANNING", "Planning", "NOT_STARTED"),
      stage("VALIDATION", "Validation", "NOT_STARTED"),
      stage("AUTHORIZATION", "Authorization", "NOT_STARTED"),
      stage("EXECUTION", "Execution", "NOT_STARTED"),
      stage("VERIFICATION", "Verification", "NOT_STARTED"),
      stage("COMPLETION", "Completion", "NOT_STARTED"),
    ];
  }

  const afterAdmission = rank(state) >= rank("ADMITTED");
  const afterIngest = rank(state) >= rank("PLANNING") || state === "INGESTING";
  const ingesting = state === "INGESTING";
  const planning = state === "PLANNING" || state === "REVISING";
  const afterPlan = rank(state) >= rank("VALIDATING");
  const validating = state === "VALIDATING";
  const awaiting = state === "AWAITING_APPROVAL";
  const afterAuth = rank(state) >= rank("APPROVED");
  const executing = state === "EXECUTING";
  const afterExec = rank(state) >= rank("VERIFYING");
  const verifying = state === "VERIFYING";
  const completed = state === "COMPLETED" && hasCompletion;

  return [
    stage(
      "ADMISSION",
      "Admission",
      afterAdmission ? "SUCCESS" : failed && !afterAdmission ? "FAILED" : "IN_PROGRESS",
    ),
    stage(
      "REPOSITORY_TRUTH",
      "Repository Truth",
      ingesting
        ? "IN_PROGRESS"
        : afterPlan || planning || afterIngest
          ? "SUCCESS"
          : blocked
            ? "BLOCKED"
            : "NOT_STARTED",
    ),
    stage(
      "PLANNING",
      "Planning",
      planning
        ? "IN_PROGRESS"
        : afterPlan
          ? "SUCCESS"
          : blocked && afterIngest
            ? "BLOCKED"
            : "NOT_STARTED",
    ),
    stage(
      "VALIDATION",
      "Validation",
      validating
        ? "IN_PROGRESS"
        : awaiting || afterAuth
          ? "SUCCESS"
          : blocked && afterPlan
            ? "BLOCKED"
            : "NOT_STARTED",
    ),
    stage(
      "AUTHORIZATION",
      "Authorization",
      awaiting
        ? "AWAITING_ACTION"
        : afterAuth
          ? "SUCCESS"
          : state === "REJECTED"
            ? "FAILED"
            : "NOT_STARTED",
    ),
    stage(
      "EXECUTION",
      "Execution",
      executing
        ? "IN_PROGRESS"
        : afterExec
          ? "SUCCESS"
          : failed && afterAuth
            ? "FAILED"
            : blocked && afterAuth
              ? "BLOCKED"
              : "NOT_STARTED",
    ),
    stage(
      "VERIFICATION",
      "Verification",
      verifying
        ? "IN_PROGRESS"
        : completed || (state === "COMPLETED" && !hasCompletion)
          ? hasCompletion
            ? "SUCCESS"
            : "IN_PROGRESS"
          : failed && afterExec
            ? "FAILED"
            : "NOT_STARTED",
    ),
    stage(
      "COMPLETION",
      "Completion",
      completed
        ? "SUCCESS"
        : state === "COMPLETED" && !hasCompletion
          ? "IN_PROGRESS"
          : "NOT_STARTED",
    ),
  ];
}

function rank(state: RunState): number {
  const order: RunState[] = [
    "RECEIVED",
    "ADMITTED",
    "INGESTING",
    "PLANNING",
    "VALIDATING",
    "AWAITING_APPROVAL",
    "APPROVED",
    "EXECUTING",
    "VERIFYING",
    "COMPLETED",
  ];
  const idx = order.indexOf(state);
  return idx === -1 ? -1 : idx;
}
