import { SchedulingError } from "../../../scheduling/errors.js";
import {
  parseCrossRunDependency,
  type CrossRunDependency,
} from "../../../scheduling/dependency.js";
import {
  nextFairnessRowsAfterService,
  parseProjectFairnessState,
  type ProjectFairnessState,
} from "../../../scheduling/fairness.js";
import {
  parseSchedulerDecisionRecord,
  parseSchedulerPauseRecord,
  parseSchedulerProjectConfig,
  type SchedulerDecisionRecord,
  type SchedulerPauseRecord,
  type SchedulerProjectConfig,
} from "../../../scheduling/records.js";
import type {
  FairnessAllocationApi,
  SchedulerDecisionRepository,
  SchedulerDependencyRepository,
  SchedulerFairnessRepository,
  SchedulerPauseRepository,
  SchedulerProjectConfigRepository,
  SchedulerWorkItemRepository,
} from "../../../scheduling/repositories.js";
import {
  parseSchedulerWorkItem,
  type SchedulerWorkItem,
  type WorkItemStatus,
} from "../../../scheduling/work-item.js";
import type { PostgresDatabase } from "../database.js";

function workFromRow(row: {
  payload: unknown;
  record_revision: string | number;
}): SchedulerWorkItem {
  const parsed = parseSchedulerWorkItem(row.payload);
  return parseSchedulerWorkItem({
    ...parsed,
    recordRevision: Number(row.record_revision),
  });
}

export class PostgresSchedulerWorkItemRepository
  implements SchedulerWorkItemRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(workItemId: string): Promise<SchedulerWorkItem | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_work_items WHERE work_item_id = $1`,
      [workItemId],
    );
    const row = result.rows[0];
    return row ? workFromRow(row) : null;
  }

  async getByLogicalIdentity(
    logicalIdentityKey: string,
  ): Promise<SchedulerWorkItem | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_work_items
       WHERE logical_identity_key = $1`,
      [logicalIdentityKey],
    );
    const row = result.rows[0];
    return row ? workFromRow(row) : null;
  }

  async listByRun(runId: string): Promise<readonly SchedulerWorkItem[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_work_items
       WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return result.rows.map(workFromRow);
  }

  async listByProject(projectId: string): Promise<readonly SchedulerWorkItem[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_work_items
       WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map(workFromRow);
  }

  async listByStatus(
    statuses: readonly WorkItemStatus[],
    limit: number,
  ): Promise<readonly SchedulerWorkItem[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_work_items
       WHERE status = ANY($1::text[])
       ORDER BY eligible_at ASC, created_at ASC
       LIMIT $2`,
      [statuses, limit],
    );
    return result.rows.map(workFromRow);
  }

  async listSchedulableProjectSummaries(
    nowIso: string,
  ): Promise<
    readonly { projectId: string; oldestEligibleAt: string }[]
  > {
    const result = await this.db.query<{
      project_id: string;
      oldest_eligible_at: Date;
    }>(
      `SELECT project_id, MIN(eligible_at) AS oldest_eligible_at
       FROM scheduler_work_items
       WHERE status = 'ELIGIBLE'
         AND eligible_at <= $1::timestamptz
       GROUP BY project_id
       ORDER BY project_id ASC`,
      [nowIso],
    );
    return result.rows.map((row) => ({
      projectId: row.project_id,
      oldestEligibleAt: row.oldest_eligible_at.toISOString(),
    }));
  }

  async listCandidateWorkByProject(
    projectId: string,
    statuses: readonly WorkItemStatus[],
    limit: number,
  ): Promise<readonly SchedulerWorkItem[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_work_items
       WHERE project_id = $1
         AND status = ANY($2::text[])
       ORDER BY eligible_at ASC, created_at ASC
       LIMIT $3`,
      [projectId, statuses, limit],
    );
    return result.rows.map(workFromRow);
  }

  async save(item: SchedulerWorkItem): Promise<SchedulerWorkItem> {
    const parsed = parseSchedulerWorkItem(item);
    await this.db.query(
      `INSERT INTO scheduler_work_items (
         work_item_id, project_id, run_id, work_kind, status, priority_class,
         logical_identity_key, binding_hash, created_at, eligible_at, deadline_at,
         attempt_count, max_attempts, record_revision, dependency_set_hash,
         scheduling_metadata_hash, claim_owner_id, fence_token, lease_expires_at,
         failure_class, failure_reason_code, last_error_safe_message, result_ref,
         last_decision_id, payload
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9::timestamptz,$10::timestamptz,$11::timestamptz,
         $12,$13,$14,$15,$16,$17,$18,$19::timestamptz,$20,$21,$22,$23,$24,$25::jsonb
       )
       ON CONFLICT (logical_identity_key) DO NOTHING`,
      [
        parsed.workItemId,
        parsed.projectId,
        parsed.runId,
        parsed.workKind,
        parsed.status,
        parsed.priorityClass,
        parsed.logicalIdentityKey,
        parsed.bindingHash,
        parsed.createdAt,
        parsed.eligibleAt,
        parsed.deadlineAt ?? null,
        parsed.attemptCount,
        parsed.maxAttempts,
        parsed.recordRevision,
        parsed.dependencySetHash,
        parsed.schedulingMetadataHash,
        parsed.claimOwnerId ?? null,
        parsed.fenceToken ?? null,
        parsed.leaseExpiresAt ?? null,
        parsed.failureClass ?? null,
        parsed.failureReasonCode ?? null,
        parsed.lastErrorSafeMessage ?? null,
        parsed.resultRef ?? null,
        parsed.lastDecisionId ?? null,
        JSON.stringify(parsed),
      ],
    );
    const existing = await this.getByLogicalIdentity(parsed.logicalIdentityKey);
    return existing ?? parsed;
  }

  async updateCas(
    item: SchedulerWorkItem,
    expectedRevision: number,
  ): Promise<SchedulerWorkItem> {
    const next = parseSchedulerWorkItem({
      ...item,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `UPDATE scheduler_work_items SET
         project_id = $2,
         run_id = $3,
         work_kind = $4,
         status = $5,
         priority_class = $6,
         binding_hash = $7,
         eligible_at = $8::timestamptz,
         deadline_at = $9::timestamptz,
         attempt_count = $10,
         max_attempts = $11,
         record_revision = $12,
         dependency_set_hash = $13,
         scheduling_metadata_hash = $14,
         claim_owner_id = $15,
         fence_token = $16,
         lease_expires_at = $17::timestamptz,
         failure_class = $18,
         failure_reason_code = $19,
         last_error_safe_message = $20,
         result_ref = $21,
         last_decision_id = $22,
         payload = $23::jsonb
       WHERE work_item_id = $1 AND record_revision = $24
       RETURNING payload, record_revision`,
      [
        next.workItemId,
        next.projectId,
        next.runId,
        next.workKind,
        next.status,
        next.priorityClass,
        next.bindingHash,
        next.eligibleAt,
        next.deadlineAt ?? null,
        next.attemptCount,
        next.maxAttempts,
        next.recordRevision,
        next.dependencySetHash,
        next.schedulingMetadataHash,
        next.claimOwnerId ?? null,
        next.fenceToken ?? null,
        next.leaseExpiresAt ?? null,
        next.failureClass ?? null,
        next.failureReasonCode ?? null,
        next.lastErrorSafeMessage ?? null,
        next.resultRef ?? null,
        next.lastDecisionId ?? null,
        JSON.stringify(next),
        expectedRevision,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new SchedulingError(
        "SCHEDULER_CAS_CONFLICT",
        "Work item revision conflict",
        { workItemId: next.workItemId, expectedRevision },
      );
    }
    return workFromRow(row);
  }

  async countActiveByProject(projectId: string): Promise<number> {
    // Live operational capacity only: CLAIMED/RUNNING with a HELD unexpired
    // Phase 11 lease. Expired CLAIMED must not permanently consume capacity.
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM scheduler_work_items w
       INNER JOIN coordinator_leases l
         ON l.coordination_key = 'scheduler:work:' || w.work_item_id
       WHERE w.project_id = $1
         AND w.status = ANY($2::text[])
         AND l.status = 'HELD'
         AND l.lease_expires_at >= NOW()`,
      [projectId, ["CLAIMED", "RUNNING"]],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async countActiveGlobal(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM scheduler_work_items w
       INNER JOIN coordinator_leases l
         ON l.coordination_key = 'scheduler:work:' || w.work_item_id
       WHERE w.status = ANY($1::text[])
         AND l.status = 'HELD'
         AND l.lease_expires_at >= NOW()`,
      [["CLAIMED", "RUNNING"]],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * CLAIMED rows whose Phase 11 lease is missing or expired (DB NOW()).
   * Does not include RUNNING — that path uses Phase 11/12 recovery.
   */
  async listExpiredClaimed(limit: number): Promise<readonly SchedulerWorkItem[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT w.payload, w.record_revision
       FROM scheduler_work_items w
       WHERE w.status = 'CLAIMED'
         AND NOT EXISTS (
           SELECT 1 FROM coordinator_leases l
           WHERE l.coordination_key = 'scheduler:work:' || w.work_item_id
             AND l.status = 'HELD'
             AND l.lease_expires_at >= NOW()
         )
       ORDER BY w.created_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map(workFromRow);
  }
}

export class PostgresSchedulerDependencyRepository
  implements SchedulerDependencyRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getById(dependencyId: string): Promise<CrossRunDependency | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scheduler_dependencies WHERE dependency_id = $1`,
      [dependencyId],
    );
    const row = result.rows[0];
    return row ? parseCrossRunDependency(row.payload) : null;
  }

  async listByDependentRun(
    dependentRunId: string,
  ): Promise<readonly CrossRunDependency[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scheduler_dependencies WHERE dependent_run_id = $1`,
      [dependentRunId],
    );
    return result.rows.map((row) => parseCrossRunDependency(row.payload));
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly CrossRunDependency[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scheduler_dependencies WHERE project_id = $1`,
      [projectId],
    );
    return result.rows.map((row) => parseCrossRunDependency(row.payload));
  }

  async listAll(): Promise<readonly CrossRunDependency[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scheduler_dependencies`,
    );
    return result.rows.map((row) => parseCrossRunDependency(row.payload));
  }

  async save(dependency: CrossRunDependency): Promise<CrossRunDependency> {
    const parsed = parseCrossRunDependency(dependency);
    await this.db.query(
      `INSERT INTO scheduler_dependencies (
         dependency_id, project_id, dependent_run_id, prerequisite_run_id,
         required_milestone, created_at, dependency_hash, payload
       ) VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$7,$8::jsonb)
       ON CONFLICT (dependency_id) DO UPDATE SET payload = EXCLUDED.payload`,
      [
        parsed.dependencyId,
        parsed.projectId,
        parsed.dependentRunId,
        parsed.prerequisiteRunId,
        parsed.requiredMilestone,
        parsed.createdAt,
        parsed.dependencyHash,
        JSON.stringify(parsed),
      ],
    );
    return parsed;
  }
}

export class PostgresSchedulerDecisionRepository
  implements SchedulerDecisionRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async append(decision: SchedulerDecisionRecord): Promise<void> {
    const parsed = parseSchedulerDecisionRecord(decision);
    await this.db.query(
      `INSERT INTO scheduler_decisions (
         decision_id, timestamp, selected_work_id, reason_code, payload
       ) VALUES ($1, $2::timestamptz, $3, $4, $5::jsonb)`,
      [
        parsed.decisionId,
        parsed.timestamp,
        parsed.selectedWorkId,
        parsed.reasonCode,
        JSON.stringify(parsed),
      ],
    );
  }

  async listByWorkItem(
    workItemId: string,
    limit = 50,
  ): Promise<readonly SchedulerDecisionRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scheduler_decisions
       WHERE selected_work_id = $1
          OR payload->'candidateWorkIds' ? $1
       ORDER BY timestamp DESC
       LIMIT $2`,
      [workItemId, limit],
    );
    return result.rows.map((row) => parseSchedulerDecisionRecord(row.payload));
  }
}

export class PostgresSchedulerProjectConfigRepository
  implements SchedulerProjectConfigRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getByProjectId(
    projectId: string,
  ): Promise<SchedulerProjectConfig | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_project_config
       WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseSchedulerProjectConfig({
      ...((row.payload as object) ?? {}),
      projectId,
      recordRevision: Number(row.record_revision),
    });
  }

  async save(config: SchedulerProjectConfig): Promise<SchedulerProjectConfig> {
    const parsed = parseSchedulerProjectConfig(config);
    await this.db.query(
      `INSERT INTO scheduler_project_config (
         project_id, weight, max_concurrency, default_priority_class,
         record_revision, payload
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (project_id) DO UPDATE SET
         weight = EXCLUDED.weight,
         max_concurrency = EXCLUDED.max_concurrency,
         default_priority_class = EXCLUDED.default_priority_class,
         record_revision = EXCLUDED.record_revision,
         payload = EXCLUDED.payload`,
      [
        parsed.projectId,
        parsed.weight,
        parsed.maxConcurrency,
        parsed.defaultPriorityClass,
        parsed.recordRevision,
        JSON.stringify(parsed),
      ],
    );
    return parsed;
  }

  async list(): Promise<readonly SchedulerProjectConfig[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
      project_id: string;
    }>(`SELECT project_id, payload, record_revision FROM scheduler_project_config`);
    return result.rows.map((row) =>
      parseSchedulerProjectConfig({
        ...((row.payload as object) ?? {}),
        projectId: row.project_id,
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresSchedulerPauseRepository
  implements SchedulerPauseRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async getGlobal(): Promise<SchedulerPauseRecord | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_pauses WHERE scope = 'GLOBAL'`,
    );
    const row = result.rows[0];
    return row
      ? parseSchedulerPauseRecord({
          ...((row.payload as object) ?? {}),
          recordRevision: Number(row.record_revision),
        })
      : null;
  }

  async getProject(projectId: string): Promise<SchedulerPauseRecord | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM scheduler_pauses
       WHERE scope = 'PROJECT' AND project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row
      ? parseSchedulerPauseRecord({
          ...((row.payload as object) ?? {}),
          recordRevision: Number(row.record_revision),
        })
      : null;
  }

  async save(pause: SchedulerPauseRecord): Promise<SchedulerPauseRecord> {
    const parsed = parseSchedulerPauseRecord(pause);
    await this.db.query(
      `INSERT INTO scheduler_pauses (
         pause_id, scope, project_id, paused, updated_at,
         updated_by_principal_id, record_revision, payload
       ) VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$8::jsonb)
       ON CONFLICT (pause_id) DO UPDATE SET
         paused = EXCLUDED.paused,
         updated_at = EXCLUDED.updated_at,
         updated_by_principal_id = EXCLUDED.updated_by_principal_id,
         record_revision = EXCLUDED.record_revision,
         payload = EXCLUDED.payload`,
      [
        parsed.pauseId,
        parsed.scope,
        parsed.projectId ?? null,
        parsed.paused,
        parsed.updatedAt,
        parsed.updatedByPrincipalId,
        parsed.recordRevision,
        JSON.stringify(parsed),
      ],
    );
    return parsed;
  }
}

export class PostgresSchedulerFairnessRepository
  implements SchedulerFairnessRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async listAll(): Promise<readonly ProjectFairnessState[]> {
    const result = await this.db.query<{
      project_id: string;
      deficit: number;
      last_served_at: Date | null;
      service_sequence: string | number;
      record_revision: string | number;
    }>(
      `SELECT project_id, deficit, last_served_at, service_sequence,
              record_revision
       FROM scheduler_fairness_state
       ORDER BY project_id ASC`,
    );
    return result.rows.map(mapFairnessRow);
  }

  async getByProjectId(
    projectId: string,
  ): Promise<ProjectFairnessState | null> {
    const result = await this.db.query<{
      project_id: string;
      deficit: number;
      last_served_at: Date | null;
      service_sequence: string | number;
      record_revision: string | number;
    }>(
      `SELECT project_id, deficit, last_served_at, service_sequence,
              record_revision
       FROM scheduler_fairness_state WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? mapFairnessRow(row) : null;
  }

  async applyServiceCharge(input: {
    selectedProjectId: string;
    weights: ReadonlyMap<string, number>;
    servedAt: string;
    decisionId: string;
  }): Promise<{
    before: readonly ProjectFairnessState[];
    after: readonly ProjectFairnessState[];
  }> {
    return this.runSerializedAllocation((api) => api.applyCharge(input));
  }

  async runSerializedAllocation<T>(
    fn: (api: FairnessAllocationApi) => Promise<T>,
  ): Promise<T> {
    return this.db.withTransaction(async () => {
      await this.db.query(
        `SELECT lock_id FROM scheduler_fairness_lock
         WHERE lock_id = 'global' FOR UPDATE`,
      );
      const api: FairnessAllocationApi = {
        loadState: () => this.listAll(),
        applyCharge: async (chargeInput) => {
          const before = await this.listAll();
          const after = nextFairnessRowsAfterService({
            existing: before,
            selectedProjectId: chargeInput.selectedProjectId,
            weights: chargeInput.weights,
            servedAt: chargeInput.servedAt,
          });
          await this.persistRowsCas(after, before, chargeInput.decisionId);
          await this.db.query(
            `UPDATE scheduler_fairness_lock SET updated_at = NOW()
             WHERE lock_id = 'global'`,
          );
          return { before, after };
        },
      };
      return fn(api);
    });
  }

  async writeRowsCas(input: {
    rows: readonly ProjectFairnessState[];
    expectedRevisions: ReadonlyMap<string, number>;
    decisionId: string;
  }): Promise<void> {
    await this.runSerializedAllocation(async () => {
      for (const row of input.rows) {
        const expected = input.expectedRevisions.get(row.projectId);
        if (expected === undefined) {
          throw new SchedulingError(
            "SCHEDULER_CAS_CONFLICT",
            "Missing expected fairness revision",
            { projectId: row.projectId },
          );
        }
        const result = await this.db.query(
          `UPDATE scheduler_fairness_state SET
             deficit = $2,
             last_served_at = $3::timestamptz,
             service_sequence = $4,
             record_revision = $5,
             payload = $6::jsonb
           WHERE project_id = $1 AND record_revision = $7
           RETURNING project_id`,
          [
            row.projectId,
            row.deficit,
            row.lastServedAt ?? null,
            row.serviceSequence,
            row.recordRevision,
            JSON.stringify({
              ...row,
              lastDecisionId: input.decisionId,
            }),
            expected,
          ],
        );
        if (!result.rows[0]) {
          throw new SchedulingError(
            "SCHEDULER_CAS_CONFLICT",
            "Stale fairness revision rejected",
            {
              projectId: row.projectId,
              expectedRevision: expected,
            },
          );
        }
      }
      await this.db.query(
        `UPDATE scheduler_fairness_lock SET updated_at = NOW()
         WHERE lock_id = 'global'`,
      );
    });
  }

  private async persistRowsCas(
    after: readonly ProjectFairnessState[],
    before: readonly ProjectFairnessState[],
    decisionId: string,
  ): Promise<void> {
    const beforeById = new Map(before.map((row) => [row.projectId, row]));
    for (const row of after) {
      const prior = beforeById.get(row.projectId);
      const expectedPrior = prior?.recordRevision ?? 0;
      if (expectedPrior === 0) {
        const inserted = await this.db.query(
          `INSERT INTO scheduler_fairness_state (
             project_id, deficit, last_served_at, service_sequence,
             record_revision, payload
           ) VALUES ($1,$2,$3::timestamptz,$4,$5,$6::jsonb)
           ON CONFLICT (project_id) DO NOTHING
           RETURNING project_id`,
          [
            row.projectId,
            row.deficit,
            row.lastServedAt ?? null,
            row.serviceSequence,
            row.recordRevision,
            JSON.stringify({
              ...row,
              lastDecisionId: decisionId,
            }),
          ],
        );
        if (!inserted.rows[0]) {
          throw new SchedulingError(
            "SCHEDULER_CAS_CONFLICT",
            "Fairness insert lost race",
            { projectId: row.projectId },
          );
        }
        continue;
      }
      const updated = await this.db.query(
        `UPDATE scheduler_fairness_state SET
           deficit = $2,
           last_served_at = $3::timestamptz,
           service_sequence = $4,
           record_revision = $5,
           payload = $6::jsonb
         WHERE project_id = $1 AND record_revision = $7
         RETURNING project_id`,
        [
          row.projectId,
          row.deficit,
          row.lastServedAt ?? null,
          row.serviceSequence,
          row.recordRevision,
          JSON.stringify({
            ...row,
            lastDecisionId: decisionId,
          }),
          expectedPrior,
        ],
      );
      if (!updated.rows[0]) {
        throw new SchedulingError(
          "SCHEDULER_CAS_CONFLICT",
          "Stale fairness revision rejected",
          {
            projectId: row.projectId,
            expectedRevision: expectedPrior,
          },
        );
      }
    }
  }
}

function mapFairnessRow(row: {
  project_id: string;
  deficit: number;
  last_served_at: Date | null;
  service_sequence: string | number;
  record_revision: string | number;
}): ProjectFairnessState {
  return parseProjectFairnessState({
    projectId: row.project_id,
    deficit: Number(row.deficit),
    ...(row.last_served_at
      ? { lastServedAt: row.last_served_at.toISOString() }
      : {}),
    serviceSequence: Number(row.service_sequence),
    recordRevision: Number(row.record_revision),
  });
}
