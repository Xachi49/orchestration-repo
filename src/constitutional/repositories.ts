import type { ConstitutionalChangeProposal } from "./proposal.js";
import type { ConstitutionalImpactAnalysis } from "./impact-analysis.js";
import type { ConstitutionalReviewDecision } from "./review.js";
import type { ConstitutionalActivationRecord } from "./activation.js";

export interface ConstitutionalProposalRepository {
  save(proposal: ConstitutionalChangeProposal): Promise<ConstitutionalChangeProposal>;
  getById(proposalId: string): Promise<ConstitutionalChangeProposal | null>;
  transition(
    proposalId: string,
    fromStatus: ConstitutionalChangeProposal["status"],
    expectedRevision: number,
    toStatus: ConstitutionalChangeProposal["status"],
    updatedAt: string,
    patch?: Partial<ConstitutionalChangeProposal>,
  ): Promise<ConstitutionalChangeProposal>;
}

export interface ConstitutionalImpactAnalysisRepository {
  save(
    analysis: ConstitutionalImpactAnalysis,
  ): Promise<ConstitutionalImpactAnalysis>;
  getLatestByProposal(
    proposalId: string,
  ): Promise<ConstitutionalImpactAnalysis | null>;
}

export interface ConstitutionalReviewDecisionRepository {
  save(
    decision: ConstitutionalReviewDecision,
  ): Promise<ConstitutionalReviewDecision>;
  getById(decisionId: string): Promise<ConstitutionalReviewDecision | null>;
  listByProposal(proposalId: string): Promise<ConstitutionalReviewDecision[]>;
}

export interface ConstitutionalActivationRecordRepository {
  save(
    record: ConstitutionalActivationRecord,
  ): Promise<ConstitutionalActivationRecord>;
  getById(recordId: string): Promise<ConstitutionalActivationRecord | null>;
  getByProposal(
    proposalId: string,
  ): Promise<ConstitutionalActivationRecord | null>;
  getByIdempotencyKey(
    key: string,
  ): Promise<ConstitutionalActivationRecord | null>;
}

export interface ConstitutionalAuditEvent {
  auditEventId: string;
  eventType: string;
  institutionId: string;
  proposalId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ConstitutionalAuditRepository {
  append(event: ConstitutionalAuditEvent): Promise<ConstitutionalAuditEvent>;
  listByProposal(proposalId: string): Promise<ConstitutionalAuditEvent[]>;
}
