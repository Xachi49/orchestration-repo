import type { AdmissionRequest } from "../../admission/request.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import type { PostgresOrchestratorStack } from "./stack.js";
import { FakeApprovalDeliveryService } from "../../authorization/delivery.js";

export interface ApprovedRunContext {
  runId: string;
  approvalRequestId: string;
  decisionNonce: string;
  request: AdmissionRequest;
}

export async function advanceToAwaitingApproval(
  stack: PostgresOrchestratorStack,
  request: AdmissionRequest,
): Promise<{ runId: string; approvalRequestId: string }> {
  const admitted = await stack.admission.admit(request);
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
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
  const decisionNonce = deliveredNonce(stack.approvalDelivery, approvalRequestId);
  const approved = await stack.humanAuthorization.decide({
    approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    decisionNonce,
    submittedAt: new Date().toISOString(),
    note: "postgres acceptance",
  });
  if (approved.result !== "APPROVED") {
    throw new Error(`expected APPROVED, got ${approved.result}`);
  }
  return { runId, approvalRequestId, decisionNonce, request };
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
