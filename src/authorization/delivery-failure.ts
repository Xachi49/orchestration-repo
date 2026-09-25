/**
 * Safe approval-delivery failure observability.
 * OBSERVABILITY != AUTHORITY
 * SECRET DIAGNOSTICS != SAFE DIAGNOSTICS
 */
import { isDurabilityError } from "../durability/errors.js";
import { AuthorizationError, isAuthorizationError } from "./errors.js";

export const APPROVAL_DELIVERY_STAGES = [
  "REQUEST_LOOKUP",
  "REVEAL_SECRET",
  "PRE_PROVIDER",
  "PROVIDER",
  "POST_PROVIDER",
] as const;

export type ApprovalDeliveryStage = (typeof APPROVAL_DELIVERY_STAGES)[number];

/** Failure code used when the pending delivery secret cannot be revealed. */
export const APPROVAL_DELIVERY_SECRET_UNAVAILABLE =
  "APPROVAL_DELIVERY_SECRET_UNAVAILABLE" as const;

export interface ApprovalDeliveryFailureResult {
  approvalRequestId: string;
  deliveryStage: ApprovalDeliveryStage;
  failureCode: string;
  safeMessage: string;
  providerAttempted: boolean;
  providerName?: string;
}

export interface ApprovalDeliveryDispatchResult {
  delivered: number;
  failed: number;
  failures: ApprovalDeliveryFailureResult[];
}

export function isApprovalDeliveryStage(
  value: unknown,
): value is ApprovalDeliveryStage {
  return (
    typeof value === "string" &&
    (APPROVAL_DELIVERY_STAGES as readonly string[]).includes(value)
  );
}

function safeFailureMessage(error: unknown): string {
  if (isAuthorizationError(error) || isDurabilityError(error)) {
    return error.message;
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    // Strip anything that looks like a bearer/api key fragment.
    return error.message
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/re_[A-Za-z0-9_]{8,}/g, "[REDACTED]");
  }
  return "Approval delivery failed";
}

function failureCodeFrom(error: unknown, fallback: string): string {
  if (isDurabilityError(error)) {
    return error.code;
  }
  if (isAuthorizationError(error)) {
    const fromDetails = error.details?.["failureCode"];
    if (typeof fromDetails === "string" && fromDetails.length > 0) {
      return fromDetails;
    }
    return error.code;
  }
  return fallback;
}

/**
 * Classify a delivery exception into a non-secret structured failure.
 * Prefer explicit stage/providerAttempted tags already present on the error.
 */
export function classifyApprovalDeliveryFailure(
  error: unknown,
  approvalRequestId: string,
  hints?: {
    deliveryStage?: ApprovalDeliveryStage;
    providerAttempted?: boolean;
    providerName?: string;
  },
): ApprovalDeliveryFailureResult {
  const details =
    isAuthorizationError(error) && error.details
      ? error.details
      : isDurabilityError(error)
        ? error.details
        : undefined;

  const taggedStage = details?.["deliveryStage"];
  const deliveryStage: ApprovalDeliveryStage = hints?.deliveryStage
    ? hints.deliveryStage
    : isApprovalDeliveryStage(taggedStage)
      ? taggedStage
      : isDurabilityError(error) && error.code === "SIDE_EFFECT_IN_TRANSACTION"
        ? "PRE_PROVIDER"
        : "PRE_PROVIDER";

  const taggedAttempted = details?.["providerAttempted"];
  const providerAttempted =
    hints?.providerAttempted ??
    (typeof taggedAttempted === "boolean"
      ? taggedAttempted
      : deliveryStage === "PROVIDER");

  const taggedProvider = details?.["providerName"];
  const providerName =
    hints?.providerName ??
    (typeof taggedProvider === "string" ? taggedProvider : undefined);

  const failureCode = failureCodeFrom(error, "APPROVAL_DELIVERY_FAILED");

  const result: ApprovalDeliveryFailureResult = {
    approvalRequestId,
    deliveryStage,
    failureCode,
    safeMessage: safeFailureMessage(error),
    providerAttempted,
  };
  if (providerName !== undefined) {
    result.providerName = providerName;
  }
  return result;
}

/** Wrap any delivery error as AuthorizationError with safe observability details. */
export function toApprovalDeliveryFailureError(
  error: unknown,
  approvalRequestId: string,
  hints?: {
    deliveryStage?: ApprovalDeliveryStage;
    providerAttempted?: boolean;
    providerName?: string;
    message?: string;
    failureCode?: string;
  },
): AuthorizationError {
  if (
    isAuthorizationError(error) &&
    error.code === "APPROVAL_DELIVERY_FAILED" &&
    isApprovalDeliveryStage(error.details?.["deliveryStage"])
  ) {
    return error;
  }

  const classified = classifyApprovalDeliveryFailure(error, approvalRequestId, hints);
  const failureCode = hints?.failureCode ?? classified.failureCode;
  const message = hints?.message ?? classified.safeMessage;

  return new AuthorizationError("APPROVAL_DELIVERY_FAILED", message, {
    approvalRequestId,
    deliveryStage: classified.deliveryStage,
    failureCode,
    providerAttempted: classified.providerAttempted,
    ...(classified.providerName !== undefined
      ? { providerName: classified.providerName }
      : {}),
  });
}

/** HTTP-safe projection of delivery failure details (never includes secrets). */
export function approvalDeliveryFailureHttpFields(
  error: AuthorizationError,
): {
  replacementApprovalRequestId?: string;
  originalApprovalRequestId?: string;
  deliveryStage?: ApprovalDeliveryStage;
  failureCode?: string;
  providerAttempted?: boolean;
  providerName?: string;
} {
  const d = error.details ?? {};
  const out: {
    replacementApprovalRequestId?: string;
    originalApprovalRequestId?: string;
    deliveryStage?: ApprovalDeliveryStage;
    failureCode?: string;
    providerAttempted?: boolean;
    providerName?: string;
  } = {};

  if (typeof d["replacementApprovalRequestId"] === "string") {
    out.replacementApprovalRequestId = d["replacementApprovalRequestId"];
  }
  if (typeof d["originalApprovalRequestId"] === "string") {
    out.originalApprovalRequestId = d["originalApprovalRequestId"];
  }
  if (isApprovalDeliveryStage(d["deliveryStage"])) {
    out.deliveryStage = d["deliveryStage"];
  }
  if (typeof d["failureCode"] === "string") {
    out.failureCode = d["failureCode"];
  }
  if (typeof d["providerAttempted"] === "boolean") {
    out.providerAttempted = d["providerAttempted"];
  }
  if (typeof d["providerName"] === "string") {
    out.providerName = d["providerName"];
  }
  return out;
}

export function findDispatchFailureForApproval(
  result: ApprovalDeliveryDispatchResult | undefined,
  approvalRequestId: string,
): ApprovalDeliveryFailureResult | undefined {
  if (!result) {
    return undefined;
  }
  return (
    result.failures.find((f) => f.approvalRequestId === approvalRequestId) ??
    result.failures[0]
  );
}
