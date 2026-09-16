export type RevenueRecoveryErrorCode =
  | "LEAD_SOURCE_CONFLICT"
  | "LEAD_NOT_FOUND"
  | "LEAD_EVENT_CONFLICT"
  | "RECOVERY_CONFIG_MISSING"
  | "RECOVERY_CONFIG_INVALID"
  | "RESPONSE_GAP_NOT_ELIGIBLE"
  | "RECOVERY_CASE_ALREADY_OPEN"
  | "RECOVERY_CASE_NOT_FOUND"
  | "CONTACT_NOT_PERMITTED"
  | "CONTACT_WINDOW_CLOSED"
  | "ATTEMPT_LIMIT_REACHED"
  | "RECOVERY_OBJECTIVE_CONFLICT"
  | "RECOVERY_ACTION_TARGET_MISMATCH"
  | "RECOVERY_SUPPRESSED"
  | "ATTRIBUTION_INVALID"
  | "PROVENANCE_NOT_PERMITTED"
  | "EXECUTION_ACTION_CONFLICT"
  | "RECOVERY_RECORD_CONFLICT"
  | "TEMPLATE_NOT_FOUND"
  | "TEMPLATE_DISABLED"
  | "TENANT_ISOLATION_VIOLATION"
  | "RECOVERY_STATE_CONFLICT"
  | "RECOVERY_CAS_CONFLICT"
  | "PROVIDER_CONFIG_INVALID"
  | "PROVIDER_CONTEXT_MISSING"
  | "PROVIDER_DELIVERY_FAILED"
  | "LIVE_PILOT_TENANT_DENIED"
  | "LIVE_PILOT_RECIPIENT_DENIED"
  | "WEB_INGEST_NOT_CONFIGURED"
  | "WEB_INGEST_UNAUTHORIZED"
  | "RESEND_WEBHOOK_UNAUTHORIZED"
  | "RESEND_WEBHOOK_INVALID";

export class RevenueRecoveryError extends Error {
  readonly code: RevenueRecoveryErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: RevenueRecoveryErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RevenueRecoveryError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isRevenueRecoveryError(
  error: unknown,
): error is RevenueRecoveryError {
  return error instanceof RevenueRecoveryError;
}
