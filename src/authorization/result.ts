import type { PlanVersion } from "../domain/plan/execution-plan.js";
import type { RunState } from "../domain/run/run-state.js";

export type AuthorizationResultKind =
  | "APPROVED"
  | "REJECTED"
  | "MODIFICATION_REQUESTED"
  | "EXPIRED"
  | "BLOCKED"
  | "ALREADY_DECIDED"
  | "PENDING_APPROVAL";

export interface AuthorizationResult {
  runId: string;
  approvalRequestId?: string;
  planId: string;
  planVersion: PlanVersion;
  planHash: string;
  result: AuthorizationResultKind;
  authorizationRecordId?: string;
  requiresFurtherAction: boolean;
  runState: RunState;
  modificationRequestId?: string;
}

export type AuthorizationRoutingOutcome =
  | {
      outcome: "BLOCKED";
      runId: string;
      planId: string;
      planVersion: PlanVersion;
      planHash: string;
      validationDecisionId: string;
      runState: "BLOCKED";
    }
  | {
      outcome: "PENDING_APPROVAL";
      runId: string;
      planId: string;
      planVersion: PlanVersion;
      planHash: string;
      validationDecisionId: string;
      approvalRequestId: string;
      decisionCardHash: string;
      runState: "AWAITING_APPROVAL";
      /** Audit lineage when this request replaces a prior cancelled delivery. */
      replacesApprovalRequestId?: string;
    }
  | {
      outcome: "ALREADY_ROUTED";
      runId: string;
      planId: string;
      planVersion: PlanVersion;
      planHash: string;
      validationDecisionId: string;
      approvalRequestId?: string;
      runState: "AWAITING_APPROVAL" | "BLOCKED";
    };
