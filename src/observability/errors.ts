export type ObservabilityErrorCode =
  | "PROJECT_NOT_FOUND"
  | "RUN_NOT_FOUND"
  | "TELEMETRY_INTEGRITY_FAILED"
  | "TELEMETRY_NOT_FOUND"
  | "SNAPSHOT_NOT_FOUND"
  | "SLO_NOT_FOUND"
  | "ANOMALY_NOT_FOUND"
  | "OPTIMIZATION_CANDIDATE_NOT_FOUND"
  | "INVALID_WINDOW"
  | "INVALID_REVIEW_REQUEST";

export class ObservabilityError extends Error {
  readonly code: ObservabilityErrorCode;

  constructor(code: ObservabilityErrorCode, message: string) {
    super(message);
    this.name = "ObservabilityError";
    this.code = code;
  }
}

export function isObservabilityError(
  error: unknown,
): error is ObservabilityError {
  return error instanceof ObservabilityError;
}
