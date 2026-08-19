import type {
  ApprovalDecisionCard,
  ApprovalRequest,
} from "../domain/authorization/index.js";
import { AuthorizationError } from "./errors.js";
import { assertNotInTransaction } from "../durability/transaction.js";

/**
 * Provider-neutral out-of-band approval delivery.
 * Ordinary AI/model conversation is NOT an approval channel.
 *
 * The system-issued decision nonce is delivered through this surface and
 * must not be persisted in plaintext on the ApprovalRequest.
 */
export interface ApprovalDeliveryService {
  deliverApprovalRequest(input: {
    request: ApprovalRequest;
    card: ApprovalDecisionCard;
    decisionNonce: string;
  }): Promise<void>;
  cancelApprovalRequest(approvalRequestId: string): Promise<void>;
}

export class FakeApprovalDeliveryService implements ApprovalDeliveryService {
  readonly delivered: Array<{
    approvalRequestId: string;
    decisionCardHash: string;
    decisionNonce: string;
  }> = [];
  readonly cancelled: string[] = [];
  private readonly nonceByRequest = new Map<string, string>();
  private failNext = false;
  private failAlways = false;

  failNextDelivery(): void {
    this.failNext = true;
  }

  setFailAlways(fail: boolean): void {
    this.failAlways = fail;
  }

  /** Test helper: plaintext nonce last delivered for a request. */
  nonceFor(approvalRequestId: string): string | undefined {
    return this.nonceByRequest.get(approvalRequestId);
  }

  async deliverApprovalRequest(input: {
    request: ApprovalRequest;
    card: ApprovalDecisionCard;
    decisionNonce: string;
  }): Promise<void> {
    assertNotInTransaction("ApprovalDeliveryService");
    if (this.failAlways || this.failNext) {
      this.failNext = false;
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        "Fake delivery failed",
        { approvalRequestId: input.request.approvalRequestId },
      );
    }
    this.delivered.push({
      approvalRequestId: input.request.approvalRequestId,
      decisionCardHash: input.request.decisionCardHash,
      decisionNonce: input.decisionNonce,
    });
    this.nonceByRequest.set(
      input.request.approvalRequestId,
      input.decisionNonce,
    );
  }

  async cancelApprovalRequest(approvalRequestId: string): Promise<void> {
    this.cancelled.push(approvalRequestId);
  }
}

/** Unconnected placeholder — Discord/Slack must not enter domain logic. */
export class DisconnectedApprovalDeliveryService
  implements ApprovalDeliveryService
{
  async deliverApprovalRequest(): Promise<void> {
    throw new AuthorizationError(
      "APPROVAL_DELIVERY_FAILED",
      "No out-of-band approval delivery provider is connected",
    );
  }

  async cancelApprovalRequest(): Promise<void> {
    // no-op
  }
}
