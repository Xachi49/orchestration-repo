import type { FederationAgreement } from "./agreement.js";
import type { FederationActivationRecord } from "./agreement-activation.js";
import type { FederationAuditEvent } from "./audit.js";
import type { FederatedEvidenceEnvelope } from "./evidence-envelope.js";
import type { FederationParticipationChange } from "./participation.js";
import type { FederationRatification } from "./ratification.js";
import type { FederatedWorkAcceptance } from "./work-acceptance.js";
import type { FederatedWorkIntent } from "./work-intent.js";
import type { FederatedMaterializationRecord } from "./work-materialization.js";

export interface FederationAgreementRepository {
  save(agreement: FederationAgreement): Promise<FederationAgreement>;
  getById(agreementId: string): Promise<FederationAgreement | null>;
  getByFederationId(
    federationId: string,
  ): Promise<FederationAgreement | null>;
  listByFederation(federationId: string): Promise<FederationAgreement[]>;
  getActiveByFederation(
    federationId: string,
  ): Promise<FederationAgreement | null>;
  transition(
    agreementId: string,
    fromStatus: FederationAgreement["status"],
    expectedRevision: number,
    toStatus: FederationAgreement["status"],
    updatedAt: string,
    patch?: Partial<FederationAgreement>,
  ): Promise<FederationAgreement>;
}

export interface FederationRatificationRepository {
  save(r: FederationRatification): Promise<FederationRatification>;
  getById(ratificationId: string): Promise<FederationRatification | null>;
  listByAgreement(agreementId: string): Promise<FederationRatification[]>;
  getByAgreementAndInstitution(
    agreementId: string,
    institutionId: string,
  ): Promise<FederationRatification | null>;
}

export interface FederationActivationRecordRepository {
  save(r: FederationActivationRecord): Promise<FederationActivationRecord>;
  getById(id: string): Promise<FederationActivationRecord | null>;
  getByAgreement(
    agreementId: string,
  ): Promise<FederationActivationRecord | null>;
}

export interface FederationParticipationChangeRepository {
  save(
    c: FederationParticipationChange,
  ): Promise<FederationParticipationChange>;
  listByAgreement(
    agreementId: string,
  ): Promise<FederationParticipationChange[]>;
}

export interface FederatedWorkIntentRepository {
  save(intent: FederatedWorkIntent): Promise<FederatedWorkIntent>;
  getById(intentId: string): Promise<FederatedWorkIntent | null>;
  updateStatus(
    intentId: string,
    fromStatus: FederatedWorkIntent["status"],
    toStatus: FederatedWorkIntent["status"],
  ): Promise<FederatedWorkIntent>;
}

export interface FederatedWorkAcceptanceRepository {
  save(a: FederatedWorkAcceptance): Promise<FederatedWorkAcceptance>;
  getByIntent(intentId: string): Promise<FederatedWorkAcceptance | null>;
}

export interface FederatedMaterializationRepository {
  save(
    r: FederatedMaterializationRecord,
  ): Promise<FederatedMaterializationRecord>;
  getByIntent(intentId: string): Promise<FederatedMaterializationRecord | null>;
  getByIdempotencyKey(
    key: string,
  ): Promise<FederatedMaterializationRecord | null>;
}

export interface FederatedEvidenceEnvelopeRepository {
  save(e: FederatedEvidenceEnvelope): Promise<FederatedEvidenceEnvelope>;
  getById(envelopeId: string): Promise<FederatedEvidenceEnvelope | null>;
  listByDestination(
    destinationInstitutionId: string,
    destinationProjectId: string,
  ): Promise<FederatedEvidenceEnvelope[]>;
}

export interface FederationAuditRepository {
  append(event: FederationAuditEvent): Promise<FederationAuditEvent>;
  listByFederation(federationId: string): Promise<FederationAuditEvent[]>;
  listByAgreement(agreementId: string): Promise<FederationAuditEvent[]>;
}
