import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import {
  ExperimentAuthorizationRecordSchema,
  ExperimentAuthorizationRequestSchema,
  type ExperimentAuthorizationRecord,
  type ExperimentAuthorizationRequest,
} from "../../../experiments/authorization.js";
import { canTransitionExperiment } from "../../../experiments/experiment-state-schema.js";
import {
  parseGovernedExperiment,
  type GovernedExperiment,
} from "../../../experiments/experiment.js";
import {
  AssumptionEvidenceUpdateCandidateSchema,
  ExperimentCompletionRecordSchema,
  ExperimentEvidenceBundleSchema,
  ExperimentExecutionLineageSchema,
  ExperimentResultSchema,
  type AssumptionEvidenceUpdateCandidate,
  type ExperimentCompletionRecord,
  type ExperimentEvidenceBundle,
  type ExperimentExecutionLineage,
  type ExperimentResult,
} from "../../../experiments/evidence.js";
import { ExperimentError } from "../../../experiments/errors.js";
import {
  ExperimentPlanSchema,
  type ExperimentPlan,
} from "../../../experiments/plan.js";
import type {
  AssumptionEvidenceUpdateCandidateRepository,
  ExperimentAuthorizationRecordRepository,
  ExperimentAuthorizationRequestRepository,
  ExperimentCompletionRecordRepository,
  ExperimentEvidenceBundleRepository,
  ExperimentExecutionLineageRepository,
  ExperimentPlanRepository,
  ExperimentRepository,
  ExperimentResultRepository,
  ExperimentUsageLedger,
  ExperimentUsageLedgerRepository,
} from "../../../experiments/repositories.js";
import { hydrateExperimentUsageLedger } from "../../../experiments/repositories.js";

export class PostgresExperimentRepository implements ExperimentRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async create(experiment: GovernedExperiment): Promise<GovernedExperiment> {
    const parsed = parseGovernedExperiment(experiment);
    try {
      await this.db.query(
        `INSERT INTO governed_experiments (
           experiment_id, project_id, experiment_version,
           status, idempotency_key, content_fingerprint, payload,
           record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz)`,
        [
          parsed.experimentId,
          parsed.projectId,
          parsed.experimentVersion,
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

  async getById(experimentId: string): Promise<GovernedExperiment | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governed_experiments
       WHERE experiment_id = $1`,
      [experimentId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseGovernedExperiment({
      ...hydrateRecord(
        (i) => parseGovernedExperiment(i),
        row.payload,
        "governed_experiments",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async getByIdempotencyKey(key: string): Promise<GovernedExperiment | null> {
    const result = await this.db.query<{ experiment_id: string }>(
      `SELECT experiment_id FROM governed_experiments
       WHERE idempotency_key = $1`,
      [key],
    );
    const id = result.rows[0]?.experiment_id;
    return id ? this.getById(id) : null;
  }

  async save(
    experiment: GovernedExperiment,
    expectedRevision: number,
  ): Promise<GovernedExperiment> {
    const parsed = parseGovernedExperiment({
      ...experiment,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE governed_experiments
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz, content_fingerprint = $6
       WHERE experiment_id = $1 AND record_revision = $7`,
      [
        parsed.experimentId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        parsed.contentFingerprint,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `CAS conflict for experiment ${parsed.experimentId}`,
      );
    }
    return parsed;
  }

  async transition(
    experimentId: string,
    fromStatus: GovernedExperiment["status"],
    expectedRevision: number,
    toStatus: GovernedExperiment["status"],
    updatedAt: string,
    patch: Partial<GovernedExperiment> = {},
  ): Promise<GovernedExperiment> {
    const existing = await this.getById(experimentId);
    if (!existing) {
      throw new ExperimentError(
        "EXPERIMENT_NOT_FOUND",
        `Experiment ${experimentId} missing`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Experiment ${experimentId} state/revision mismatch`,
      );
    }
    if (!canTransitionExperiment(fromStatus, toStatus)) {
      throw new ExperimentError(
        "INVALID_EXPERIMENT_TRANSITION",
        `Illegal transition ${fromStatus} → ${toStatus}`,
      );
    }
    const safePatch = { ...patch };
    delete safePatch.experimentId;
    delete safePatch.status;
    delete safePatch.recordRevision;
    delete safePatch.updatedAt;
    return this.save(
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
    states: readonly GovernedExperiment["status"][],
  ): Promise<readonly GovernedExperiment[]> {
    if (states.length === 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governed_experiments
       WHERE status = ANY($1::text[])
       ORDER BY updated_at ASC, experiment_id ASC`,
      [[...states]],
    );
    return result.rows.map((row) =>
      parseGovernedExperiment({
        ...hydrateRecord(
          (i) => parseGovernedExperiment(i),
          row.payload,
          "governed_experiments",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresExperimentPlanRepository
  implements ExperimentPlanRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(plan: ExperimentPlan): Promise<ExperimentPlan> {
    const parsed = ExperimentPlanSchema.parse(plan);
    try {
      await this.db.query(
        `INSERT INTO experiment_plans (
           experiment_id, experiment_plan_version, experiment_plan_hash,
           payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
        [
          parsed.experimentId,
          parsed.experimentPlanVersion,
          parsed.experimentPlanHash,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getLatest(experimentId: string): Promise<ExperimentPlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_plans
       WHERE experiment_id = $1
       ORDER BY experiment_plan_version DESC LIMIT 1`,
      [experimentId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentPlanSchema.parse(i),
          row.payload,
          "experiment_plans",
        )
      : null;
  }

  async getByHash(
    experimentId: string,
    experimentPlanHash: string,
  ): Promise<ExperimentPlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_plans
       WHERE experiment_id = $1 AND experiment_plan_hash = $2`,
      [experimentId, experimentPlanHash],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentPlanSchema.parse(i),
          row.payload,
          "experiment_plans",
        )
      : null;
  }
}

export class PostgresExperimentAuthorizationRequestRepository
  implements ExperimentAuthorizationRequestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    request: ExperimentAuthorizationRequest,
  ): Promise<ExperimentAuthorizationRequest> {
    const parsed = ExperimentAuthorizationRequestSchema.parse(request);
    await this.db.query(
      `INSERT INTO experiment_authorization_requests (
         authorization_id, experiment_id, status, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (authorization_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.authorizationId,
        parsed.experimentId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(
    authorizationId: string,
  ): Promise<ExperimentAuthorizationRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_authorization_requests
       WHERE authorization_id = $1`,
      [authorizationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentAuthorizationRequestSchema.parse(i),
          row.payload,
          "experiment_authorization_requests",
        )
      : null;
  }

  async getPending(
    experimentId: string,
  ): Promise<ExperimentAuthorizationRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_authorization_requests
       WHERE experiment_id = $1 AND status = 'PENDING'
       ORDER BY updated_at DESC LIMIT 1`,
      [experimentId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentAuthorizationRequestSchema.parse(i),
          row.payload,
          "experiment_authorization_requests",
        )
      : null;
  }

  async saveCas(
    request: ExperimentAuthorizationRequest,
    expectedRevision: number,
  ): Promise<ExperimentAuthorizationRequest> {
    const parsed = ExperimentAuthorizationRequestSchema.parse({
      ...request,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE experiment_authorization_requests
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz
       WHERE authorization_id = $1 AND record_revision = $6`,
      [
        parsed.authorizationId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `Authorization request CAS conflict for ${parsed.authorizationId}`,
      );
    }
    return parsed;
  }
}

export class PostgresExperimentAuthorizationRecordRepository
  implements ExperimentAuthorizationRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ExperimentAuthorizationRecord,
  ): Promise<ExperimentAuthorizationRecord> {
    const parsed = ExperimentAuthorizationRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO experiment_authorization_records (
         authorization_record_id, authorization_id, experiment_id,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (authorization_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.authorizationRecordId,
        parsed.authorizationId,
        parsed.experimentId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getLatest(
    experimentId: string,
  ): Promise<ExperimentAuthorizationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_authorization_records
       WHERE experiment_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [experimentId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentAuthorizationRecordSchema.parse(i),
          row.payload,
          "experiment_authorization_records",
        )
      : null;
  }
}

export class PostgresExperimentResultRepository
  implements ExperimentResultRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(result: ExperimentResult): Promise<ExperimentResult> {
    const parsed = ExperimentResultSchema.parse(result);
    await this.db.query(
      `INSERT INTO experiment_results (
         experiment_result_id, experiment_id, experiment_plan_hash,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (experiment_result_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.experimentResultId,
        parsed.experimentId,
        parsed.experimentPlanHash,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(
    experimentResultId: string,
  ): Promise<ExperimentResult | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_results WHERE experiment_result_id = $1`,
      [experimentResultId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentResultSchema.parse(i),
          row.payload,
          "experiment_results",
        )
      : null;
  }

  async listByExperiment(
    experimentId: string,
  ): Promise<readonly ExperimentResult[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_results WHERE experiment_id = $1`,
      [experimentId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ExperimentResultSchema.parse(i),
        row.payload,
        "experiment_results",
      ),
    );
  }
}

export class PostgresExperimentEvidenceBundleRepository
  implements ExperimentEvidenceBundleRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    bundle: ExperimentEvidenceBundle,
  ): Promise<ExperimentEvidenceBundle> {
    const parsed = ExperimentEvidenceBundleSchema.parse(bundle);
    await this.db.query(
      `INSERT INTO experiment_evidence_bundles (
         evidence_bundle_id, experiment_id, evidence_bundle_hash,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (evidence_bundle_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           evidence_bundle_hash = EXCLUDED.evidence_bundle_hash`,
      [
        parsed.evidenceBundleId,
        parsed.experimentId,
        parsed.evidenceBundleHash,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(
    evidenceBundleId: string,
  ): Promise<ExperimentEvidenceBundle | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_evidence_bundles
       WHERE evidence_bundle_id = $1`,
      [evidenceBundleId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentEvidenceBundleSchema.parse(i),
          row.payload,
          "experiment_evidence_bundles",
        )
      : null;
  }

  async getByExperiment(
    experimentId: string,
  ): Promise<ExperimentEvidenceBundle | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_evidence_bundles
       WHERE experiment_id = $1`,
      [experimentId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentEvidenceBundleSchema.parse(i),
          row.payload,
          "experiment_evidence_bundles",
        )
      : null;
  }
}

export class PostgresAssumptionEvidenceUpdateCandidateRepository
  implements AssumptionEvidenceUpdateCandidateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    candidate: AssumptionEvidenceUpdateCandidate,
  ): Promise<AssumptionEvidenceUpdateCandidate> {
    const parsed = AssumptionEvidenceUpdateCandidateSchema.parse(candidate);
    await this.db.query(
      `INSERT INTO assumption_evidence_update_candidates (
         candidate_id, experiment_id, assumption_id, payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (candidate_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.candidateId,
        parsed.experimentId,
        parsed.assumptionId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByExperiment(
    experimentId: string,
  ): Promise<readonly AssumptionEvidenceUpdateCandidate[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM assumption_evidence_update_candidates
       WHERE experiment_id = $1`,
      [experimentId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => AssumptionEvidenceUpdateCandidateSchema.parse(i),
        row.payload,
        "assumption_evidence_update_candidates",
      ),
    );
  }
}

export class PostgresExperimentCompletionRecordRepository
  implements ExperimentCompletionRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ExperimentCompletionRecord,
  ): Promise<ExperimentCompletionRecord> {
    const parsed = ExperimentCompletionRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO experiment_completion_records (
         completion_record_id, experiment_id, evidence_bundle_id,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (completion_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.completionRecordId,
        parsed.experimentId,
        parsed.evidenceBundleId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getByExperiment(
    experimentId: string,
  ): Promise<ExperimentCompletionRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_completion_records
       WHERE experiment_id = $1`,
      [experimentId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentCompletionRecordSchema.parse(i),
          row.payload,
          "experiment_completion_records",
        )
      : null;
  }
}

export class PostgresExperimentExecutionLineageRepository
  implements ExperimentExecutionLineageRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ExperimentExecutionLineage,
  ): Promise<ExperimentExecutionLineage> {
    const parsed = ExperimentExecutionLineageSchema.parse(record);
    await this.db.query(
      `INSERT INTO experiment_execution_lineage (
         lineage_id, experiment_id, experiment_plan_hash, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (lineage_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.lineageId,
        parsed.experimentId,
        parsed.experimentPlanHash,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(
    lineageId: string,
  ): Promise<ExperimentExecutionLineage | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_execution_lineage WHERE lineage_id = $1`,
      [lineageId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentExecutionLineageSchema.parse(i),
          row.payload,
          "experiment_execution_lineage",
        )
      : null;
  }

  async getByCompiledRunId(
    compiledRunId: string,
  ): Promise<ExperimentExecutionLineage | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_execution_lineage
       WHERE payload->>'compiledRunId' = $1
       LIMIT 1`,
      [compiledRunId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ExperimentExecutionLineageSchema.parse(i),
          row.payload,
          "experiment_execution_lineage",
        )
      : null;
  }

  async listByExperiment(
    experimentId: string,
  ): Promise<readonly ExperimentExecutionLineage[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM experiment_execution_lineage
       WHERE experiment_id = $1`,
      [experimentId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ExperimentExecutionLineageSchema.parse(i),
        row.payload,
        "experiment_execution_lineage",
      ),
    );
  }
}

export class PostgresExperimentUsageLedgerRepository
  implements ExperimentUsageLedgerRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async get(experimentId: string): Promise<ExperimentUsageLedger | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM experiment_usage_ledgers
       WHERE experiment_id = $1`,
      [experimentId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return hydrateExperimentUsageLedger({
      payload: row.payload,
      recordRevision: Number(row.record_revision),
    });
  }

  async create(ledger: ExperimentUsageLedger): Promise<ExperimentUsageLedger> {
    await this.db.query(
      `INSERT INTO experiment_usage_ledgers (
         experiment_id, payload, record_revision, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4::timestamptz)`,
      [
        ledger.experimentId,
        JSON.stringify(ledger),
        ledger.recordRevision,
        ledger.updatedAt,
      ],
    );
    return ledger;
  }

  async saveCas(
    ledger: ExperimentUsageLedger,
    expectedRevision: number,
  ): Promise<ExperimentUsageLedger> {
    const next = { ...ledger, recordRevision: expectedRevision + 1 };
    const result = await this.db.query(
      `UPDATE experiment_usage_ledgers
       SET payload = $2::jsonb, record_revision = $3, updated_at = $4::timestamptz
       WHERE experiment_id = $1 AND record_revision = $5`,
      [
        next.experimentId,
        JSON.stringify(next),
        next.recordRevision,
        next.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `Usage ledger CAS conflict for ${next.experimentId}`,
      );
    }
    return next;
  }
}
