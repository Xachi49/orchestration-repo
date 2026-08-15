import {
  isTerminalApprovalRequestStatus,
  parseApprovalRequest,
  type ApprovalRequest,
} from "../domain/authorization/index.js";
import type { PlanVersion } from "../domain/plan/execution-plan.js";
import { AuthorizationError } from "./errors.js";

/** Status/audit fields that may change after creation. Binding fields may not. */
export type ApprovalRequestStatusExtras = Partial<
  Pick<
    ApprovalRequest,
    "deliveryFailedAt" | "deliveryFailureCode" | "failureReasonCode"
  >
>;

export interface ApprovalRequestRepository {
  save(request: ApprovalRequest): Promise<ApprovalRequest>;
  getById(approvalRequestId: string): Promise<ApprovalRequest | null>;
  getPendingByRun(runId: string): Promise<ApprovalRequest | null>;
  getByPlanVersion(
    runId: string,
    planId: string,
    planVersion: PlanVersion,
  ): Promise<ApprovalRequest | null>;
  exists(approvalRequestId: string): Promise<boolean>;
  listByRun(runId: string): Promise<readonly ApprovalRequest[]>;
  /** Optional full scan for expiry sweeps (in-memory). */
  listAll?(): Promise<readonly ApprovalRequest[]>;
  /**
   * Status-only transition. Binding fields (including expiresAt,
   * decisionCardHash, decisionNonceHash) are immutable.
   * Terminal statuses cannot return to PENDING.
   */
  updateStatus(
    approvalRequestId: string,
    status: ApprovalRequest["status"],
    extras?: ApprovalRequestStatusExtras,
  ): Promise<ApprovalRequest>;
}

/**
 * In-memory approval request store.
 * At most one PENDING request per exact plan binding is enforced by the
 * AuthorizationCoordinator; this repository stores history.
 * Durable implementations must use CAS/transactions.
 */
export class InMemoryApprovalRequestRepository
  implements ApprovalRequestRepository
{
  private readonly byId = new Map<string, ApprovalRequest>();
  private readonly orderByRun = new Map<string, string[]>();

  async save(request: ApprovalRequest): Promise<ApprovalRequest> {
    const parsed = parseApprovalRequest(request);
    if (this.byId.has(parsed.approvalRequestId)) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_ALREADY_EXISTS",
        `Approval request already exists: ${parsed.approvalRequestId}`,
      );
    }
    this.byId.set(parsed.approvalRequestId, parsed);
    const order = this.orderByRun.get(parsed.runId) ?? [];
    order.push(parsed.approvalRequestId);
    this.orderByRun.set(parsed.runId, order);
    return parsed;
  }

  async getById(approvalRequestId: string): Promise<ApprovalRequest | null> {
    return this.byId.get(approvalRequestId) ?? null;
  }

  async getPendingByRun(runId: string): Promise<ApprovalRequest | null> {
    const list = await this.listByRun(runId);
    return list.find((request) => request.status === "PENDING") ?? null;
  }

  async getByPlanVersion(
    runId: string,
    planId: string,
    planVersion: PlanVersion,
  ): Promise<ApprovalRequest | null> {
    const list = await this.listByRun(runId);
    const matches = list.filter(
      (request) =>
        request.planId === planId && request.planVersion === planVersion,
    );
    return matches[matches.length - 1] ?? null;
  }

  async exists(approvalRequestId: string): Promise<boolean> {
    return this.byId.has(approvalRequestId);
  }

  async listAll(): Promise<readonly ApprovalRequest[]> {
    return [...this.byId.values()];
  }

  async listByRun(runId: string): Promise<readonly ApprovalRequest[]> {
    const order = this.orderByRun.get(runId) ?? [];
    return order
      .map((id) => this.byId.get(id))
      .filter((request): request is ApprovalRequest => Boolean(request));
  }

  async updateStatus(
    approvalRequestId: string,
    status: ApprovalRequest["status"],
    extras: ApprovalRequestStatusExtras = {},
  ): Promise<ApprovalRequest> {
    const existing = this.byId.get(approvalRequestId);
    if (!existing) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_NOT_FOUND",
        `Unknown approval request: ${approvalRequestId}`,
      );
    }

    if (isTerminalApprovalRequestStatus(existing.status)) {
      if (status === "PENDING") {
        throw new AuthorizationError(
          "APPROVAL_REQUEST_IMMUTABLE",
          `Terminal approval request ${approvalRequestId} (${existing.status}) cannot return to PENDING`,
        );
      }
      if (status !== existing.status) {
        throw new AuthorizationError(
          "APPROVAL_REQUEST_IMMUTABLE",
          `Terminal approval request ${approvalRequestId} is ${existing.status} and cannot transition to ${status}`,
        );
      }
    }

    if (status === "PENDING" && existing.status !== "PENDING") {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_IMMUTABLE",
        `Cannot reactivate approval request ${approvalRequestId} to PENDING`,
      );
    }

    const next = parseApprovalRequest({
      ...existing,
      status,
      ...(extras.deliveryFailedAt !== undefined
        ? { deliveryFailedAt: extras.deliveryFailedAt }
        : {}),
      ...(extras.deliveryFailureCode !== undefined
        ? { deliveryFailureCode: extras.deliveryFailureCode }
        : {}),
      ...(extras.failureReasonCode !== undefined
        ? { failureReasonCode: extras.failureReasonCode }
        : {}),
    });

    // Guard: binding fields must be bitwise identical.
    assertBindingUnchanged(existing, next);

    this.byId.set(approvalRequestId, next);
    return next;
  }
}

function assertBindingUnchanged(
  before: ApprovalRequest,
  after: ApprovalRequest,
): void {
  const fields: (keyof ApprovalRequest)[] = [
    "approvalRequestId",
    "projectId",
    "objectiveId",
    "objectiveVersion",
    "planId",
    "planVersion",
    "planHash",
    "repositoryCommitSha",
    "repositoryFingerprint",
    "policyBundleId",
    "policyBundleHash",
    "validationDecisionId",
    "validationDecision",
    "decisionCardHash",
    "decisionNonceHash",
    "createdAt",
    "expiresAt",
    "replacesApprovalRequestId",
  ];
  for (const field of fields) {
    if (before[field] !== after[field]) {
      throw new AuthorizationError(
        "APPROVAL_REQUEST_IMMUTABLE",
        `ApprovalRequest binding field ${String(field)} is immutable after creation`,
        { approvalRequestId: before.approvalRequestId, field },
      );
    }
  }
}
