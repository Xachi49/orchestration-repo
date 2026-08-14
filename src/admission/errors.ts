export const ADMISSION_ERROR_CODES = [
  "INVALID_ADMISSION_REQUEST",
  "REQUESTER_UNAUTHORIZED",
  "UNKNOWN_REQUESTER",
  "PROJECT_NOT_ELIGIBLE",
  "ENVIRONMENT_NOT_ALLOWED",
  "ACTIVE_DUPLICATE",
  "COMPLETED_DUPLICATE",
  "IDEMPOTENCY_RESERVATION_FAILED",
  "OBJECTIVE_VERSION_CONFLICT",
  "PROJECT_LOCK_CONFLICT",
  "RUN_CREATION_FAILED",
  "INVALID_RUN_TRANSITION",
  "EVENT_CREATION_FAILED",
  "ADMISSION_COMPENSATION_FAILED",
] as const;

export type AdmissionErrorCode = (typeof ADMISSION_ERROR_CODES)[number];

export class AdmissionError extends Error {
  readonly code: AdmissionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: AdmissionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AdmissionError";
    this.code = code;
    this.details = details;
  }
}

export function isAdmissionError(error: unknown): error is AdmissionError {
  return error instanceof AdmissionError;
}
