import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import { canTransitionCausalQuestion } from "../../../causal/causal-state.js";
import { CausalError } from "../../../causal/errors.js";
import {
  parseCausalQuestion,
  type CausalQuestion,
} from "../../../causal/question.js";
import { CausalGraphSchema, type CausalGraph } from "../../../causal/graph.js";
import {
  CausalEvidenceReferenceSchema,
  type CausalEvidenceReference,
} from "../../../causal/evidence.js";
import {
  CausalIdentificationAnalysisSchema,
  type CausalIdentificationAnalysis,
} from "../../../causal/identification.js";
import {
  CausalEstimateSchema,
  type CausalEstimate,
} from "../../../causal/estimator.js";
import {
  CausalEvidenceSynthesisSchema,
  type CausalEvidenceSynthesis,
} from "../../../causal/synthesis.js";
import {
  CausalClaimCandidateSchema,
  type CausalClaimCandidate,
} from "../../../causal/claim.js";
import {
  CausalReviewRecordSchema,
  CausalReviewRequestSchema,
  type CausalReviewRecord,
  type CausalReviewRequest,
} from "../../../causal/review.js";
import {
  PromotedCausalClaimSchema,
  type PromotedCausalClaim,
} from "../../../causal/promotion.js";
import {
  CausalEvidenceGapSchema,
  DecisionModelCalibrationCandidateSchema,
  type CausalEvidenceGap,
  type DecisionModelCalibrationCandidate,
} from "../../../causal/calibration.js";
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
} from "../../../causal/repositories.js";

export class PostgresCausalQuestionRepository
  implements CausalQuestionRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(causalQuestionId: string): Promise<CausalQuestion | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM causal_questions
       WHERE causal_question_id = $1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseCausalQuestion({
      ...hydrateRecord(
        (i) => parseCausalQuestion(i),
        row.payload,
        "causal_questions",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async findByIdempotencyKey(key: string): Promise<CausalQuestion | null> {
    const result = await this.db.query<{ causal_question_id: string }>(
      `SELECT causal_question_id FROM causal_questions
       WHERE idempotency_key = $1`,
      [key],
    );
    const id = result.rows[0]?.causal_question_id;
    return id ? this.getById(id) : null;
  }

  async save(question: CausalQuestion): Promise<CausalQuestion> {
    const parsed = parseCausalQuestion(question);
    try {
      await this.db.query(
        `INSERT INTO causal_questions (
           causal_question_id, status, idempotency_key, content_fingerprint,
           payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$8::timestamptz)
         ON CONFLICT (causal_question_id) DO UPDATE
         SET status = EXCLUDED.status,
             content_fingerprint = EXCLUDED.content_fingerprint,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.causalQuestionId,
          parsed.status,
          parsed.idempotencyKey,
          parsed.contentFingerprint,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
          parsed.updatedAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  private async saveCas(
    question: CausalQuestion,
    expectedRevision: number,
  ): Promise<CausalQuestion> {
    const parsed = parseCausalQuestion({
      ...question,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE causal_questions
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz, content_fingerprint = $6
       WHERE causal_question_id = $1 AND record_revision = $7`,
      [
        parsed.causalQuestionId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        parsed.contentFingerprint,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new CausalError(
        "CAUSAL_CAS_CONFLICT",
        `CAS conflict for causal question ${parsed.causalQuestionId}`,
      );
    }
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
    const existing = await this.getById(causalQuestionId);
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
    return this.saveCas(
      {
        ...existing,
        ...safePatch,
        status: toStatus,
        updatedAt,
      },
      expectedRevision,
    );
  }

  async listByStates(
    states: readonly CausalQuestion["status"][],
  ): Promise<CausalQuestion[]> {
    if (states.length === 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM causal_questions
       WHERE status = ANY($1::text[])
       ORDER BY updated_at ASC, causal_question_id ASC`,
      [[...states]],
    );
    return result.rows.map((row) =>
      parseCausalQuestion({
        ...hydrateRecord(
          (i) => parseCausalQuestion(i),
          row.payload,
          "causal_questions",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresCausalGraphRepository implements CausalGraphRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(graph: CausalGraph): Promise<CausalGraph> {
    const parsed = CausalGraphSchema.parse(graph);
    try {
      await this.db.query(
        `INSERT INTO causal_graphs (
           causal_graph_id, causal_graph_version, causal_question_id,
           graph_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
        [
          parsed.causalGraphId,
          parsed.causalGraphVersion,
          parsed.causalQuestionId,
          parsed.graphHash,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalGraph | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_graphs
       WHERE causal_question_id = $1
       ORDER BY causal_graph_version DESC LIMIT 1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalGraphSchema.parse(i),
          row.payload,
          "causal_graphs",
        )
      : null;
  }

  async getByIdVersion(
    causalGraphId: string,
    version: number,
  ): Promise<CausalGraph | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_graphs
       WHERE causal_graph_id = $1 AND causal_graph_version = $2`,
      [causalGraphId, version],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalGraphSchema.parse(i),
          row.payload,
          "causal_graphs",
        )
      : null;
  }
}

export class PostgresCausalEvidenceReferenceRepository
  implements CausalEvidenceReferenceRepository
{
  private readonly questionIndex = new Map<string, Set<string>>();

  constructor(private readonly db: PostgresDatabase) {}

  /**
   * Persist question binding for listByQuestion. Service calls this after save.
   * Keeps an in-process index so listByQuestion is correct before the UPDATE lands.
   */
  bindQuestion(causalQuestionId: string, evidenceRefId: string): void {
    const set = this.questionIndex.get(causalQuestionId) ?? new Set();
    set.add(evidenceRefId);
    this.questionIndex.set(causalQuestionId, set);
    void this.db
      .query(
        `UPDATE causal_evidence_references
         SET causal_question_id = $2
         WHERE evidence_ref_id = $1`,
        [evidenceRefId, causalQuestionId],
      )
      .catch(() => undefined);
  }

  async save(ref: CausalEvidenceReference): Promise<CausalEvidenceReference> {
    const parsed = CausalEvidenceReferenceSchema.parse(ref);
    let boundQuestionId: string | null = null;
    for (const [questionId, ids] of this.questionIndex) {
      if (ids.has(parsed.evidenceRefId)) {
        boundQuestionId = questionId;
        break;
      }
    }
    await this.db.query(
      `INSERT INTO causal_evidence_references (
         evidence_ref_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (evidence_ref_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           causal_question_id = COALESCE(
             EXCLUDED.causal_question_id,
             causal_evidence_references.causal_question_id
           )`,
      [
        parsed.evidenceRefId,
        boundQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByQuestion(
    causalQuestionId: string,
  ): Promise<CausalEvidenceReference[]> {
    const result = await this.db.query<{
      evidence_ref_id: string;
      payload: unknown;
    }>(
      `SELECT evidence_ref_id, payload FROM causal_evidence_references
       WHERE causal_question_id = $1`,
      [causalQuestionId],
    );
    const byId = new Map(
      result.rows.map((row) => [
        row.evidence_ref_id,
        hydrateRecord(
          (i) => CausalEvidenceReferenceSchema.parse(i),
          row.payload,
          "causal_evidence_references",
        ),
      ]),
    );
    const pendingIds = this.questionIndex.get(causalQuestionId);
    if (pendingIds) {
      for (const evidenceRefId of pendingIds) {
        if (byId.has(evidenceRefId)) continue;
        const pending = await this.db.query<{ payload: unknown }>(
          `SELECT payload FROM causal_evidence_references
           WHERE evidence_ref_id = $1`,
          [evidenceRefId],
        );
        const row = pending.rows[0];
        if (row) {
          byId.set(
            evidenceRefId,
            hydrateRecord(
              (i) => CausalEvidenceReferenceSchema.parse(i),
              row.payload,
              "causal_evidence_references",
            ),
          );
        }
      }
    }
    return [...byId.values()];
  }
}

export class PostgresCausalIdentificationAnalysisRepository
  implements CausalIdentificationAnalysisRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    analysis: CausalIdentificationAnalysis,
  ): Promise<CausalIdentificationAnalysis> {
    const parsed = CausalIdentificationAnalysisSchema.parse(analysis);
    await this.db.query(
      `INSERT INTO causal_identification_analyses (
         identification_analysis_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (identification_analysis_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.identificationAnalysisId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalIdentificationAnalysis | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_identification_analyses
       WHERE causal_question_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalIdentificationAnalysisSchema.parse(i),
          row.payload,
          "causal_identification_analyses",
        )
      : null;
  }

  async getById(
    identificationAnalysisId: string,
  ): Promise<CausalIdentificationAnalysis | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_identification_analyses
       WHERE identification_analysis_id = $1`,
      [identificationAnalysisId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalIdentificationAnalysisSchema.parse(i),
          row.payload,
          "causal_identification_analyses",
        )
      : null;
  }
}

export class PostgresCausalEstimateRepository
  implements CausalEstimateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(estimate: CausalEstimate): Promise<CausalEstimate> {
    const parsed = CausalEstimateSchema.parse(estimate);
    await this.db.query(
      `INSERT INTO causal_estimates (
         causal_estimate_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (causal_estimate_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.causalEstimateId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByQuestion(causalQuestionId: string): Promise<CausalEstimate[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_estimates WHERE causal_question_id = $1`,
      [causalQuestionId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => CausalEstimateSchema.parse(i),
        row.payload,
        "causal_estimates",
      ),
    );
  }

  async getById(causalEstimateId: string): Promise<CausalEstimate | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_estimates WHERE causal_estimate_id = $1`,
      [causalEstimateId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalEstimateSchema.parse(i),
          row.payload,
          "causal_estimates",
        )
      : null;
  }
}

export class PostgresCausalEvidenceSynthesisRepository
  implements CausalEvidenceSynthesisRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    synthesis: CausalEvidenceSynthesis,
  ): Promise<CausalEvidenceSynthesis> {
    const parsed = CausalEvidenceSynthesisSchema.parse(synthesis);
    await this.db.query(
      `INSERT INTO causal_evidence_syntheses (
         evidence_synthesis_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (evidence_synthesis_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.evidenceSynthesisId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalEvidenceSynthesis | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_evidence_syntheses
       WHERE causal_question_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalEvidenceSynthesisSchema.parse(i),
          row.payload,
          "causal_evidence_syntheses",
        )
      : null;
  }
}

export class PostgresCausalClaimCandidateRepository
  implements CausalClaimCandidateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(claim: CausalClaimCandidate): Promise<CausalClaimCandidate> {
    const parsed = CausalClaimCandidateSchema.parse(claim);
    await this.db.query(
      `INSERT INTO causal_claim_candidates (
         claim_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (claim_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.claimId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getLatestByQuestion(
    causalQuestionId: string,
  ): Promise<CausalClaimCandidate | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_claim_candidates
       WHERE causal_question_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalClaimCandidateSchema.parse(i),
          row.payload,
          "causal_claim_candidates",
        )
      : null;
  }

  async getById(claimId: string): Promise<CausalClaimCandidate | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_claim_candidates WHERE claim_id = $1`,
      [claimId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalClaimCandidateSchema.parse(i),
          row.payload,
          "causal_claim_candidates",
        )
      : null;
  }
}

export class PostgresCausalReviewRequestRepository
  implements CausalReviewRequestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(request: CausalReviewRequest): Promise<CausalReviewRequest> {
    const parsed = CausalReviewRequestSchema.parse(request);
    await this.db.query(
      `INSERT INTO causal_review_requests (
         review_request_id, causal_question_id, status, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (review_request_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.reviewRequestId,
        parsed.causalQuestionId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(reviewRequestId: string): Promise<CausalReviewRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_review_requests
       WHERE review_request_id = $1`,
      [reviewRequestId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalReviewRequestSchema.parse(i),
          row.payload,
          "causal_review_requests",
        )
      : null;
  }

  async getPendingByQuestion(
    causalQuestionId: string,
  ): Promise<CausalReviewRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_review_requests
       WHERE causal_question_id = $1 AND status = 'PENDING'
       ORDER BY updated_at DESC LIMIT 1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalReviewRequestSchema.parse(i),
          row.payload,
          "causal_review_requests",
        )
      : null;
  }

  async update(request: CausalReviewRequest): Promise<CausalReviewRequest> {
    const existing = await this.getById(request.reviewRequestId);
    const nextRevision = (existing?.recordRevision ?? request.recordRevision) + 1;
    const parsed = CausalReviewRequestSchema.parse({
      ...request,
      recordRevision: nextRevision,
    });
    const result = await this.db.query(
      `UPDATE causal_review_requests
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz
       WHERE review_request_id = $1 AND record_revision = $6`,
      [
        parsed.reviewRequestId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
        existing?.recordRevision ?? request.recordRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new CausalError(
        "CAUSAL_CAS_CONFLICT",
        `Review request CAS conflict for ${parsed.reviewRequestId}`,
      );
    }
    return parsed;
  }
}

export class PostgresCausalReviewRecordRepository
  implements CausalReviewRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(record: CausalReviewRecord): Promise<CausalReviewRecord> {
    const parsed = CausalReviewRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO causal_review_records (
         review_record_id, review_request_id, causal_question_id,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (review_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.reviewRecordId,
        parsed.reviewRequestId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getByRequest(
    reviewRequestId: string,
  ): Promise<CausalReviewRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_review_records
       WHERE review_request_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [reviewRequestId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => CausalReviewRecordSchema.parse(i),
          row.payload,
          "causal_review_records",
        )
      : null;
  }
}

export class PostgresPromotedCausalClaimRepository
  implements PromotedCausalClaimRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(claim: PromotedCausalClaim): Promise<PromotedCausalClaim> {
    const parsed = PromotedCausalClaimSchema.parse(claim);
    await this.db.query(
      `INSERT INTO promoted_causal_claims (
         promoted_causal_claim_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (promoted_causal_claim_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.promotedCausalClaimId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.promotedAt,
      ],
    );
    return parsed;
  }

  async getById(
    promotedCausalClaimId: string,
  ): Promise<PromotedCausalClaim | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM promoted_causal_claims
       WHERE promoted_causal_claim_id = $1`,
      [promotedCausalClaimId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PromotedCausalClaimSchema.parse(i),
          row.payload,
          "promoted_causal_claims",
        )
      : null;
  }

  async listByQuestion(
    causalQuestionId: string,
  ): Promise<PromotedCausalClaim[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM promoted_causal_claims
       WHERE causal_question_id = $1`,
      [causalQuestionId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => PromotedCausalClaimSchema.parse(i),
        row.payload,
        "promoted_causal_claims",
      ),
    );
  }

  async markStale(
    promotedCausalClaimId: string,
    staleReason: string,
  ): Promise<PromotedCausalClaim> {
    const existing = await this.getById(promotedCausalClaimId);
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
    return this.save(next);
  }
}

export class PostgresDecisionModelCalibrationCandidateRepository
  implements DecisionModelCalibrationCandidateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    candidate: DecisionModelCalibrationCandidate,
  ): Promise<DecisionModelCalibrationCandidate> {
    const parsed = DecisionModelCalibrationCandidateSchema.parse(candidate);
    await this.db.query(
      `INSERT INTO decision_model_calibration_candidates (
         candidate_id, payload, created_at
       ) VALUES ($1,$2::jsonb,$3::timestamptz)
       ON CONFLICT (candidate_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [parsed.candidateId, JSON.stringify(parsed), parsed.createdAt],
    );
    return parsed;
  }

  async listByPromotedClaim(
    promotedCausalClaimId: string,
  ): Promise<DecisionModelCalibrationCandidate[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_model_calibration_candidates
       WHERE payload->'sourcePromotedCausalClaimIds' ? $1`,
      [promotedCausalClaimId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => DecisionModelCalibrationCandidateSchema.parse(i),
        row.payload,
        "decision_model_calibration_candidates",
      ),
    );
  }
}

export class PostgresCausalEvidenceGapRepository
  implements CausalEvidenceGapRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(gap: CausalEvidenceGap): Promise<CausalEvidenceGap> {
    const parsed = CausalEvidenceGapSchema.parse(gap);
    await this.db.query(
      `INSERT INTO causal_evidence_gaps (
         evidence_gap_id, causal_question_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (evidence_gap_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.evidenceGapId,
        parsed.causalQuestionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByQuestion(causalQuestionId: string): Promise<CausalEvidenceGap[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM causal_evidence_gaps
       WHERE causal_question_id = $1`,
      [causalQuestionId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => CausalEvidenceGapSchema.parse(i),
        row.payload,
        "causal_evidence_gaps",
      ),
    );
  }
}

export class PostgresCausalUsageLedgerRepository
  implements CausalUsageLedgerRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async get(causalQuestionId: string): Promise<CausalUsageSnapshot | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM causal_usage_ledgers
       WHERE causal_question_id = $1`,
      [causalQuestionId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const payload =
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    return {
      ...(payload as CausalUsageSnapshot),
      recordRevision: Number(row.record_revision),
    };
  }

  async save(
    causalQuestionId: string,
    snapshot: CausalUsageSnapshot,
    expectedRevision: number | null,
  ): Promise<CausalUsageSnapshot> {
    if (expectedRevision === null) {
      const next = { ...snapshot, recordRevision: 1 };
      await this.db.query(
        `INSERT INTO causal_usage_ledgers (
           causal_question_id, payload, record_revision, updated_at
         ) VALUES ($1,$2::jsonb,$3,$4::timestamptz)
         ON CONFLICT (causal_question_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          causalQuestionId,
          JSON.stringify(next),
          next.recordRevision,
          next.updatedAt,
        ],
      );
      return next;
    }
    const next = {
      ...snapshot,
      recordRevision: expectedRevision + 1,
    };
    const result = await this.db.query(
      `UPDATE causal_usage_ledgers
       SET payload = $2::jsonb, record_revision = $3, updated_at = $4::timestamptz
       WHERE causal_question_id = $1 AND record_revision = $5`,
      [
        causalQuestionId,
        JSON.stringify(next),
        next.recordRevision,
        next.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new CausalError(
        "CAUSAL_CAS_CONFLICT",
        `Usage ledger CAS conflict for ${causalQuestionId}`,
      );
    }
    return next;
  }
}
