import type {
  ApprovalRequest,
  AuthorizationRecord,
} from "../domain/authorization/index.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";

/**
 * HISTORICAL APPROVAL != EFFECTIVE AUTHORITY.
 * SUPERSEDED PLAN AUTHORIZATION != EXECUTABLE AUTHORIZATION.
 *
 * Classifies a run's immutable Phase 6 history for callers that must refuse
 * to act while APPROVE authority could still be effective. This is not
 * execution readiness and never grants anything: an APPROVE is tolerated as
 * history only when a later decision exists and it is bound, consistently, to
 * a SUPERSEDED plan. Anything unresolvable is AMBIGUOUS, never harmless.
 */
export type HistoricalExecutionAuthority =
  | { kind: "NONE" }
  | {
      kind: "HISTORICAL_SUPERSEDED_APPROVE_ONLY";
      authorizationRecordIds: readonly string[];
      approvalRequestIds: readonly string[];
    }
  | {
      kind: "CURRENT_APPROVE";
      reasonCode:
        | "LATEST_AUTHORIZATION_APPROVE"
        | "APPROVE_BOUND_TO_NON_SUPERSEDED_PLAN";
      authorizationRecordId: string;
      approvalRequestId: string;
    }
  | {
      kind: "AMBIGUOUS";
      reasonCode:
        | "FOREIGN_RUN_HISTORY"
        | "APPROVE_WITHOUT_APPROVED_REQUEST"
        | "APPROVED_REQUEST_WITHOUT_APPROVE_RECORD"
        | "APPROVAL_BINDING_INCONSISTENT"
        | "APPROVED_PLAN_MISSING"
        | "APPROVED_PLAN_DUPLICATE"
        | "APPROVED_PLAN_BINDING_INCONSISTENT";
      authorizationRecordId?: string;
      approvalRequestId?: string;
    };

export function assessHistoricalExecutionAuthority(input: {
  runId: string;
  /** Complete append-only history, oldest first (`listByRun`). */
  authorizationRecords: readonly AuthorizationRecord[];
  approvalRequests: readonly ApprovalRequest[];
  plans: readonly StoredPlanRecord[];
}): HistoricalExecutionAuthority {
  const { runId, authorizationRecords, approvalRequests, plans } = input;

  const foreignRecord = authorizationRecords.find((r) => r.runId !== runId);
  if (foreignRecord) {
    return {
      kind: "AMBIGUOUS",
      reasonCode: "FOREIGN_RUN_HISTORY",
      authorizationRecordId: foreignRecord.authorizationRecordId,
    };
  }
  const foreignRequest = approvalRequests.find((q) => q.runId !== runId);
  if (foreignRequest) {
    return {
      kind: "AMBIGUOUS",
      reasonCode: "FOREIGN_RUN_HISTORY",
      approvalRequestId: foreignRequest.approvalRequestId,
    };
  }
  if (plans.some((p) => p.runId !== runId)) {
    return { kind: "AMBIGUOUS", reasonCode: "FOREIGN_RUN_HISTORY" };
  }

  // Phase 7 binds authority through the latest record only.
  const latest = authorizationRecords[authorizationRecords.length - 1];
  if (latest?.decision === "APPROVE") {
    return {
      kind: "CURRENT_APPROVE",
      reasonCode: "LATEST_AUTHORIZATION_APPROVE",
      authorizationRecordId: latest.authorizationRecordId,
      approvalRequestId: latest.approvalRequestId,
    };
  }

  const pairs: { record: AuthorizationRecord; request: ApprovalRequest }[] = [];
  for (const record of authorizationRecords) {
    if (record.decision !== "APPROVE") continue;
    const matches = approvalRequests.filter(
      (q) => q.approvalRequestId === record.approvalRequestId,
    );
    if (matches.length !== 1 || matches[0]!.status !== "APPROVED") {
      return {
        kind: "AMBIGUOUS",
        reasonCode: "APPROVE_WITHOUT_APPROVED_REQUEST",
        authorizationRecordId: record.authorizationRecordId,
        approvalRequestId: record.approvalRequestId,
      };
    }
    pairs.push({ record, request: matches[0]! });
  }
  for (const request of approvalRequests) {
    if (request.status !== "APPROVED") continue;
    const matches = authorizationRecords.filter(
      (r) => r.approvalRequestId === request.approvalRequestId,
    );
    if (matches.length !== 1 || matches[0]!.decision !== "APPROVE") {
      return {
        kind: "AMBIGUOUS",
        reasonCode: "APPROVED_REQUEST_WITHOUT_APPROVE_RECORD",
        approvalRequestId: request.approvalRequestId,
      };
    }
  }

  for (const { record, request } of pairs) {
    const ids = {
      authorizationRecordId: record.authorizationRecordId,
      approvalRequestId: request.approvalRequestId,
    };
    if (
      request.planId !== record.planId ||
      request.planVersion !== record.planVersion ||
      request.planHash !== record.planHash ||
      request.objectiveId !== record.objectiveId ||
      request.objectiveVersion !== record.objectiveVersion ||
      request.validationDecisionId !== record.validationDecisionId
    ) {
      return {
        kind: "AMBIGUOUS",
        reasonCode: "APPROVAL_BINDING_INCONSISTENT",
        ...ids,
      };
    }
    const planMatches = plans.filter((p) => p.planId === record.planId);
    if (planMatches.length === 0) {
      return { kind: "AMBIGUOUS", reasonCode: "APPROVED_PLAN_MISSING", ...ids };
    }
    if (planMatches.length > 1) {
      return { kind: "AMBIGUOUS", reasonCode: "APPROVED_PLAN_DUPLICATE", ...ids };
    }
    const plan = planMatches[0]!;
    if (
      plan.planVersion !== record.planVersion ||
      plan.planHash !== record.planHash ||
      plan.plan.planHash !== record.planHash
    ) {
      return {
        kind: "AMBIGUOUS",
        reasonCode: "APPROVED_PLAN_BINDING_INCONSISTENT",
        ...ids,
      };
    }
    if (plan.status !== "SUPERSEDED") {
      return {
        kind: "CURRENT_APPROVE",
        reasonCode: "APPROVE_BOUND_TO_NON_SUPERSEDED_PLAN",
        ...ids,
      };
    }
  }

  if (pairs.length === 0) return { kind: "NONE" };
  return {
    kind: "HISTORICAL_SUPERSEDED_APPROVE_ONLY",
    authorizationRecordIds: pairs.map((p) => p.record.authorizationRecordId),
    approvalRequestIds: pairs.map((p) => p.request.approvalRequestId),
  };
}
