export { FEDERATION_DOCTRINE, FEDERATION_GOVERNING_LAW, FEDERATION_ROLES, FEDERATION_ACTIONS, FEDERATION_GOVERNANCE_SUBJECTS, describeFederationAction, assertExhaustiveFederationAction, isFederationRole, type FederationRole, type FederationAction, type FederationGovernanceSubject } from "./doctrine.js";
export { FederationError, isFederationError, type FederationErrorCode } from "./errors.js";
export {
  FederationAgreementSchema,
  computeAgreementHash,
  withAgreementHash,
  mintAgreementId,
  mintFederationId,
  type FederationAgreement,
  type FederationAgreementStatus,
} from "./agreement.js";
export {
  FederationScopeSchema,
  computeScopeHash,
  canonicalizeParticipantIds,
  computeParticipantSetHash,
  assertWorkIntentInScope,
  assertPairInScope,
  type FederationScope,
  type FederationResourceRequestCeiling,
} from "./scope.js";
export {
  FederationRatificationSchema,
  withRatificationHash,
  compileRatificationSubjectBinding,
  type FederationRatification,
} from "./ratification.js";
export {
  FederationActivationRecordSchema,
  withActivationRecordHash,
  type FederationActivationRecord,
} from "./agreement-activation.js";
export {
  computeFederationStateFingerprint,
  type FederationStateFingerprintInput,
} from "./fingerprint.js";
export {
  FederationParticipationChangeSchema,
  withParticipationChangeHash,
  compileWithdrawalSubjectBinding,
  type FederationParticipationChange,
} from "./participation.js";
export {
  FederatedWorkIntentSchema,
  withIntentHash,
  type FederatedWorkIntent,
} from "./work-intent.js";
export {
  FederatedWorkAcceptanceSchema,
  withAcceptanceHash,
  compileWorkAcceptanceSubjectBinding,
  type FederatedWorkAcceptance,
} from "./work-acceptance.js";
export {
  FederatedMaterializationRecordSchema,
  withMaterializationHash,
  materializationIdempotencyKey,
  type FederatedMaterializationRecord,
} from "./work-materialization.js";
export {
  FederatedEvidenceEnvelopeSchema,
  withEnvelopeHash,
  type FederatedEvidenceEnvelope,
} from "./evidence-envelope.js";
export {
  InProcessFederationTransport,
  type FederationTransport,
  type FederationTransportMessage,
} from "./transport.js";
export type { FederationAuditEvent, FederationAuditEventType } from "./audit.js";
export type * from "./repositories.js";
export {
  InMemoryFederationAgreementRepository,
  InMemoryFederationRatificationRepository,
  InMemoryFederationActivationRecordRepository,
  InMemoryFederationParticipationChangeRepository,
  InMemoryFederatedWorkIntentRepository,
  InMemoryFederatedWorkAcceptanceRepository,
  InMemoryFederatedMaterializationRepository,
  InMemoryFederatedEvidenceEnvelopeRepository,
  InMemoryFederationAuditRepository,
} from "./memory-repositories.js";
export {
  FederationOrchestrationService,
  listSupportedFederationActions,
  type FederationOrchestrationDeps,
} from "./service.js";
export { createInMemoryFederationActivationRunner } from "./test-transaction.js";
