/**
 * Read-model projection for ApprovalRequest replacement lineage.
 * READ MODEL != AUTHORITY; LINEAGE DISCOVERY != REISSUE.
 */
import type {
  ApprovalRequest,
  ApprovalRequestStatus,
} from "../domain/authorization/index.js";

/** Direct children only — no recursive descendant traversal. */
export const APPROVAL_REPLACEMENT_LINEAGE_SCOPE = "DIRECT" as const;
export type ApprovalReplacementLineageScope =
  typeof APPROVAL_REPLACEMENT_LINEAGE_SCOPE;

/**
 * Sanitized replacement lineage fields.
 * Never includes decisionNonceHash, plaintext nonce, or delivery-secret material.
 */
export interface ApprovalReplacementLineageRecord {
  approvalRequestId: string;
  replacesApprovalRequestId: string;
  runId: string;
  status: ApprovalRequestStatus;
  createdAt: string;
  expiresAt: string;
  deliveryFailedAt?: string;
  deliveryFailureCode?: string;
  failureReasonCode?: string;
}

export interface ApprovalReplacementLineageResult {
  originalApprovalRequestId: string;
  lineageScope: ApprovalReplacementLineageScope;
  replacements: ApprovalReplacementLineageRecord[];
}

export function toApprovalReplacementLineageRecord(
  request: ApprovalRequest,
): ApprovalReplacementLineageRecord {
  if (!request.replacesApprovalRequestId) {
    throw new Error(
      `ApprovalRequest ${request.approvalRequestId} is not a replacement`,
    );
  }
  const record: ApprovalReplacementLineageRecord = {
    approvalRequestId: request.approvalRequestId,
    replacesApprovalRequestId: request.replacesApprovalRequestId,
    runId: request.runId,
    status: request.status,
    createdAt: request.createdAt,
    expiresAt: request.expiresAt,
  };
  if (request.deliveryFailedAt !== undefined) {
    record.deliveryFailedAt = request.deliveryFailedAt;
  }
  if (request.deliveryFailureCode !== undefined) {
    record.deliveryFailureCode = request.deliveryFailureCode;
  }
  if (request.failureReasonCode !== undefined) {
    record.failureReasonCode = request.failureReasonCode;
  }
  return record;
}
