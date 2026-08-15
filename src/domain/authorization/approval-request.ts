import { z } from "zod";
import { ObjectiveVersionSchema } from "../objective/objective.js";
import { PlanVersionSchema } from "../plan/execution-plan.js";

export const ApprovalRequestStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "MODIFICATION_REQUESTED",
  "EXPIRED",
  "CANCELLED",
  "SUPERSEDED",
]);
export type ApprovalRequestStatus = z.infer<typeof ApprovalRequestStatusSchema>;

/** Terminal statuses are permanent — never reactivated to PENDING. */
export const TERMINAL_APPROVAL_REQUEST_STATUSES = [
  "APPROVED",
  "REJECTED",
  "MODIFICATION_REQUESTED",
  "EXPIRED",
  "CANCELLED",
  "SUPERSEDED",
] as const satisfies readonly ApprovalRequestStatus[];

export type TerminalApprovalRequestStatus =
  (typeof TERMINAL_APPROVAL_REQUEST_STATUSES)[number];

export function isTerminalApprovalRequestStatus(
  status: ApprovalRequestStatus,
): status is TerminalApprovalRequestStatus {
  return (TERMINAL_APPROVAL_REQUEST_STATUSES as readonly string[]).includes(
    status,
  );
}

export const ApprovalRequestReasonSchema = z.enum([
  "EXECUTION_AUTHORIZATION",
  "HUMAN_APPROVAL_REQUIRED",
  "POLICY_REQUIRE_APPROVAL",
  "PLANNING_EXCEPTION",
]);
export type ApprovalRequestReason = z.infer<typeof ApprovalRequestReasonSchema>;

/**
 * Exact human-authorization request. Identity is system-generated.
 *
 * Authoritative binding fields are immutable after creation, including
 * expiresAt, decisionCardHash, and decisionNonceHash. Delivery failure
 * cancels the request permanently; retry creates a new ApprovalRequest.
 *
 * PENDING corresponds to run.state == AWAITING_APPROVAL after successful delivery.
 * Only the nonce *hash* is stored — never the plaintext nonce.
 */
export const ApprovalRequestSchema = z
  .object({
    approvalRequestId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleId: z.string().min(1),
    policyBundleHash: z.string().min(1),
    validationDecisionId: z.string().min(1),
    validationDecision: z.enum(["PASS", "BLOCK", "HUMAN_APPROVAL_REQUIRED"]),
    requestReason: ApprovalRequestReasonSchema,
    requestedApproverIds: z.array(z.string().min(1)).min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    status: ApprovalRequestStatusSchema,
    decisionCardHash: z.string().min(1),
    /**
     * Frozen Control Plane capability authority for the exact plan.
     * System-derived at request creation; immutable thereafter.
     */
    capabilitySetFingerprint: z.string().min(1),
    /** Hash of the system-issued decision nonce. Plaintext is never persisted. */
    decisionNonceHash: z.string().min(1),
    /** Audit lineage only — not authoritative for execution. */
    replacesApprovalRequestId: z.string().min(1).optional(),
    deliveryFailedAt: z.string().datetime().optional(),
    deliveryFailureCode: z.string().min(1).optional(),
    failureReasonCode: z.string().min(1).optional(),
  })
  .strict();

export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

export function parseApprovalRequest(input: unknown): ApprovalRequest {
  return ApprovalRequestSchema.parse(input);
}
