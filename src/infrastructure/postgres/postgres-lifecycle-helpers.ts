import type { AdmissionRequest } from "../../admission/request.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import type { PostgresOrchestratorStack } from "./stack.js";
import {
  FakeApprovalDeliveryService,
  type ApprovalDeliveryService,
} from "../../authorization/delivery.js";

export interface ApprovedRunContext {
  runId: string;
  approvalRequestId: string;
  decisionNonce: string;
  request: AdmissionRequest;
}

function assertFakeApprovalDelivery(
  delivery: ApprovalDeliveryService,
): FakeApprovalDeliveryService {
  if (!(delivery instanceof FakeApprovalDeliveryService)) {
    throw new Error(
      "postgres lifecycle helpers require FakeApprovalDeliveryService (TEST only)",
    );
  }
  return delivery;
}

export async function advanceToAwaitingApproval(
  stack: PostgresOrchestratorStack,
  request: AdmissionRequest,
): Promise<{ runId: string; approvalRequestId: string }> {
  const admitted = await stack.admission.admit(request);
  if (admitted.outcome !== "ADMITTED") {
    const detail =
      admitted.outcome === "CONFLICT" || admitted.outcome === "REJECTED"
        ? ` reasonCode=${admitted.reasonCode} message=${admitted.message}`
        : admitted.outcome === "ACTIVE_DUPLICATE" ||
            admitted.outcome === "COMPLETED_DUPLICATE"
          ? ` runId=${admitted.runId} idempotencyKey=${admitted.idempotencyKey}`
          : "";
    throw new Error(
      `expected ADMITTED, got ${admitted.outcome}${detail} ` +
        `(projectId=${request.projectId} objectiveId=${request.objectiveId} ` +
        `objectiveVersion=${request.objectiveVersion} ` +
        `requestedEnvironment=${request.requestedEnvironment})`,
    );
  }
  const runId = admitted.runId!;
  await stack.ingestion.ingest(runId, request.projectId, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  const routed = await stack.authorizationRouting.route(runId);
  if (routed.outcome !== "PENDING_APPROVAL") {
    throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
  }
  return { runId, approvalRequestId: routed.approvalRequestId };
}

export function deliveredNonce(
  delivery: FakeApprovalDeliveryService,
  approvalRequestId: string,
): string {
  const nonce = delivery.nonceFor(approvalRequestId);
  if (!nonce) {
    throw new Error(`no delivered nonce for ${approvalRequestId}`);
  }
  return nonce;
}

export async function advanceToApprovedRun(
  stack: PostgresOrchestratorStack,
  request: AdmissionRequest,
): Promise<ApprovedRunContext> {
  const { runId, approvalRequestId } = await advanceToAwaitingApproval(
    stack,
    request,
  );
  return approveAwaitingRun(stack, {
    runId,
    approvalRequestId,
    request,
  });
}

/**
 * Complete Phase6 approval for a run already at AWAITING_APPROVAL.
 * Does not re-admit — avoids ACTIVE_DUPLICATE on the same logical objective.
 */
export async function approveAwaitingRun(
  stack: PostgresOrchestratorStack,
  awaiting: {
    runId: string;
    approvalRequestId: string;
    request: AdmissionRequest;
  },
): Promise<ApprovedRunContext> {
  const decisionNonce = deliveredNonce(
    assertFakeApprovalDelivery(stack.approvalDelivery),
    awaiting.approvalRequestId,
  );
  const approved = await stack.humanAuthorization.decide({
    approvalRequestId: awaiting.approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    decisionNonce,
    // Must follow the stack clock — wall-clock submittedAt expires MutableClock
    // approval windows (e.g. RR fixtures anchored on RR_MONDAY_IN_WINDOW).
    submittedAt: stack.clock.nowIso(),
    note: "postgres acceptance",
  });
  if (approved.result !== "APPROVED") {
    throw new Error(`expected APPROVED, got ${approved.result}`);
  }
  return {
    runId: awaiting.runId,
    approvalRequestId: awaiting.approvalRequestId,
    decisionNonce,
    request: awaiting.request,
  };
}

export async function advanceToExecuting(
  stack: PostgresOrchestratorStack,
  request: AdmissionRequest,
) {
  const ctx = await advanceToApprovedRun(stack, request);
  await stack.execution.execute(ctx.runId);
  return ctx;
}

export async function advanceToCompletedRun(
  stack: PostgresOrchestratorStack,
  request: AdmissionRequest,
) {
  const ctx = await advanceToExecuting(stack, request);
  await stack.verification.verify(ctx.runId);
  return ctx;
}
