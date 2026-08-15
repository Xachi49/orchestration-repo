export const INGESTION_ERROR_CODES = [
  "REPOSITORY_NOT_CONFIGURED",
  "REMOTE_REPOSITORY_UNAVAILABLE",
  "REMOTE_AUTHENTICATION_FAILED",
  "BRANCH_NOT_FOUND",
  "COMMIT_NOT_FOUND",
  "LOCKED_SHA_MISMATCH",
  "WORKSPACE_PREPARATION_FAILED",
  "WORKSPACE_PATH_VIOLATION",
  "REPOSITORY_FINGERPRINT_FAILED",
  "INDEXING_FAILED",
  "EVIDENCE_PERSISTENCE_FAILED",
  "REPOSITORY_DRIFT_DETECTED",
  "INVALID_INGESTION_STATE",
  "INGESTION_IN_PROGRESS",
] as const;

export type IngestionErrorCode = (typeof INGESTION_ERROR_CODES)[number];

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: IngestionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "IngestionError";
    this.code = code;
    this.details = details;
  }
}

export function isIngestionError(error: unknown): error is IngestionError {
  return error instanceof IngestionError;
}
