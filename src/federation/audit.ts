export type FederationAuditEventType =
  | "AGREEMENT_PROPOSED"
  | "PARTICIPANT_RATIFIED"
  | "AGREEMENT_ACTIVATED"
  | "PARTICIPATION_WITHDRAWN"
  | "WORK_INTENT_CREATED"
  | "WORK_ACCEPTED"
  | "WORK_REJECTED"
  | "WORK_MATERIALIZED"
  | "EVIDENCE_SHARED"
  | "AGREEMENT_STALE"
  | "AGREEMENT_SUSPENDED";

export interface FederationAuditEvent {
  auditEventId: string;
  eventType: FederationAuditEventType;
  federationId: string;
  agreementId?: string;
  intentId?: string;
  institutionId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
