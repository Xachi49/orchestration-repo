import { ConstitutionalError } from "./errors.js";
import {
  ConstitutionalChangeProposalSchema,
  type ConstitutionalChangeProposal,
} from "./proposal.js";
import {
  ConstitutionalImpactAnalysisSchema,
  type ConstitutionalImpactAnalysis,
} from "./impact-analysis.js";
import {
  ConstitutionalReviewDecisionSchema,
  type ConstitutionalReviewDecision,
} from "./review.js";
import {
  ConstitutionalActivationRecordSchema,
  mintActivationIdempotencyKey,
  type ConstitutionalActivationRecord,
} from "./activation.js";
import type {
  ConstitutionalProposalRepository,
  ConstitutionalImpactAnalysisRepository,
  ConstitutionalReviewDecisionRepository,
  ConstitutionalActivationRecordRepository,
  ConstitutionalAuditRepository,
  ConstitutionalAuditEvent,
} from "./repositories.js";

function assertCasTransition(input: {
  entity: string;
  id: string;
  existingStatus: string;
  fromStatus: string;
  existingRevision: number;
  expectedRevision: number;
}): void {
  if (input.existingStatus !== input.fromStatus) {
    throw new ConstitutionalError(
      "CONSTITUTIONAL_CAS_CONFLICT",
      `${input.entity} ${input.id} status mismatch (expected ${input.fromStatus}, have ${input.existingStatus})`,
      {
        id: input.id,
        fromStatus: input.fromStatus,
        actualStatus: input.existingStatus,
      },
    );
  }
  if (input.existingRevision !== input.expectedRevision) {
    throw new ConstitutionalError(
      "CONSTITUTIONAL_CAS_CONFLICT",
      `${input.entity} ${input.id} revision mismatch (expected ${input.expectedRevision}, have ${input.existingRevision})`,
      {
        id: input.id,
        expectedRevision: input.expectedRevision,
        actualRevision: input.existingRevision,
      },
    );
  }
}

export class InMemoryConstitutionalProposalRepository
  implements ConstitutionalProposalRepository
{
  private readonly byId = new Map<string, ConstitutionalChangeProposal>();

  async save(
    proposal: ConstitutionalChangeProposal,
  ): Promise<ConstitutionalChangeProposal> {
    const parsed = ConstitutionalChangeProposalSchema.parse(proposal);
    this.byId.set(parsed.constitutionalChangeProposalId, parsed);
    return parsed;
  }

  async getById(
    proposalId: string,
  ): Promise<ConstitutionalChangeProposal | null> {
    return this.byId.get(proposalId) ?? null;
  }

  async transition(
    proposalId: string,
    fromStatus: ConstitutionalChangeProposal["status"],
    expectedRevision: number,
    toStatus: ConstitutionalChangeProposal["status"],
    _updatedAt: string,
    patch?: Partial<ConstitutionalChangeProposal>,
  ): Promise<ConstitutionalChangeProposal> {
    const existing = this.byId.get(proposalId);
    if (!existing) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROPOSAL_NOT_FOUND",
        `Proposal ${proposalId} not found`,
      );
    }
    assertCasTransition({
      entity: "proposal",
      id: proposalId,
      existingStatus: existing.status,
      fromStatus,
      existingRevision: existing.recordRevision,
      expectedRevision,
    });
    const next = ConstitutionalChangeProposalSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    this.byId.set(proposalId, next);
    return next;
  }
}

export class InMemoryConstitutionalImpactAnalysisRepository
  implements ConstitutionalImpactAnalysisRepository
{
  private readonly byProposal = new Map<string, ConstitutionalImpactAnalysis>();

  async save(
    analysis: ConstitutionalImpactAnalysis,
  ): Promise<ConstitutionalImpactAnalysis> {
    const parsed = ConstitutionalImpactAnalysisSchema.parse(analysis);
    this.byProposal.set(parsed.proposalId, parsed);
    return parsed;
  }

  async getLatestByProposal(
    proposalId: string,
  ): Promise<ConstitutionalImpactAnalysis | null> {
    return this.byProposal.get(proposalId) ?? null;
  }
}

export class InMemoryConstitutionalReviewDecisionRepository
  implements ConstitutionalReviewDecisionRepository
{
  private readonly byId = new Map<string, ConstitutionalReviewDecision>();
  private readonly byProposal = new Map<string, ConstitutionalReviewDecision[]>();

  async save(
    decision: ConstitutionalReviewDecision,
  ): Promise<ConstitutionalReviewDecision> {
    const parsed = ConstitutionalReviewDecisionSchema.parse(decision);
    this.byId.set(parsed.decisionId, parsed);
    const list = this.byProposal.get(parsed.proposalId) ?? [];
    list.push(parsed);
    this.byProposal.set(parsed.proposalId, list);
    return parsed;
  }

  async getById(
    decisionId: string,
  ): Promise<ConstitutionalReviewDecision | null> {
    return this.byId.get(decisionId) ?? null;
  }

  async listByProposal(
    proposalId: string,
  ): Promise<ConstitutionalReviewDecision[]> {
    return [...(this.byProposal.get(proposalId) ?? [])];
  }
}

export class InMemoryConstitutionalActivationRecordRepository
  implements ConstitutionalActivationRecordRepository
{
  private readonly byId = new Map<string, ConstitutionalActivationRecord>();
  private readonly byProposal = new Map<string, ConstitutionalActivationRecord>();
  private readonly byIdempotency = new Map<string, ConstitutionalActivationRecord>();

  async save(
    record: ConstitutionalActivationRecord,
  ): Promise<ConstitutionalActivationRecord> {
    const parsed = ConstitutionalActivationRecordSchema.parse(record);
    this.byId.set(parsed.activationRecordId, parsed);
    this.byProposal.set(parsed.proposalId, parsed);
    const key = mintActivationIdempotencyKey({
      proposalId: parsed.proposalId,
      proposalVersion: parsed.proposalVersion,
      proposalHash: parsed.proposalHash,
    });
    this.byIdempotency.set(key, parsed);
    return parsed;
  }

  async getById(
    recordId: string,
  ): Promise<ConstitutionalActivationRecord | null> {
    return this.byId.get(recordId) ?? null;
  }

  async getByProposal(
    proposalId: string,
  ): Promise<ConstitutionalActivationRecord | null> {
    return this.byProposal.get(proposalId) ?? null;
  }

  async getByIdempotencyKey(
    key: string,
  ): Promise<ConstitutionalActivationRecord | null> {
    return this.byIdempotency.get(key) ?? null;
  }

  registerIdempotency(
    key: string,
    record: ConstitutionalActivationRecord,
  ): void {
    this.byIdempotency.set(key, record);
  }
}

export class InMemoryConstitutionalAuditRepository
  implements ConstitutionalAuditRepository
{
  private readonly events: ConstitutionalAuditEvent[] = [];

  async append(
    event: ConstitutionalAuditEvent,
  ): Promise<ConstitutionalAuditEvent> {
    this.events.push(event);
    return event;
  }

  async listByProposal(proposalId: string): Promise<ConstitutionalAuditEvent[]> {
    return this.events.filter((e) => e.proposalId === proposalId);
  }
}
