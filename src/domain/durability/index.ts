/**
 * Phase 11 durability contracts.
 *
 * PROCESS MEMORY != SYSTEM OF RECORD
 * DATABASE ROW != DOMAIN AUTHORITY
 * LEASE OWNERSHIP != BUSINESS AUTHORIZATION
 * DELIVERY AT LEAST ONCE != SIDE EFFECT EXACTLY ONCE
 * RUNNING + PROCESS CRASH != SAFE TO RETRY
 * STALE WORKER != AUTHORIZED WRITER
 * LOCAL FILE PATH != DISTRIBUTED ARTIFACT AUTHORITY
 * APPLICATION CLOCK != DISTRIBUTED LEASE CLOCK
 */

export const STORAGE_MODES = ["memory", "postgres"] as const;
export type StorageMode = (typeof STORAGE_MODES)[number];

export const INFERENCE_DURABILITY_STATES = [
  "RESERVED",
  "DISPATCH_STARTED",
  "SETTLED",
  "FAILED_PRE_DISPATCH",
  "AMBIGUOUS",
] as const;
export type InferenceDurabilityState =
  (typeof INFERENCE_DURABILITY_STATES)[number];

export const RECOVERY_OUTCOMES = [
  "RECOVERED",
  "REACQUIRED",
  "RECONCILED",
  "REQUIRES_MANUAL_REVIEW",
  "CONTAINED",
  "NO_ACTION",
  "UNSAFE_TO_RETRY",
] as const;
export type RecoveryOutcome = (typeof RECOVERY_OUTCOMES)[number];

export const OUTBOX_STATUSES = [
  "PENDING",
  "LEASED",
  "DELIVERED",
  "FAILED",
] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const LEASE_STATUSES = ["HELD", "RELEASED", "EXPIRED"] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

export interface CoordinatorLease {
  coordinationKey: string;
  phase: string;
  ownerId: string;
  fenceToken: number;
  leaseExpiresAt: string;
  acquiredAt: string;
  lastHeartbeatAt: string;
  status: LeaseStatus;
}

export interface ArtifactBlobRecord {
  artifactId: string;
  runId: string;
  projectId: string;
  executionAttemptId: string;
  stepId: string;
  artifactType: string;
  contentHash: string;
  byteSize: number;
  mediaType: string;
  createdAt: string;
}

export interface OutboxMessage {
  outboxId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  createdAt: string;
  availableAt: string;
  status: OutboxStatus;
  attemptCount: number;
  leaseOwnerId?: string;
  fenceToken?: number;
  leaseExpiresAt?: string;
  deliveredAt?: string;
}

export interface InboxRecord {
  messageId: string;
  consumerName: string;
  receivedAt: string;
  processedAt?: string;
  resultFingerprint?: string;
}

export const MAX_ARTIFACT_BYTES = 1_048_576;
export const DEFAULT_LEASE_TTL_SECONDS = 60;
export const MAX_TRANSACTION_RETRIES = 3;
export const SUPPORTED_SCHEMA_VERSION = "009_phase14_program_scheduler";
