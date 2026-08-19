import type { ApprovalDecisionCard, ApprovalRequest } from "../domain/authorization/index.js";
import type { OutboxMessage } from "../domain/durability/index.js";
import type { RunRepository } from "../admission/run-repository.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { ApprovalRequestRepository } from "./approval-request-repository.js";
import type { AuthorizationCoordinator } from "./coordinator.js";
import type { ApprovalDeliveryService } from "./delivery.js";
import { AuthorizationError } from "./errors.js";
import type { PostgresInbox } from "../infrastructure/postgres/inbox.js";
import type { PostgresTransactionalOutbox } from "../infrastructure/postgres/outbox.js";
import type { OutboxConsumer } from "../infrastructure/postgres/outbox.js";
import type { TransactionManager } from "../durability/transaction.js";
import { withOptionalTransaction } from "../durability/transaction.js";
import { createHash } from "node:crypto";
import type { ApprovalDeliverySecretStore } from "./delivery-secret-store.js";
import { assertNotInTransaction } from "../durability/transaction.js";

export const APPROVAL_DELIVERY_EVENT = "APPROVAL_DELIVERY_REQUESTED";

export interface ApprovalDeliveryOutboxPayload {
  approvalRequestId: string;
  runId: string;
  projectId: string;
  bindingKey: string;
  card: ApprovalDecisionCard;
}

/**
 * Delivers approval requests outside database transactions.
 * Uses inbox dedup so at-least-once outbox delivery does not duplicate effects.
 */
export class ApprovalDeliveryOutboxConsumer implements OutboxConsumer {
  constructor(
    private readonly deps: {
      delivery: ApprovalDeliveryService;
      requests: ApprovalRequestRepository;
      coordinator: AuthorizationCoordinator;
      runs: RunRepository;
      events?: never;
      inbox?: PostgresInbox;
      deliverySecrets?: ApprovalDeliverySecretStore;
      transactions?: TransactionManager;
      clockNowIso: () => string;
    },
  ) {}

  async consume(message: OutboxMessage): Promise<void> {
    if (message.eventType !== APPROVAL_DELIVERY_EVENT) {
      return;
    }
    const payload = message.payload as ApprovalDeliveryOutboxPayload;
    const inboxKey = `${message.outboxId}:${payload.approvalRequestId}`;
    if (this.deps.inbox) {
      const received = await this.deps.inbox.receive({
        messageId: inboxKey,
        consumerName: "approval-delivery",
        payload: { approvalRequestId: payload.approvalRequestId },
      });
      if (
        received.duplicate &&
        received.record.processedAt &&
        received.record.resultFingerprint
      ) {
        return;
      }
    }

    const request = await this.deps.requests.getById(payload.approvalRequestId);
    if (!request || request.status !== "PENDING") {
      return;
    }

    const decisionNonce =
      (await this.deps.deliverySecrets?.revealPending(
        payload.approvalRequestId,
      )) ?? null;
    if (!decisionNonce) {
      throw new AuthorizationError(
        "APPROVAL_DELIVERY_FAILED",
        "Missing or already consumed approval delivery secret",
        { approvalRequestId: payload.approvalRequestId },
      );
    }

    try {
      assertNotInTransaction("ApprovalDeliveryService");
      await this.deps.delivery.deliverApprovalRequest({
        request,
        card: payload.card,
        decisionNonce,
      });
      await this.deps.deliverySecrets?.markDelivered(payload.approvalRequestId);
    } catch (error) {
      await withOptionalTransaction(this.deps.transactions, async () => {
        await this.deps.requests.updateStatus(payload.approvalRequestId, "CANCELLED", {
          deliveryFailedAt: this.deps.clockNowIso(),
          deliveryFailureCode: "APPROVAL_DELIVERY_FAILED",
          failureReasonCode: "APPROVAL_DELIVERY_FAILED",
        });
        await this.deps.coordinator.invalidateNonce(payload.approvalRequestId);
        await this.deps.deliverySecrets?.invalidate(payload.approvalRequestId);
      });
      if (this.deps.inbox) {
        await this.deps.inbox.complete({
          messageId: inboxKey,
          consumerName: "approval-delivery",
          resultFingerprint: "DELIVERY_FAILED",
        });
      }
      throw error instanceof AuthorizationError
        ? error
        : new AuthorizationError(
            "APPROVAL_DELIVERY_FAILED",
            error instanceof Error ? error.message : "Delivery failed",
            { approvalRequestId: payload.approvalRequestId },
          );
    }

    await withOptionalTransaction(this.deps.transactions, async () => {
      const live = await this.deps.requests.getById(payload.approvalRequestId);
      if (!live || live.status !== "PENDING") {
        return;
      }
      await this.deps.coordinator.registerPending(live, payload.bindingKey);
      const run = await this.deps.runs.getById(payload.runId);
      if (run && run.state !== "AWAITING_APPROVAL") {
        await commitRunTransition(
          this.deps.runs,
          run,
          "AWAITING_APPROVAL",
          this.deps.clockNowIso(),
        );
      }
    });

    if (this.deps.inbox) {
      await this.deps.inbox.complete({
        messageId: inboxKey,
        consumerName: "approval-delivery",
        resultFingerprint: createHash("sha256")
          .update(`${payload.approvalRequestId}:delivered`)
          .digest("hex"),
      });
    }
  }
}

export function createApprovalDeliveryDispatcher(input: {
  outbox: PostgresTransactionalOutbox;
  inbox: PostgresInbox;
  ownerId: string;
  consumer: ApprovalDeliveryOutboxConsumer;
}) {
  return {
    async dispatchOnce(limit = 10) {
      const claimed = await input.outbox.claimBatch({
        ownerId: input.ownerId,
        limit,
      });
      let delivered = 0;
      let failed = 0;
      for (const message of claimed) {
        try {
          await input.consumer.consume(message);
          await input.outbox.markDelivered(
            message.outboxId,
            input.ownerId,
            message.fenceToken ?? 0,
          );
          delivered += 1;
        } catch {
          await input.outbox.markFailed(
            message.outboxId,
            input.ownerId,
            message.fenceToken ?? 0,
          );
          failed += 1;
        }
      }
      return { delivered, failed };
    },
  };
}
