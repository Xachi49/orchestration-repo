import type { ApprovalRequest } from "../domain/authorization/index.js";

/**
 * Public approval projection for Control Tower.
 * Omits decisionNonceHash — never expose nonce material to the browser.
 */
export type PublicApprovalRequest = Omit<ApprovalRequest, "decisionNonceHash">;

const SENSITIVE_KEY =
  /^(decisionNonceHash|decisionNonce|deliverySecret|bearerToken|authorization|password|apiKey|databaseUrl|secret|privateKey|accessToken|refreshToken)$/i;

/**
 * Recursively strip secret-like keys from nested metadata.
 * CONTROL TOWER read models must not leak delivery or credential material.
 */
export function sanitizeNestedValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeNestedValue(item));
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEY.test(key)) continue;
    out[key] = sanitizeNestedValue(child);
  }
  return out;
}

export function sanitizeApprovalRequest(
  request: ApprovalRequest,
): PublicApprovalRequest {
  const { decisionNonceHash: _omit, ...publicFields } = request;
  void _omit;
  return sanitizeNestedValue(publicFields) as PublicApprovalRequest;
}
