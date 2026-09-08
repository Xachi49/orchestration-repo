export type FederationErrorCode =
  | "FEDERATION_NOT_FOUND"
  | "FEDERATION_AGREEMENT_INVALID"
  | "FEDERATION_PARTICIPANT_INVALID"
  | "FEDERATION_SCOPE_VIOLATION"
  | "FEDERATION_AUTHORITY_REQUIRED"
  | "FEDERATION_RATIFICATION_REQUIRED"
  | "FEDERATION_RATIFICATION_STALE"
  | "FEDERATION_BASE_STATE_STALE"
  | "FEDERATION_NOT_ACTIVE"
  | "FEDERATION_SUSPENDED"
  | "FEDERATION_REVOKED"
  | "FEDERATION_TRANSITIVE_TRUST_DENIED"
  | "FEDERATED_INTENT_INVALID"
  | "FEDERATED_INTENT_NOT_ACCEPTED"
  | "FEDERATED_INTENT_STALE"
  | "FEDERATED_MATERIALIZATION_CONFLICT"
  | "FEDERATED_TARGET_SCOPE_DENIED"
  | "FEDERATED_REQUESTER_AUTHORITY_REQUIRED"
  | "FEDERATED_EVIDENCE_UNTRUSTED"
  | "FEDERATION_CAS_CONFLICT"
  | "FEDERATION_STATE_CONFLICT"
  | "FEDERATION_HOLD_ACTIVE"
  | "FEDERATION_INSTITUTION_INACTIVE"
  | "FEDERATION_ACTION_UNSUPPORTED"
  | "FEDERATED_ACCEPTANCE_DENIED"
  | "FEDERATED_MATERIALIZATION_FAILED";

export class FederationError extends Error {
  readonly code: FederationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: FederationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FederationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isFederationError(error: unknown): error is FederationError {
  return error instanceof FederationError;
}
