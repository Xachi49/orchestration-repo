export const AUTHORIZATION_ERROR_CODES = [
  "AUTHORIZATION_NOT_READY",
  "APPROVAL_REQUEST_ALREADY_EXISTS",
  "APPROVAL_REQUEST_NOT_FOUND",
  "APPROVAL_REQUEST_NOT_PENDING",
  "APPROVAL_REQUEST_EXPIRED",
  "APPROVAL_REQUEST_IMMUTABLE",
  "APPROVER_UNAUTHORIZED",
  "UNKNOWN_APPROVER",
  "AUTHORIZATION_DECISION_REPLAYED",
  "INVALID_DECISION_NONCE",
  "AUTHORIZATION_BINDING_MISMATCH",
  "AUTHORIZATION_BINDING_STALE",
  "APPROVAL_DELIVERY_FAILED",
  "DECISION_CARD_HASH_MISMATCH",
  "PLAN_SUPERSEDED",
  "POLICY_CHANGED_DURING_APPROVAL",
  "REPOSITORY_CHANGED_DURING_APPROVAL",
  "CAPABILITY_CHANGED_DURING_APPROVAL",
  "AUTHORIZATION_PERSISTENCE_FAILED",
  "MODIFICATION_REQUEST_INVALID",
  "AUTHORIZATION_DECISION_NOT_TERMINAL",
  "INVALID_AUTHORIZATION_STATE",
  "AUTHORIZATION_ALREADY_DECIDED",
  "PROJECT_ACCESS_DENIED",
  "APPROVAL_REISSUE_NOT_ELIGIBLE",
] as const;

export type AuthorizationErrorCode = (typeof AUTHORIZATION_ERROR_CODES)[number];

export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AuthorizationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function isAuthorizationError(error: unknown): error is AuthorizationError {
  return error instanceof AuthorizationError;
}
