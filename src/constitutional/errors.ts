export type ConstitutionalErrorCode =
  | "CONSTITUTIONAL_PROPOSAL_NOT_FOUND"
  | "CONSTITUTIONAL_PROPOSAL_STATE_CONFLICT"
  | "CONSTITUTIONAL_PROPOSAL_IMMUTABLE"
  | "CONSTITUTIONAL_SAFETY_FLOOR_VIOLATION"
  | "CONSTITUTIONAL_BASE_STATE_STALE"
  | "CONSTITUTIONAL_IMPACT_ANALYSIS_REQUIRED"
  | "CONSTITUTIONAL_REVIEW_REQUIRED"
  | "CONSTITUTIONAL_REVIEW_REJECTED"
  | "CONSTITUTIONAL_ACTIVATION_REQUIRED"
  | "CONSTITUTIONAL_ACTIVATION_STALE"
  | "CONSTITUTIONAL_ACTIVATION_CONFLICT"
  | "CONSTITUTIONAL_GOVERNANCE_LOCKOUT"
  | "CONSTITUTIONAL_SELF_ESCALATION"
  | "CONSTITUTIONAL_SEPARATION_VIOLATION"
  | "CONSTITUTIONAL_PROOF_SUBJECT_MISMATCH"
  | "CONSTITUTIONAL_REVIEW_PROOF_STALE"
  | "CONSTITUTIONAL_ACTIVATION_PROOF_STALE"
  | "CONSTITUTIONAL_HOLD_ACTIVE"
  | "CONSTITUTIONAL_OPERATION_INVALID"
  | "CONSTITUTIONAL_MANDATE_CONFLICT"
  | "CONSTITUTIONAL_ORG_CYCLE"
  | "CONSTITUTIONAL_ADMIN_INSUFFICIENT"
  | "CONSTITUTIONAL_CAS_CONFLICT"
  | "CONSTITUTIONAL_MUTATION_BYPASS_DENIED";

export class ConstitutionalError extends Error {
  readonly code: ConstitutionalErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ConstitutionalErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConstitutionalError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isConstitutionalError(
  error: unknown,
): error is ConstitutionalError {
  return error instanceof ConstitutionalError;
}
