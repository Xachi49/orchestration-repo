export {
  AUTHORIZATION_ERROR_CODES,
  AuthorizationError,
  isAuthorizationError,
  type AuthorizationErrorCode,
} from "./errors.js";

export {
  AuthorizationReadinessService,
  AuthorizationReadinessCodeSchema,
  type AuthorizationReadinessCode,
  type AuthorizationReadinessResult,
  type AuthorizationReadinessServiceDeps,
} from "./readiness.js";

export {
  InMemoryApprovalRequestRepository,
  type ApprovalRequestRepository,
} from "./approval-request-repository.js";

export {
  InMemoryAuthorizationRecordRepository,
  type AuthorizationRecordRepository,
} from "./authorization-record-repository.js";

export {
  InMemoryModificationRequestRepository,
  type ModificationRequestRepository,
} from "./modification-request-repository.js";

export {
  InMemoryAuthorizationCoordinator,
  type AuthorizationCoordinator,
} from "./coordinator.js";

export {
  InMemoryApproverAuthorizationService,
  type ApproverAuthorizationService,
  type ApproverAuthorizationOutcome,
  type ApproverAuthorizationQuery,
} from "./approver-authorization.js";

export {
  FakeApprovalDeliveryService,
  DisconnectedApprovalDeliveryService,
  type ApprovalDeliveryService,
} from "./delivery.js";

export {
  Sha256DecisionCardHasher,
  hashDecisionNonce,
  type DecisionCardHasher,
} from "./decision-card-hasher.js";

export {
  buildApprovalDecisionCard,
  whyApprovalRequiredForDecision,
} from "./decision-card-builder.js";

export {
  InMemoryDecisionCardStore,
  type DecisionCardStore,
} from "./decision-card-store.js";

export {
  AuthorizationRoutingService,
  type AuthorizationRoutingServiceDeps,
} from "./routing.js";

export {
  HumanAuthorizationService,
  APPROVAL_REISSUE_REASONS,
  APPROVAL_DELIVERY_UNREACHABLE_REASON,
  APPROVAL_REISSUE_AUDIT_EVENT,
  type HumanAuthorizationServiceDeps,
  type ApprovalReissueResult,
  type ApprovalDeliveryRecoveryResult,
  type ApprovalReissueReason,
} from "./service.js";

export {
  ApprovalExpiryService,
  type ApprovalExpiryServiceDeps,
} from "./expiry.js";

export {
  DEFAULT_APPROVAL_WINDOW_MS,
  SequenceAuthorizationIdentityGenerator,
  addMsIso,
  isExpired,
  type AuthorizationIdentityGenerator,
} from "./identity.js";

export {
  CryptoDecisionNonceGenerator,
  SequenceDecisionNonceGenerator,
  issueDecisionNonce,
  type DecisionNonceGenerator,
} from "./decision-nonce.js";

export type {
  AuthorizationResult,
  AuthorizationResultKind,
  AuthorizationRoutingOutcome,
} from "./result.js";

export {
  APPROVAL_DELIVERY_STAGES,
  APPROVAL_DELIVERY_SECRET_UNAVAILABLE,
  classifyApprovalDeliveryFailure,
  toApprovalDeliveryFailureError,
  approvalDeliveryFailureHttpFields,
  findDispatchFailureForApproval,
  type ApprovalDeliveryStage,
  type ApprovalDeliveryFailureResult,
  type ApprovalDeliveryDispatchResult,
} from "./delivery-failure.js";

export {
  APPROVAL_DELIVERY_EVENT,
  ApprovalDeliveryOutboxConsumer,
  createApprovalDeliveryDispatcher,
  type ApprovalDeliveryOutboxPayload,
  type ApprovalDeliveryOutboxPort,
} from "./outbox-consumer.js";

export {
  APPROVAL_REPLACEMENT_LINEAGE_SCOPE,
  toApprovalReplacementLineageRecord,
  type ApprovalReplacementLineageRecord,
  type ApprovalReplacementLineageResult,
  type ApprovalReplacementLineageScope,
} from "./replacement-lineage.js";
