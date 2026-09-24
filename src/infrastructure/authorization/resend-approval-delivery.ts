/**
 * Resend-backed out-of-band approval delivery.
 *
 * EMAIL RECEIVED != APPROVED
 * DELIVERY != AUTHORIZATION
 * FAKE DELIVERY != PRODUCTION DELIVERY
 *
 * Delivers decision card summary + plaintext decision nonce to an operator
 * inbox. Never auto-approves. Never embeds approve/reject links or nonce URLs.
 * Does not send customer recovery outreach.
 */
import type {
  ApprovalDecisionCard,
  ApprovalRequest,
} from "../../domain/authorization/index.js";
import type { ApprovalDeliveryService } from "../../authorization/delivery.js";
import { AuthorizationError } from "../../authorization/errors.js";
import { assertNotInTransaction } from "../../durability/transaction.js";

export const APPROVAL_DELIVERY_IDEMPOTENCY_PREFIX = "approval-delivery:v1:";

export type ApprovalResendTransport = {
  sendEmail(input: {
    apiKey: string;
    from: string;
    to: string;
    subject: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ id: string }>;
};

/** HTTP transport for Resend emails API — approval delivery only. */
export const defaultApprovalResendTransport: ApprovalResendTransport = {
  async sendEmail(input) {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": input.idempotencyKey,
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
      }),
    });
    if (!response.ok) {
      const bodyLength = (await response.text()).length;
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        `Resend approval delivery failed with status ${response.status}`,
        { status: response.status, bodyLength },
      );
    }
    const json = (await response.json()) as { id?: string };
    if (!json.id) {
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        "Resend approval delivery response missing id",
      );
    }
    return { id: json.id };
  },
};

export function approvalDeliveryIdempotencyKey(
  approvalRequestId: string,
): string {
  return `${APPROVAL_DELIVERY_IDEMPOTENCY_PREFIX}${approvalRequestId}`;
}

/**
 * Builds operator-facing email text. Includes plaintext nonce for human decide.
 * Callers must not log the returned string (contains nonce).
 */
export function buildApprovalDeliveryEmailText(input: {
  request: ApprovalRequest;
  card: ApprovalDecisionCard;
  decisionNonce: string;
}): string {
  const { request, card, decisionNonce } = input;
  const actions = card.proposedActions
    .map(
      (step) =>
        `- ${step.stepId}: ${step.actionType} — ${step.description}`,
    )
    .join("\n");
  const findings =
    card.approvalEligibleFindingSummaries.length > 0
      ? card.approvalEligibleFindingSummaries.map((s) => `- ${s}`).join("\n")
      : "- (none)";
  const approvers = request.requestedApproverIds.join(", ");

  return [
    "Orchestrator Phase 6 human authorization request",
    "",
    "EMAIL RECEIVED != APPROVED",
    "This message only delivers the decision card and one-time decision nonce.",
    "Approve or reject only via POST /v1/approval-requests/{id}/decision.",
    "Do not reply to this email to authorize.",
    "",
    `approvalRequestId: ${request.approvalRequestId}`,
    `projectId: ${request.projectId}`,
    `runId: ${request.runId}`,
    `planId: ${request.planId}`,
    `planVersion: ${request.planVersion}`,
    `planHash: ${request.planHash}`,
    `validationDecisionId: ${request.validationDecisionId}`,
    `validationDecision: ${request.validationDecision}`,
    `requestReason: ${request.requestReason}`,
    `requestedApproverIds: ${approvers}`,
    `expiresAt: ${request.expiresAt}`,
    `decisionCardHash: ${request.decisionCardHash}`,
    "",
    "Why approval is required:",
    card.whyApprovalRequired,
    "",
    "Objective:",
    `${card.objectiveId} v${card.objectiveVersion} — ${card.objectiveOutcome}`,
    "",
    "Proposed actions:",
    actions || "- (none)",
    "",
    "Approval-eligible finding summaries:",
    findings,
    "",
    "Decision nonce (one-time; present with your APPROVE/REJECT decision):",
    decisionNonce,
    "",
    "Do not share this nonce. It is not stored in plaintext by the orchestrator.",
  ].join("\n");
}

export interface ResendApprovalDeliveryServiceOptions {
  apiKey: string;
  from: string;
  to: string;
  transport?: ApprovalResendTransport;
}

/**
 * Production approval delivery via Resend.
 * Zero authorization authority. Never falls back to Fake.
 */
export class ResendApprovalDeliveryService implements ApprovalDeliveryService {
  readonly provider = "resend" as const;
  /** Non-secret last successful provider message ids (tests/observability). */
  readonly deliveredMessageIds: Array<{
    approvalRequestId: string;
    providerMessageId: string;
    idempotencyKey: string;
  }> = [];
  readonly cancelled: string[] = [];
  private readonly apiKey: string;
  private readonly from: string;
  private readonly to: string;
  private readonly transport: ApprovalResendTransport;

  constructor(options: ResendApprovalDeliveryServiceOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        "RESEND_API_KEY is required for Resend approval delivery",
      );
    }
    this.apiKey = apiKey;
    this.from = options.from.trim();
    this.to = options.to.trim();
    this.transport = options.transport ?? defaultApprovalResendTransport;
  }

  async deliverApprovalRequest(input: {
    request: ApprovalRequest;
    card: ApprovalDecisionCard;
    decisionNonce: string;
  }): Promise<void> {
    assertNotInTransaction("ApprovalDeliveryService");
    const idempotencyKey = approvalDeliveryIdempotencyKey(
      input.request.approvalRequestId,
    );
    // Build text with nonce; never assign to a logged field.
    const text = buildApprovalDeliveryEmailText(input);
    try {
      const result = await this.transport.sendEmail({
        apiKey: this.apiKey,
        from: this.from,
        to: this.to,
        subject: `Approval required: ${input.request.approvalRequestId}`,
        text,
        idempotencyKey,
      });
      this.deliveredMessageIds.push({
        approvalRequestId: input.request.approvalRequestId,
        providerMessageId: result.id,
        idempotencyKey,
      });
    } catch (error) {
      if (error instanceof AuthorizationError) {
        throw error;
      }
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        error instanceof Error
          ? error.message
          : "Resend approval delivery failed",
        { approvalRequestId: input.request.approvalRequestId },
      );
    }
  }

  async cancelApprovalRequest(approvalRequestId: string): Promise<void> {
    this.cancelled.push(approvalRequestId);
  }
}
