import {
  isTerminalApprovalRequestStatus,
  type ApprovalRequest,
} from "../domain/authorization/index.js";
import { approvalBindingKey } from "../domain/authorization/index.js";
import type { ApprovalRequestRepository } from "./approval-request-repository.js";
import { AuthorizationError } from "./errors.js";
import { hashDecisionNonce } from "./decision-card-hasher.js";

/**
 * Process-local authorization fence.
 *
 * Protects against duplicate pending requests, concurrent decisions, and
 * replayed / forged nonces. Durable implementations must use CAS/transactions
 * per approvalRequestId and binding key.
 */
export interface AuthorizationCoordinator {
  findActiveByBinding(bindingKey: string): Promise<ApprovalRequest | null>;
  registerPending(
    request: ApprovalRequest,
    bindingKey: string,
  ): Promise<void>;
  /**
   * Verify the submitted plaintext nonce against the stored hash, then
   * atomically mark it consumed (single use).
   */
  beginDecision(
    approvalRequestId: string,
    decisionNonce: string,
  ): Promise<{ nonceHash: string }>;
  completeDecision(approvalRequestId: string): Promise<void>;
  failDecision(approvalRequestId: string): Promise<void>;
  isNonceConsumed(approvalRequestId: string): Promise<boolean>;
  supersedePendingForRun(
    runId: string,
    exceptRequestId: string | null,
    reasonCode: string,
  ): Promise<readonly ApprovalRequest[]>;
  /** Invalidate nonce usability when a request becomes terminal without decide. */
  invalidateNonce(approvalRequestId: string): Promise<void>;
}

export class InMemoryAuthorizationCoordinator
  implements AuthorizationCoordinator
{
  private readonly pendingByBinding = new Map<string, string>();
  private readonly decisionLocks = new Set<string>();
  private readonly consumedNonces = new Set<string>();
  private readonly invalidatedNonces = new Set<string>();

  constructor(private readonly requests: ApprovalRequestRepository) {}

  async findActiveByBinding(
    bindingKey: string,
  ): Promise<ApprovalRequest | null> {
    const id = this.pendingByBinding.get(bindingKey);
    if (!id) {
      return null;
    }
    const request = await this.requests.getById(id);
    if (!request || request.status !== "PENDING") {
      this.pendingByBinding.delete(bindingKey);
      return null;
    }
    return request;
  }

  async registerPending(
    request: ApprovalRequest,
    bindingKey: string,
  ): Promise<void> {
    const existingId = this.pendingByBinding.get(bindingKey);
    if (existingId && existingId !== request.approvalRequestId) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_ALREADY_EXISTS",
        "A PENDING approval request already exists for this exact binding",
        { bindingKey, existingId },
      );
    }
    this.pendingByBinding.set(bindingKey, request.approvalRequestId);
  }

  async beginDecision(
    approvalRequestId: string,
    decisionNonce: string,
  ): Promise<{ nonceHash: string }> {
    if (this.decisionLocks.has(approvalRequestId)) {
      throw new AuthorizationError(
        "INVALID_AUTHORIZATION_STATE",
        `A decision is already in progress for ${approvalRequestId}`,
      );
    }

    const request = await this.requests.getById(approvalRequestId);
    if (!request) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_FOUND",
        `Unknown approval request: ${approvalRequestId}`,
      );
    }

    if (isTerminalApprovalRequestStatus(request.status)) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_PENDING",
        `Approval request is ${request.status}; nonce is invalid`,
        { approvalRequestId, status: request.status },
      );
    }

    if (request.status !== "PENDING") {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_PENDING",
        `Approval request is ${request.status}, expected PENDING`,
      );
    }

    if (
      this.invalidatedNonces.has(approvalRequestId) ||
      this.consumedNonces.has(approvalRequestId)
    ) {
      throw new AuthorizationError(
        "AUTHORIZATION_DECISION_REPLAYED",
        "Decision nonce was already consumed or invalidated",
        { approvalRequestId },
      );
    }

    const nonceHash = hashDecisionNonce(decisionNonce);
    if (nonceHash !== request.decisionNonceHash) {
      throw new AuthorizationError(
        "INVALID_DECISION_NONCE",
        "Submitted decision nonce does not match the system-issued nonce for this request",
        { approvalRequestId },
      );
    }

    this.decisionLocks.add(approvalRequestId);
    this.consumedNonces.add(approvalRequestId);
    return { nonceHash };
  }

  async completeDecision(approvalRequestId: string): Promise<void> {
    this.decisionLocks.delete(approvalRequestId);
    for (const [key, id] of this.pendingByBinding.entries()) {
      if (id === approvalRequestId) {
        this.pendingByBinding.delete(key);
      }
    }
  }

  async failDecision(approvalRequestId: string): Promise<void> {
    this.decisionLocks.delete(approvalRequestId);
    // Nonce remains consumed so a failed mid-flight attempt cannot be
    // replayed with the same nonce. A new ApprovalRequest is required.
  }

  async isNonceConsumed(approvalRequestId: string): Promise<boolean> {
    return (
      this.consumedNonces.has(approvalRequestId) ||
      this.invalidatedNonces.has(approvalRequestId)
    );
  }

  async invalidateNonce(approvalRequestId: string): Promise<void> {
    this.invalidatedNonces.add(approvalRequestId);
    this.decisionLocks.delete(approvalRequestId);
    for (const [key, id] of this.pendingByBinding.entries()) {
      if (id === approvalRequestId) {
        this.pendingByBinding.delete(key);
      }
    }
  }

  async supersedePendingForRun(
    runId: string,
    exceptRequestId: string | null,
    reasonCode: string,
  ): Promise<readonly ApprovalRequest[]> {
    const list = await this.requests.listByRun(runId);
    const superseded: ApprovalRequest[] = [];
    for (const request of list) {
      if (request.status !== "PENDING") {
        continue;
      }
      if (exceptRequestId && request.approvalRequestId === exceptRequestId) {
        continue;
      }
      const updated = await this.requests.updateStatus(
        request.approvalRequestId,
        "SUPERSEDED",
        { failureReasonCode: reasonCode },
      );
      await this.invalidateNonce(request.approvalRequestId);
      const key = approvalBindingKey({
        runId: request.runId,
        planId: request.planId,
        planVersion: request.planVersion,
        planHash: request.planHash,
        validationDecisionId: request.validationDecisionId,
        decisionCardHash: request.decisionCardHash,
      });
      if (this.pendingByBinding.get(key) === request.approvalRequestId) {
        this.pendingByBinding.delete(key);
      }
      superseded.push(updated);
    }
    return superseded;
  }
}
