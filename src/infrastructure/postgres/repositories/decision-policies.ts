import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import { parseDecisionContext, type DecisionContext } from "../../../decision-policies/context.js";
import {
  parseDecisionPolicyCandidate,
  type DecisionPolicyCandidate,
} from "../../../decision-policies/policy.js";
import { canTransitionDecisionPolicy } from "../../../decision-policies/policy-state.js";
import { DecisionPolicyError } from "../../../decision-policies/errors.js";
import {
  DecisionPolicyEvaluationSchema,
  type DecisionPolicyEvaluation,
} from "../../../decision-policies/evaluation.js";
import {
  DecisionPolicyComparisonSchema,
  type DecisionPolicyComparison,
} from "../../../decision-policies/comparison.js";
import {
  DecisionPolicyApprovalRecordSchema,
  DecisionPolicyApprovalRequestSchema,
  DecisionPolicyActivationRecordSchema,
  DecisionPolicyActivationRequestSchema,
  type DecisionPolicyApprovalRecord,
  type DecisionPolicyApprovalRequest,
  type DecisionPolicyActivationRecord,
  type DecisionPolicyActivationRequest,
} from "../../../decision-policies/authority.js";
import {
  DecisionStateSnapshotSchema,
  type DecisionStateSnapshot,
} from "../../../decision-policies/snapshot.js";
import {
  DecisionOverrideRecordSchema,
  DecisionPolicyPerformanceRecordSchema,
  DecisionPolicyRevisionCandidateSchema,
  DecisionPolicyShadowEvaluationSchema,
  DecisionRecommendationSchema,
  ShadowDecisionRecordSchema,
  type DecisionOverrideRecord,
  type DecisionPolicyPerformanceRecord,
  type DecisionPolicyRevisionCandidate,
  type DecisionPolicyShadowEvaluation,
  type DecisionRecommendation,
  type ShadowDecisionRecord,
} from "../../../decision-policies/shadow-recommendation.js";
import type {
  DecisionContextRepository,
  DecisionOverrideRecordRepository,
  DecisionPolicyActivationRecordRepository,
  DecisionPolicyActivationRequestRepository,
  DecisionPolicyApprovalRecordRepository,
  DecisionPolicyApprovalRequestRepository,
  DecisionPolicyCandidateRepository,
  DecisionPolicyComparisonRepository,
  DecisionPolicyEvaluationRepository,
  DecisionPolicyPerformanceRecordRepository,
  DecisionPolicyRevisionCandidateRepository,
  DecisionPolicyShadowEvaluationRepository,
  DecisionPolicyShadowRecordRepository,
  DecisionPolicyUsageLedgerRepository,
  DecisionPolicyUsageSnapshot,
  DecisionRecommendationRepository,
  DecisionStateSnapshotRepository,
} from "../../../decision-policies/repositories.js";

export class PostgresDecisionContextRepository
  implements DecisionContextRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(decisionContextId: string): Promise<DecisionContext | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM decision_contexts
       WHERE decision_context_id = $1`,
      [decisionContextId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseDecisionContext({
      ...hydrateRecord(
        (i) => parseDecisionContext(i),
        row.payload,
        "decision_contexts",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async save(context: DecisionContext): Promise<DecisionContext> {
    const parsed = parseDecisionContext(context);
    try {
      await this.db.query(
        `INSERT INTO decision_contexts (
           decision_context_id, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2::jsonb,$3,$4::timestamptz,$5::timestamptz)
         ON CONFLICT (decision_context_id) DO UPDATE
         SET payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.decisionContextId,
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
}

export class PostgresDecisionPolicyCandidateRepository
  implements DecisionPolicyCandidateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(decisionPolicyId: string): Promise<DecisionPolicyCandidate | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM decision_policy_candidates
       WHERE decision_policy_id = $1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseDecisionPolicyCandidate({
      ...hydrateRecord(
        (i) => parseDecisionPolicyCandidate(i),
        row.payload,
        "decision_policy_candidates",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async getByIdVersion(
    decisionPolicyId: string,
    version: number,
  ): Promise<DecisionPolicyCandidate | null> {
    const policy = await this.getById(decisionPolicyId);
    if (!policy || policy.decisionPolicyVersion !== version) {
      return null;
    }
    return policy;
  }

  async save(policy: DecisionPolicyCandidate): Promise<DecisionPolicyCandidate> {
    const parsed = parseDecisionPolicyCandidate(policy);
    try {
      await this.db.query(
        `INSERT INTO decision_policy_candidates (
           decision_policy_id, status, payload, record_revision,
           created_at, updated_at
         ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
         ON CONFLICT (decision_policy_id) DO UPDATE
         SET status = EXCLUDED.status,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.decisionPolicyId,
          parsed.status,
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
    policy: DecisionPolicyCandidate,
    expectedRevision: number,
  ): Promise<DecisionPolicyCandidate> {
    const parsed = parseDecisionPolicyCandidate({
      ...policy,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE decision_policy_candidates
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz
       WHERE decision_policy_id = $1 AND record_revision = $6`,
      [
        parsed.decisionPolicyId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_CAS_CONFLICT",
        `CAS conflict for decision policy ${parsed.decisionPolicyId}`,
      );
    }
    return parsed;
  }

  async transition(
    decisionPolicyId: string,
    fromStatus: DecisionPolicyCandidate["status"],
    expectedRevision: number,
    toStatus: DecisionPolicyCandidate["status"],
    updatedAt: string,
    patch: Partial<DecisionPolicyCandidate> = {},
  ): Promise<DecisionPolicyCandidate> {
    const existing = await this.getById(decisionPolicyId);
    if (!existing) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_NOT_FOUND",
        `Decision policy ${decisionPolicyId} missing`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new DecisionPolicyError(
        "DECISION_POLICY_STATE_CONFLICT",
        `Decision policy ${decisionPolicyId} state/revision mismatch`,
      );
    }
    if (!canTransitionDecisionPolicy(fromStatus, toStatus)) {
      throw new DecisionPolicyError(
        "INVALID_DECISION_POLICY_TRANSITION",
        `Illegal transition ${fromStatus} → ${toStatus}`,
      );
    }
    const safePatch = { ...patch };
    delete safePatch.decisionPolicyId;
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
    states: readonly DecisionPolicyCandidate["status"][],
  ): Promise<DecisionPolicyCandidate[]> {
    if (states.length === 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM decision_policy_candidates
       WHERE status = ANY($1::text[])
       ORDER BY updated_at ASC, decision_policy_id ASC`,
      [[...states]],
    );
    return result.rows.map((row) =>
      parseDecisionPolicyCandidate({
        ...hydrateRecord(
          (i) => parseDecisionPolicyCandidate(i),
          row.payload,
          "decision_policy_candidates",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresDecisionPolicyEvaluationRepository
  implements DecisionPolicyEvaluationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(evaluation: DecisionPolicyEvaluation): Promise<DecisionPolicyEvaluation> {
    const parsed = DecisionPolicyEvaluationSchema.parse(evaluation);
    await this.db.query(
      `INSERT INTO decision_policy_evaluations (
         decision_policy_evaluation_id, decision_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_policy_evaluation_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.decisionPolicyEvaluationId,
        parsed.decisionPolicyId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyEvaluation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_evaluations
       WHERE decision_policy_evaluation_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyEvaluationSchema.parse(i),
          row.payload,
          "decision_policy_evaluations",
        )
      : null;
  }

  async getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyEvaluation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_evaluations
       WHERE decision_policy_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyEvaluationSchema.parse(i),
          row.payload,
          "decision_policy_evaluations",
        )
      : null;
  }
}

export class PostgresDecisionPolicyComparisonRepository
  implements DecisionPolicyComparisonRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(comparison: DecisionPolicyComparison): Promise<DecisionPolicyComparison> {
    const parsed = DecisionPolicyComparisonSchema.parse(comparison);
    await this.db.query(
      `INSERT INTO decision_policy_comparisons (
         decision_policy_comparison_id, payload, record_revision,
         created_at, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4::timestamptz,$5::timestamptz)
       ON CONFLICT (decision_policy_comparison_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionPolicyComparisonId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyComparison | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_comparisons
       WHERE decision_policy_comparison_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyComparisonSchema.parse(i),
          row.payload,
          "decision_policy_comparisons",
        )
      : null;
  }
}

export class PostgresDecisionPolicyApprovalRequestRepository
  implements DecisionPolicyApprovalRequestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    request: DecisionPolicyApprovalRequest,
  ): Promise<DecisionPolicyApprovalRequest> {
    const parsed = DecisionPolicyApprovalRequestSchema.parse(request);
    await this.db.query(
      `INSERT INTO decision_policy_approval_requests (
         decision_policy_approval_request_id, decision_policy_id, status,
         payload, record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz,$7::timestamptz)
       ON CONFLICT (decision_policy_approval_request_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.decisionPolicyApprovalRequestId,
        parsed.decisionPolicyId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.createdAt,
        parsed.decidedAt ?? parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyApprovalRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_approval_requests
       WHERE decision_policy_approval_request_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyApprovalRequestSchema.parse(i),
          row.payload,
          "decision_policy_approval_requests",
        )
      : null;
  }

  async getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyApprovalRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_approval_requests
       WHERE decision_policy_id = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyApprovalRequestSchema.parse(i),
          row.payload,
          "decision_policy_approval_requests",
        )
      : null;
  }
}

export class PostgresDecisionPolicyApprovalRecordRepository
  implements DecisionPolicyApprovalRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: DecisionPolicyApprovalRecord,
  ): Promise<DecisionPolicyApprovalRecord> {
    const parsed = DecisionPolicyApprovalRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO decision_policy_approval_records (
         decision_policy_approval_record_id, decision_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_policy_approval_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionPolicyApprovalRecordId,
        parsed.decisionPolicyId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyApprovalRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_approval_records
       WHERE decision_policy_approval_record_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyApprovalRecordSchema.parse(i),
          row.payload,
          "decision_policy_approval_records",
        )
      : null;
  }
}

export class PostgresDecisionPolicyShadowRecordRepository
  implements DecisionPolicyShadowRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(record: ShadowDecisionRecord): Promise<ShadowDecisionRecord> {
    const parsed = ShadowDecisionRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO decision_policy_shadow_records (
         shadow_decision_record_id, decision_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (shadow_decision_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.shadowDecisionRecordId,
        parsed.decisionPolicyId,
        JSON.stringify(parsed),
        1,
        parsed.timestamp,
        parsed.timestamp,
      ],
    );
    return parsed;
  }

  async listByPolicy(decisionPolicyId: string): Promise<ShadowDecisionRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_shadow_records
       WHERE decision_policy_id = $1
       ORDER BY created_at ASC`,
      [decisionPolicyId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ShadowDecisionRecordSchema.parse(i),
        row.payload,
        "decision_policy_shadow_records",
      ),
    );
  }
}

export class PostgresDecisionPolicyShadowEvaluationRepository
  implements DecisionPolicyShadowEvaluationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    evaluation: DecisionPolicyShadowEvaluation,
  ): Promise<DecisionPolicyShadowEvaluation> {
    const parsed = DecisionPolicyShadowEvaluationSchema.parse(evaluation);
    await this.db.query(
      `INSERT INTO decision_policy_shadow_evaluations (
         decision_policy_shadow_evaluation_id, decision_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_policy_shadow_evaluation_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionPolicyShadowEvaluationId,
        parsed.decisionPolicyId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyShadowEvaluation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_shadow_evaluations
       WHERE decision_policy_shadow_evaluation_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyShadowEvaluationSchema.parse(i),
          row.payload,
          "decision_policy_shadow_evaluations",
        )
      : null;
  }

  async getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyShadowEvaluation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_shadow_evaluations
       WHERE decision_policy_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyShadowEvaluationSchema.parse(i),
          row.payload,
          "decision_policy_shadow_evaluations",
        )
      : null;
  }
}

export class PostgresDecisionPolicyActivationRequestRepository
  implements DecisionPolicyActivationRequestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    request: DecisionPolicyActivationRequest,
  ): Promise<DecisionPolicyActivationRequest> {
    const parsed = DecisionPolicyActivationRequestSchema.parse(request);
    await this.db.query(
      `INSERT INTO decision_policy_activation_requests (
         decision_policy_activation_request_id, decision_policy_id, status,
         payload, record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz,$7::timestamptz)
       ON CONFLICT (decision_policy_activation_request_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.decisionPolicyActivationRequestId,
        parsed.decisionPolicyId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.createdAt,
        parsed.decidedAt ?? parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyActivationRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_activation_requests
       WHERE decision_policy_activation_request_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyActivationRequestSchema.parse(i),
          row.payload,
          "decision_policy_activation_requests",
        )
      : null;
  }

  async getLatestByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyActivationRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_activation_requests
       WHERE decision_policy_id = $1
       ORDER BY updated_at DESC LIMIT 1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyActivationRequestSchema.parse(i),
          row.payload,
          "decision_policy_activation_requests",
        )
      : null;
  }
}

export class PostgresDecisionPolicyActivationRecordRepository
  implements DecisionPolicyActivationRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: DecisionPolicyActivationRecord,
  ): Promise<DecisionPolicyActivationRecord> {
    const parsed = DecisionPolicyActivationRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO decision_policy_activation_records (
         decision_policy_activation_id, decision_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_policy_activation_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.decisionPolicyActivationId,
        parsed.decisionPolicyId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionPolicyActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_activation_records
       WHERE decision_policy_activation_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyActivationRecordSchema.parse(i),
          row.payload,
          "decision_policy_activation_records",
        )
      : null;
  }

  async getActiveByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyActivationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_activation_records
       WHERE decision_policy_id = $1
         AND payload->>'status' = 'ACTIVE'
       ORDER BY created_at DESC LIMIT 1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionPolicyActivationRecordSchema.parse(i),
          row.payload,
          "decision_policy_activation_records",
        )
      : null;
  }
}

export class PostgresDecisionStateSnapshotRepository
  implements DecisionStateSnapshotRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(snapshot: DecisionStateSnapshot): Promise<DecisionStateSnapshot> {
    const parsed = DecisionStateSnapshotSchema.parse(snapshot);
    const createdAt =
      Object.values(parsed.capturedAtByVariable)[0] ??
      new Date(0).toISOString();
    await this.db.query(
      `INSERT INTO decision_state_snapshots (
         decision_state_snapshot_id, payload, record_revision,
         created_at, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4::timestamptz,$5::timestamptz)
       ON CONFLICT (decision_state_snapshot_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionStateSnapshotId,
        JSON.stringify(parsed),
        1,
        createdAt,
        createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionStateSnapshot | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_state_snapshots
       WHERE decision_state_snapshot_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionStateSnapshotSchema.parse(i),
          row.payload,
          "decision_state_snapshots",
        )
      : null;
  }

  async getByHash(snapshotHash: string): Promise<DecisionStateSnapshot | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_state_snapshots
       WHERE payload->>'snapshotHash' = $1
       LIMIT 1`,
      [snapshotHash],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionStateSnapshotSchema.parse(i),
          row.payload,
          "decision_state_snapshots",
        )
      : null;
  }
}

export class PostgresDecisionRecommendationRepository
  implements DecisionRecommendationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    recommendation: DecisionRecommendation,
  ): Promise<DecisionRecommendation> {
    const parsed = DecisionRecommendationSchema.parse(recommendation);
    await this.db.query(
      `INSERT INTO decision_recommendations (
         decision_recommendation_id, payload, record_revision,
         created_at, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4::timestamptz,$5::timestamptz)
       ON CONFLICT (decision_recommendation_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.decisionRecommendationId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(id: string): Promise<DecisionRecommendation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_recommendations
       WHERE decision_recommendation_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionRecommendationSchema.parse(i),
          row.payload,
          "decision_recommendations",
        )
      : null;
  }

  async findByIdentityHash(
    recommendationHash: string,
  ): Promise<DecisionRecommendation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_recommendations
       WHERE payload->>'recommendationHash' = $1
       LIMIT 1`,
      [recommendationHash],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DecisionRecommendationSchema.parse(i),
          row.payload,
          "decision_recommendations",
        )
      : null;
  }
}

export class PostgresDecisionOverrideRecordRepository
  implements DecisionOverrideRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(record: DecisionOverrideRecord): Promise<DecisionOverrideRecord> {
    const parsed = DecisionOverrideRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO decision_override_records (
         decision_override_record_id, recommendation_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_override_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionOverrideRecordId,
        parsed.recommendationId,
        JSON.stringify(parsed),
        1,
        parsed.timestamp,
        parsed.timestamp,
      ],
    );
    return parsed;
  }

  async listByRecommendation(
    recommendationId: string,
  ): Promise<DecisionOverrideRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_override_records
       WHERE recommendation_id = $1
       ORDER BY created_at ASC`,
      [recommendationId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => DecisionOverrideRecordSchema.parse(i),
        row.payload,
        "decision_override_records",
      ),
    );
  }
}

export class PostgresDecisionPolicyPerformanceRecordRepository
  implements DecisionPolicyPerformanceRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: DecisionPolicyPerformanceRecord,
  ): Promise<DecisionPolicyPerformanceRecord> {
    const parsed = DecisionPolicyPerformanceRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO decision_policy_performance_records (
         decision_policy_performance_record_id, decision_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_policy_performance_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionPolicyPerformanceRecordId,
        parsed.decisionPolicyId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByPolicy(
    decisionPolicyId: string,
  ): Promise<DecisionPolicyPerformanceRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_performance_records
       WHERE decision_policy_id = $1
       ORDER BY created_at DESC`,
      [decisionPolicyId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => DecisionPolicyPerformanceRecordSchema.parse(i),
        row.payload,
        "decision_policy_performance_records",
      ),
    );
  }
}

export class PostgresDecisionPolicyRevisionCandidateRepository
  implements DecisionPolicyRevisionCandidateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    candidate: DecisionPolicyRevisionCandidate,
  ): Promise<DecisionPolicyRevisionCandidate> {
    const parsed = DecisionPolicyRevisionCandidateSchema.parse(candidate);
    await this.db.query(
      `INSERT INTO decision_policy_revision_candidates (
         decision_policy_revision_candidate_id, source_policy_id, payload,
         record_revision, created_at, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$6::timestamptz)
       ON CONFLICT (decision_policy_revision_candidate_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.decisionPolicyRevisionCandidateId,
        parsed.sourcePolicyId,
        JSON.stringify(parsed),
        1,
        parsed.createdAt,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listBySourcePolicy(
    sourcePolicyId: string,
  ): Promise<DecisionPolicyRevisionCandidate[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM decision_policy_revision_candidates
       WHERE source_policy_id = $1
       ORDER BY created_at DESC`,
      [sourcePolicyId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => DecisionPolicyRevisionCandidateSchema.parse(i),
        row.payload,
        "decision_policy_revision_candidates",
      ),
    );
  }
}

export class PostgresDecisionPolicyUsageLedgerRepository
  implements DecisionPolicyUsageLedgerRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async get(decisionPolicyId: string): Promise<DecisionPolicyUsageSnapshot | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM decision_policy_usage_ledgers
       WHERE decision_policy_id = $1`,
      [decisionPolicyId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const payload =
      typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    return {
      ...(payload as DecisionPolicyUsageSnapshot),
      recordRevision: Number(row.record_revision),
    };
  }

  async save(
    decisionPolicyId: string,
    snapshot: DecisionPolicyUsageSnapshot,
  ): Promise<DecisionPolicyUsageSnapshot> {
    const next = {
      ...snapshot,
      recordRevision: (snapshot.recordRevision ?? 0) + 1,
    };
    await this.db.query(
      `INSERT INTO decision_policy_usage_ledgers (
         decision_policy_id, payload, record_revision, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4::timestamptz)
       ON CONFLICT (decision_policy_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        decisionPolicyId,
        JSON.stringify(next),
        next.recordRevision,
        next.updatedAt,
      ],
    );
    return next;
  }
}
