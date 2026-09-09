export type AssuranceErrorCode =
  | "ASSURANCE_TARGET_INVALID"
  | "ASSURANCE_TARGET_DRIFT"
  | "ASSURANCE_PROFILE_INVALID"
  | "ASSURANCE_CONTROL_MISSING"
  | "ASSURANCE_EVIDENCE_MISSING"
  | "ASSURANCE_EVIDENCE_STALE"
  | "ASSURANCE_EVIDENCE_TAMPERED"
  | "ASSURANCE_EVIDENCE_CONTRADICTORY"
  | "ASSURANCE_CHALLENGE_INVALID"
  | "ASSURANCE_EVALUATION_FAILED"
  | "ASSURANCE_INCONCLUSIVE"
  | "ASSURANCE_NOT_QUALIFIED"
  | "ASSURANCE_CERTIFIER_REQUIRED"
  | "ASSURANCE_SEPARATION_VIOLATION"
  | "ASSURANCE_CERTIFICATION_CONFLICT"
  | "ASSURANCE_CERTIFICATE_STALE"
  | "ASSURANCE_CERTIFICATE_EXPIRED"
  | "ASSURANCE_CERTIFICATE_REVOKED"
  | "ASSURANCE_PROOF_STALE"
  | "ASSURANCE_FAULT_INJECTION_DENIED"
  | "ASSURANCE_CAS_CONFLICT"
  | "ASSURANCE_AUTHORITY_REQUIRED"
  | "ASSURANCE_STATE_CONFLICT"
  | "ASSURANCE_NOT_FOUND";

export class AssuranceError extends Error {
  readonly code: AssuranceErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AssuranceErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AssuranceError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isAssuranceError(error: unknown): error is AssuranceError {
  return error instanceof AssuranceError;
}
