import { parseCausalQuestion, type CausalQuestion } from "./question.js";
import { canTransitionCausalQuestion } from "./causal-state.js";
import { CausalError } from "./errors.js";
import { CausalGraphSchema, type CausalGraph } from "./graph.js";
import {
  CausalEvidenceReferenceSchema,
  type CausalEvidenceReference,
} from "./evidence.js";
import {
  CausalIdentificationAnalysisSchema,
  type CausalIdentificationAnalysis,
} from "./identification.js";
import { CausalEstimateSchema, type CausalEstimate } from "./estimator.js";
import {
  CausalEvidenceSynthesisSchema,
  type CausalEvidenceSynthesis,
} from "./synthesis.js";
import {
  CausalClaimCandidateSchema,
  type CausalClaimCandidate,
} from "./claim.js";
import {
  CausalReviewRecordSchema,
  CausalReviewRequestSchema,
  type CausalReviewRecord,
  type CausalReviewRequest,
} from "./review.js";
import {
  PromotedCausalClaimSchema,
  type PromotedCausalClaim,
} from "./promotion.js";
import {
  CausalEvidenceGapSchema,
  DecisionModelCalibrationCandidateSchema,
  type CausalEvidenceGap,
  type DecisionModelCalibrationCandidate,
} from "./calibration.js";
import type {
  CausalClaimCandidateRepository,
  CausalEstimateRepository,
  CausalEvidenceGapRepository,
  CausalEvidenceReferenceRepository,
  CausalEvidenceSynthesisRepository,
  CausalGraphRepository,
  CausalIdentificationAnalysisRepository,
  CausalQuestionRepository,
  CausalReviewRecordRepository,
  CausalReviewRequestRepository,
  CausalUsageLedgerRepository,
  CausalUsageSnapshot,
  DecisionModelCalibrationCandidateRepository,
  PromotedCausalClaimRepository,
} from "./repositories.js";
import { emptyCausalUsage } from "./budget-ledger.js";

export class InMemoryCausalQuestionRepository
  implements CausalQuestionRepository
{
  private readonly byId = new Map<string, CausalQuestion>();
  private readonly byIdem = new Map<string, string>();

  async getById(id: string): Promise<CausalQuestion | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<CausalQuestion | null> {
    const id = this.byIdem.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async save(question: CausalQuestion): Promise<CausalQuestion> {
    const parsed = parseCausalQuestion(question);
    this.byId.set(parsed.causalQuestionId, parsed);
    this.byIdem.set(parsed.idempotencyKey, parsed.causalQuestionId);
    return parsed;
  }

  async transition(
    causalQuestionId: string,
    fromStatus: CausalQuestion["status"],
    expectedRevision: number,
    toStatus: CausalQuestion["status"],
    updatedAt: string,
    patch: Partial<CausalQuestion> = {},
  ): Promise<CausalQuestion> {
    const existing = this.byId.get(causalQuestionId);
    if (!existing) {
      throw new CausalError(
        "CAUSAL_QUESTION_NOT_FOUND",
        `Causal question ${causalQuestionId} missing`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new CausalError(
        "CAUSAL_STATE_CONFLICT",
        `Causal question ${causalQuestionId} state/revision mismatch`,
      );
    }
    if (!canTransitionCausalQuestion(fromStatus, toStatus)) {
      throw new CausalError(
        "INVALID_CAUSAL_TRANSITION",
        `Illegal transition ${fromStatus} → ${toStatus}`,
      );
    }
    const safePatch = { ...patch };
    delete safePatch.causalQuestionId;
    delete safePatch.status;
    delete safePatch.recordRevision;
    delete safePatch.updatedAt;
    const updated = parseCausalQuestion({
      ...existing,
      ...safePatch,
      status: toStatus,
      updatedAt,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(causalQuestionId, updated);
    return updated;
  }

  async listByStates(
    states: readonly CausalQuestion["status"][],
  ): Promise<CausalQuestion[]> {
    const set = new Set(states);
    return [...this.byId.values()]
      .filter((q) => set.has(q.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
}

export class InMemoryCausalGraphRepository implements CausalGraphRepository {
  private readonly graphs: CausalGraph[] = [];

  async save(graph: CausalGraph): Promise<CausalGraph> {
    const parsed = CausalGraphSchema.parse(graph);
    this.graphs.push(parsed);
    return parsed;
  }

  async getLatestByQuestion(causalQuestionId: string): Promise<CausalGraph | null> {
    const matches = this.graphs.filter(
      (g) => g.causalQuestionId === causalQuestionId,
    );
    return matches.sort((a, b) => b.causalGraphVersion - a.causalGraphVersion)[0] ?? null;
  }

  async getByIdVersion(
    causalGraphId: string,
    version: number,
  ): Promise<CausalGraph | null> {
    return (
      this.graphs.find(
        (g) =>
          g.causalGraphId === causalGraphId && g.causalGraphVersion === version,
      ) ?? null
    );
  }
}

function mapRepo<T extends { [k: string]: unknown }>(
  parse: (v: unknown) => T,
  idOf: (v: T) => string,
) {
  const byId = new Map<string, T>();
  return {
    byId,
    async save(item: T): Promise<T> {
      const parsed = parse(item);
      byId.set(idOf(parsed), parsed);
      return parsed;
    },
    async getById(id: string): Promise<T | null> {
      return byId.get(id) ?? null;
    },
    async list(pred: (v: T) => boolean): Promise<T[]> {
      return [...byId.values()].filter(pred);
    },
  };
}

export class InMemoryCausalEvidenceReferenceRepository
  implements CausalEvidenceReferenceRepository
{
  private readonly byId = new Map<string, CausalEvidenceReference>();
  private questionIndex = new Map<string, Set<string>>();

  bindQuestion(causalQuestionId: string, evidenceRefId: string): void {
    const set = this.questionIndex.get(causalQuestionId) ?? new Set();
    set.add(evidenceRefId);
    this.questionIndex.set(causalQuestionId, set);
  }

  async save(ref: CausalEvidenceReference): Promise<CausalEvidenceReference> {
    const parsed = CausalEvidenceReferenceSchema.parse(ref);
    this.byId.set(parsed.evidenceRefId, parsed);
    return parsed;
  }

  async listByQuestion(
    causalQuestionId: string,
  ): Promise<CausalEvidenceReference[]> {
    const ids = this.questionIndex.get(causalQuestionId);
    if (!ids || ids.size === 0) {
      return [];
    }
    const out: CausalEvidenceReference[] = [];
    for (const evidenceRefId of ids) {
      const ref = this.byId.get(evidenceRefId);
      if (ref) {
        out.push(ref);
      }
    }
    return out;
  }
}

export class InMemoryCausalIdentificationAnalysisRepository
  implements CausalIdentificationAnalysisRepository
{
  private readonly store = mapRepo(
    (v) => CausalIdentificationAnalysisSchema.parse(v),
    (v) => v.identificationAnalysisId,
  );
  private latest = new Map<string, string>();

  async save(
    analysis: CausalIdentificationAnalysis,
  ): Promise<CausalIdentificationAnalysis> {
    const saved = await this.store.save(analysis);
    this.latest.set(saved.causalQuestionId, saved.identificationAnalysisId);
    return saved;
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalIdentificationAnalysis | null> {
    const id = this.latest.get(causalQuestionId);
    return id ? this.store.getById(id) : null;
  }

  async getById(
    identificationAnalysisId: string,
  ): Promise<CausalIdentificationAnalysis | null> {
    return this.store.getById(identificationAnalysisId);
  }
}

export class InMemoryCausalEstimateRepository
  implements CausalEstimateRepository
{
  private readonly store = mapRepo(
    (v) => CausalEstimateSchema.parse(v),
    (v) => v.causalEstimateId,
  );

  async save(estimate: CausalEstimate): Promise<CausalEstimate> {
    return this.store.save(estimate);
  }

  async listByQuestion(causalQuestionId: string): Promise<CausalEstimate[]> {
    return this.store.list((e) => e.causalQuestionId === causalQuestionId);
  }

  async getById(causalEstimateId: string): Promise<CausalEstimate | null> {
    return this.store.getById(causalEstimateId);
  }
}

export class InMemoryCausalEvidenceSynthesisRepository
  implements CausalEvidenceSynthesisRepository
{
  private readonly store = mapRepo(
    (v) => CausalEvidenceSynthesisSchema.parse(v),
    (v) => v.evidenceSynthesisId,
  );
  private latest = new Map<string, string>();

  async save(
    synthesis: CausalEvidenceSynthesis,
  ): Promise<CausalEvidenceSynthesis> {
    const saved = await this.store.save(synthesis);
    this.latest.set(saved.causalQuestionId, saved.evidenceSynthesisId);
    return saved;
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalEvidenceSynthesis | null> {
    const id = this.latest.get(causalQuestionId);
    return id ? this.store.getById(id) : null;
  }
}

export class InMemoryCausalClaimCandidateRepository
  implements CausalClaimCandidateRepository
{
  private readonly store = mapRepo(
    (v) => CausalClaimCandidateSchema.parse(v),
    (v) => v.claimId,
  );
  private latest = new Map<string, string>();

  async save(claim: CausalClaimCandidate): Promise<CausalClaimCandidate> {
    const saved = await this.store.save(claim);
    this.latest.set(saved.causalQuestionId, saved.claimId);
    return saved;
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalClaimCandidate | null> {
    const id = this.latest.get(causalQuestionId);
    return id ? this.store.getById(id) : null;
  }

  async getById(claimId: string): Promise<CausalClaimCandidate | null> {
    return this.store.getById(claimId);
  }
}

export class InMemoryCausalReviewRequestRepository
  implements CausalReviewRequestRepository
{
  private readonly byId = new Map<string, CausalReviewRequest>();

  async save(request: CausalReviewRequest): Promise<CausalReviewRequest> {
    const parsed = CausalReviewRequestSchema.parse(request);
    this.byId.set(parsed.reviewRequestId, parsed);
    return parsed;
  }

  async getById(id: string): Promise<CausalReviewRequest | null> {
    return this.byId.get(id) ?? null;
  }

  async getPendingByQuestion(
    causalQuestionId: string,
  ): Promise<CausalReviewRequest | null> {
    return (
      [...this.byId.values()].find(
        (r) =>
          r.causalQuestionId === causalQuestionId && r.status === "PENDING",
      ) ?? null
    );
  }

  async update(request: CausalReviewRequest): Promise<CausalReviewRequest> {
    return this.save({
      ...request,
      recordRevision: request.recordRevision + 1,
    });
  }
}

export class InMemoryCausalReviewRecordRepository
  implements CausalReviewRecordRepository
{
  private readonly byRequest = new Map<string, CausalReviewRecord>();

  async save(record: CausalReviewRecord): Promise<CausalReviewRecord> {
    const parsed = CausalReviewRecordSchema.parse(record);
    this.byRequest.set(parsed.reviewRequestId, parsed);
    return parsed;
  }

  async getByRequest(
    reviewRequestId: string,
  ): Promise<CausalReviewRecord | null> {
    return this.byRequest.get(reviewRequestId) ?? null;
  }
}

export class InMemoryPromotedCausalClaimRepository
  implements PromotedCausalClaimRepository
{
  private readonly byId = new Map<string, PromotedCausalClaim>();

  async save(claim: PromotedCausalClaim): Promise<PromotedCausalClaim> {
    const parsed = PromotedCausalClaimSchema.parse(claim);
    this.byId.set(parsed.promotedCausalClaimId, parsed);
    return parsed;
  }

  async getById(id: string): Promise<PromotedCausalClaim | null> {
    return this.byId.get(id) ?? null;
  }

  async listByQuestion(
    causalQuestionId: string,
  ): Promise<PromotedCausalClaim[]> {
    return [...this.byId.values()].filter(
      (c) => c.causalQuestionId === causalQuestionId,
    );
  }

  async markStale(
    promotedCausalClaimId: string,
    staleReason: string,
  ): Promise<PromotedCausalClaim> {
    const existing = this.byId.get(promotedCausalClaimId);
    if (!existing) {
      throw new CausalError(
        "CAUSAL_CLAIM_STALE",
        `Promoted claim ${promotedCausalClaimId} not found`,
      );
    }
    const next = PromotedCausalClaimSchema.parse({
      ...existing,
      status: "STALE",
      staleReason,
    });
    this.byId.set(promotedCausalClaimId, next);
    return next;
  }
}

export class InMemoryDecisionModelCalibrationCandidateRepository
  implements DecisionModelCalibrationCandidateRepository
{
  private readonly items: DecisionModelCalibrationCandidate[] = [];

  async save(
    candidate: DecisionModelCalibrationCandidate,
  ): Promise<DecisionModelCalibrationCandidate> {
    const parsed = DecisionModelCalibrationCandidateSchema.parse(candidate);
    this.items.push(parsed);
    return parsed;
  }

  async listByPromotedClaim(
    promotedCausalClaimId: string,
  ): Promise<DecisionModelCalibrationCandidate[]> {
    return this.items.filter((c) =>
      c.sourcePromotedCausalClaimIds.includes(promotedCausalClaimId),
    );
  }
}

export class InMemoryCausalEvidenceGapRepository
  implements CausalEvidenceGapRepository
{
  private readonly items: CausalEvidenceGap[] = [];

  async save(gap: CausalEvidenceGap): Promise<CausalEvidenceGap> {
    const parsed = CausalEvidenceGapSchema.parse(gap);
    this.items.push(parsed);
    return parsed;
  }

  async listByQuestion(causalQuestionId: string): Promise<CausalEvidenceGap[]> {
    return this.items.filter((g) => g.causalQuestionId === causalQuestionId);
  }
}

export class InMemoryCausalUsageLedgerRepository
  implements CausalUsageLedgerRepository
{
  private readonly byId = new Map<string, CausalUsageSnapshot>();

  async get(causalQuestionId: string): Promise<CausalUsageSnapshot | null> {
    return this.byId.get(causalQuestionId) ?? null;
  }

  async save(
    causalQuestionId: string,
    snapshot: CausalUsageSnapshot,
    expectedRevision: number | null,
  ): Promise<CausalUsageSnapshot> {
    const existing = this.byId.get(causalQuestionId);
    if (expectedRevision !== null) {
      if (!existing || existing.recordRevision !== expectedRevision) {
        throw new CausalError(
          "CAUSAL_CAS_CONFLICT",
          `Usage ledger CAS conflict for ${causalQuestionId}`,
        );
      }
    }
    const next = {
      ...snapshot,
      recordRevision: (existing?.recordRevision ?? 0) + 1,
    };
    this.byId.set(causalQuestionId, next);
    return next;
  }

  ensure(causalQuestionId: string, nowIso: string): CausalUsageSnapshot {
    const existing = this.byId.get(causalQuestionId);
    if (existing) return existing;
    const empty = emptyCausalUsage(nowIso);
    this.byId.set(causalQuestionId, empty);
    return empty;
  }
}
