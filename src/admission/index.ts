/**
 * Admission boundary — objective admission and durable run initialization.
 * Phase 2: admission authority only. No planning, approval, or execution.
 */
export type { AdmissionPort } from "./port.js";
export {
  ADMISSION_ERROR_CODES,
  AdmissionError,
  isAdmissionError,
  type AdmissionErrorCode,
} from "./errors.js";
export {
  AdmissionRequestSchema,
  parseAdmissionRequest,
  safeParseAdmissionRequest,
  type AdmissionRequest,
} from "./request.js";
export {
  ADMISSION_OUTCOMES,
  type AdmissionOutcome,
  type ControlContextReference,
  type AdmittedResult,
  type DuplicateAdmissionResult,
  type RejectedAdmissionResult,
  type ConflictAdmissionResult,
  type AdmissionResult,
} from "./result.js";
export {
  AUTHORIZATION_DECISIONS,
  type AuthorizationDecisionCode,
  type AuthorizationQuery,
  type AuthorizationDecision,
  type RequesterAuthorizationService,
  type RequesterGrant,
} from "./authorization.js";
export {
  type IdempotencyRecord,
  type IdempotencyReserveResult,
  type IdempotencyStore,
} from "./idempotency-store.js";
export {
  type ProjectLock,
  type LockAcquireResult,
  type AcquireLockCommand,
  type ProjectLockService,
} from "./project-lock.js";
export {
  RunRecordSchema,
  type RunRecord,
  type RunRepository,
} from "./run-repository.js";
export {
  PROJECT_OBJECTIVE_SUBMITTED,
  type EventStore,
} from "./event-store.js";
export {
  type AdmissionIdentity,
  type AdmissionIdentityGenerator,
} from "./identity.js";
export {
  ObjectiveAdmissionService,
  type ObjectiveAdmissionServiceDeps,
} from "./service.js";
export {
  EXAMPLE_REQUESTER_ID,
  EXAMPLE_REQUESTER_GRANTS,
  exampleAdmissionRequest,
} from "./fixtures.js";
