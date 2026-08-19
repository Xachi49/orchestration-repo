export const DURABILITY_ERROR_CODES = [
  "DATABASE_UNAVAILABLE",
  "DATABASE_TRANSACTION_FAILED",
  "DATABASE_SCHEMA_OUT_OF_DATE",
  "DATABASE_SCHEMA_INCOMPATIBLE",
  "PERSISTED_RECORD_INVALID",
  "DURABLE_CONFLICT",
  "LEASE_ALREADY_HELD",
  "LEASE_EXPIRED",
  "LEASE_OWNERSHIP_LOST",
  "STALE_FENCE_TOKEN",
  "IDEMPOTENCY_CONFLICT",
  "ARTIFACT_PERSISTENCE_FAILED",
  "ARTIFACT_CONTENT_MISSING",
  "RECOVERY_REQUIRED",
  "UNSAFE_TO_RETRY",
  "OUTBOX_DELIVERY_FAILED",
  "SIDE_EFFECT_IN_TRANSACTION",
  "STORAGE_MODE_INVALID",
  "MIGRATION_LOCK_UNAVAILABLE",
] as const;

export type DurabilityErrorCode = (typeof DURABILITY_ERROR_CODES)[number];

export class DurabilityError extends Error {
  readonly code: DurabilityErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DurabilityErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DurabilityError";
    this.code = code;
    this.details = details;
  }
}

export function isDurabilityError(error: unknown): error is DurabilityError {
  return error instanceof DurabilityError;
}
