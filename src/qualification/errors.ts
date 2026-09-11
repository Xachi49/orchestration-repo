export type QualificationErrorCode =
  | "RELEASE_CANDIDATE_INVALID"
  | "RELEASE_CANDIDATE_DRIFT"
  | "BUILD_ARTIFACT_INTEGRITY_FAILED"
  | "REFERENCE_RUNTIME_INVALID"
  | "REFERENCE_RUNTIME_DRIFT"
  | "PRODUCTION_CONFIG_INVALID"
  | "PRODUCTION_READINESS_FAILED"
  | "PHASE23_CERTIFICATE_REQUIRED"
  | "PHASE23_CERTIFICATE_INVALID"
  | "PHASE23_TARGET_MISMATCH"
  | "QUALIFICATION_EVIDENCE_MISSING"
  | "QUALIFICATION_INCONCLUSIVE"
  | "RELEASE_NOT_QUALIFIED"
  | "RELEASE_QUALIFICATION_CONFLICT"
  | "RELEASE_MANIFEST_INVALID"
  | "RUNTIME_RECOVERY_FAILED"
  | "RUNTIME_DRAIN_FAILED"
  | "QUALIFICATION_CAS_CONFLICT"
  | "QUALIFICATION_NOT_FOUND"
  | "QUALIFICATION_STATE_CONFLICT";

export class QualificationError extends Error {
  readonly code: QualificationErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: QualificationErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QualificationError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isQualificationError(
  error: unknown,
): error is QualificationError {
  return error instanceof QualificationError;
}
