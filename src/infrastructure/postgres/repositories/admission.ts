import {
  RunRecordSchema,
  withRunState,
  type RunRecord,
  type RunRepository,
} from "../../../admission/run-repository.js";
import type { RunState } from "../../../domain/run/run-state.js";
import {
  parseEventEnvelope,
  type EventEnvelope,
} from "../../../domain/run/event-envelope.js";
import type { EventStore } from "../../../admission/event-store.js";
import type {
  IdempotencyRecord,
  IdempotencyReserveResult,
  IdempotencyStore,
} from "../../../admission/idempotency-store.js";
import {
  parseObjective,
  type Objective,
} from "../../../domain/objective/objective.js";
import { objectiveFingerprint } from "../../../domain/objective/fingerprint.js";
import type { ObjectiveFingerprintContent } from "../../../domain/objective/fingerprint.js";
import type { ObjectiveRepository } from "../../../admission/objective-repository.js";
import type {
  AcquireLockCommand,
  LockAcquireResult,
  ProjectLock,
  ProjectLockService,
} from "../../../admission/project-lock.js";
import { DurabilityError } from "../../../durability/errors.js";
import { assertProjectScope } from "../../../domain/project-scope.js";
import type { PostgresDatabase } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import { wrapDatabaseError } from "../database.js";

function objectiveFingerprintContent(objective: Objective): ObjectiveFingerprintContent {
  const content: ObjectiveFingerprintContent = {
    requestedOutcome: objective.requestedOutcome,
    acceptanceCriteria: objective.acceptanceCriteria,
    nonGoals: objective.nonGoals,
    constraints: objective.constraints,
    priority: objective.priority,
  };
  if (objective.deadline !== undefined) {
    content.deadline = objective.deadline;
  }
  return content;
}

function mapRunRow(row: {
  payload: unknown;
  record_revision: string | number;
}): RunRecord {
  const parsed = hydrateRecord(
    (input) => RunRecordSchema.parse(input),
    row.payload,
    "runs",
  );
  return RunRecordSchema.parse({
    ...parsed,
    recordRevision: Number(row.record_revision),
  });
}

export class PostgresRunRepository implements RunRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async create(record: RunRecord): Promise<RunRecord> {
    const parsed = RunRecordSchema.parse(record);
    try {
      await this.db.query(
        `INSERT INTO runs (
           run_id, project_id, objective_id, objective_version, requested_environment,
           idempotency_key, state, payload, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::timestamptz, $10::timestamptz)`,
        [
          parsed.runId,
          parsed.projectId,
          parsed.objectiveId,
          parsed.objectiveVersion,
          parsed.requestedEnvironment,
          parsed.idempotencyKey,
          parsed.state,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.updatedAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(runId: string): Promise<RunRecord | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM runs WHERE run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row ? mapRunRow(row) : null;
  }

  async getByIdInProject(
    runId: string,
    projectId: string,
  ): Promise<RunRecord | null> {
    const run = await this.getById(runId);
    if (!run) {
      return null;
    }
    assertProjectScope(run.projectId, projectId, "run", runId);
    return run;
  }

  async exists(runId: string): Promise<boolean> {
    const result = await this.db.query(`SELECT 1 FROM runs WHERE run_id = $1`, [
      runId,
    ]);
    return result.rows.length > 0;
  }

  async save(record: RunRecord): Promise<RunRecord> {
    const parsed = RunRecordSchema.parse(record);
    const result = await this.db.query(
      `UPDATE runs
       SET state = $2,
           payload = $3::jsonb,
           record_revision = record_revision + 1,
           updated_at = $4::timestamptz
       WHERE run_id = $1 AND project_id = $5`,
      [
        parsed.runId,
        parsed.state,
        JSON.stringify(parsed),
        parsed.updatedAt,
        parsed.projectId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "DURABLE_CONFLICT",
        `Run ${parsed.runId} not found for project ${parsed.projectId}`,
      );
    }
    return parsed;
  }

  async listByProject(projectId: string): Promise<readonly RunRecord[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
      run_id: string;
    }>(
      `SELECT run_id, payload, record_revision FROM runs WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((row) => mapRunRow(row));
  }

  async transition(
    runId: string,
    expected: RunState,
    expectedRecordRevision: number,
    next: RunState,
    updatedAt: string,
    extras: { admittedAt?: string; failureReasonCode?: string } = {},
  ): Promise<RunRecord> {
    const current = await this.getById(runId);
    if (!current) {
      throw new DurabilityError("DURABLE_CONFLICT", `Unknown run ${runId}`);
    }
    const updated = RunRecordSchema.parse({
      ...withRunState(current, next, updatedAt, extras),
      recordRevision: current.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE runs
       SET state = $2,
           payload = $3::jsonb,
           record_revision = record_revision + 1,
           updated_at = $4::timestamptz
       WHERE run_id = $1
         AND project_id = $5
         AND state = $6
         AND record_revision = $7`,
      [
        runId,
        next,
        JSON.stringify(updated),
        updatedAt,
        current.projectId,
        expected,
        expectedRecordRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "DURABLE_CONFLICT",
        `Run CAS failed for ${runId}: expected ${expected}@${expectedRecordRevision}`,
        { runId, expected, expectedRecordRevision, next },
      );
    }
    return updated;
  }

  async listByStates(
    states: readonly RunState[],
    limit: number,
  ): Promise<readonly RunRecord[]> {
    if (states.length === 0 || limit <= 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM runs
       WHERE state = ANY($1::text[])
       ORDER BY updated_at ASC, run_id ASC
       LIMIT $2`,
      [[...states], limit],
    );
    return result.rows.map((row) => mapRunRow(row));
  }

  async listIdsByStates(
    states: readonly RunState[],
    limit: number,
  ): Promise<readonly string[]> {
    if (states.length === 0 || limit <= 0) {
      return [];
    }
    const result = await this.db.query<{ run_id: string }>(
      `SELECT run_id FROM runs
       WHERE state = ANY($1::text[])
       ORDER BY updated_at ASC, run_id ASC
       LIMIT $2`,
      [[...states], limit],
    );
    return result.rows.map((row) => row.run_id);
  }

  /**
   * Bounded discovery candidates: discoverable Runs whose current-phase
   * scheduler work is not yet durably represented. Oldest-actionable-first so
   * continuous admission cannot starve older missing-work Runs.
   *
   * Already-materialized work (any status) is excluded — retries belong to the
   * work-item lifecycle, not rediscovery rematerialization.
   *
   * Optional `projectIds` scopes the page (tests / focused workers). Production
   * discovery typically omits it.
   */
  async listActionableDiscoverableRunIds(
    states: readonly RunState[],
    limit: number,
    projectIds?: readonly string[],
  ): Promise<readonly string[]> {
    if (states.length === 0 || limit <= 0) {
      return [];
    }
    const projectFilter =
      projectIds && projectIds.length > 0
        ? `AND r.project_id = ANY($3::text[])`
        : "";
    const params: unknown[] = [[...states], limit];
    if (projectIds && projectIds.length > 0) {
      params.push([...projectIds]);
    }
    const result = await this.db.query<{ run_id: string }>(
      `SELECT r.run_id
       FROM runs r
       WHERE r.state = ANY($1::text[])
         ${projectFilter}
         AND (r.payload->>'updatedAt') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
         AND (
           (
             r.state = 'ADMITTED'
             AND NOT EXISTS (
               SELECT 1 FROM scheduler_work_items w
               WHERE w.run_id = r.run_id AND w.work_kind = 'INGEST_REPOSITORY'
             )
           )
           OR (
             r.state = 'INGESTING'
             AND EXISTS (
               SELECT 1 FROM json_documents d
               WHERE d.collection = 'verified_contexts'
                 AND d.run_id = r.run_id
                 AND d.payload->>'status' = 'VERIFIED'
             )
             AND NOT EXISTS (
               SELECT 1 FROM scheduler_work_items w
               WHERE w.run_id = r.run_id AND w.work_kind = 'PLAN_RUN'
             )
           )
           OR (
             r.state = 'VALIDATING'
             AND (
               (
                 EXISTS (
                   SELECT 1 FROM json_documents p
                   WHERE p.collection = 'plans'
                     AND p.run_id = r.run_id
                     AND COALESCE(p.payload->>'status', '') <> 'SUPERSEDED'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM json_documents v
                   WHERE v.collection = 'validation_decisions'
                     AND v.run_id = r.run_id
                     AND v.payload->>'decision' IN (
                       'PASS', 'HUMAN_APPROVAL_REQUIRED'
                     )
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_work_items w
                   WHERE w.run_id = r.run_id AND w.work_kind = 'VALIDATE_PLAN'
                 )
               )
               OR (
                 EXISTS (
                   SELECT 1 FROM json_documents v
                   WHERE v.collection = 'validation_decisions'
                     AND v.run_id = r.run_id
                     AND v.payload->>'decision' IN (
                       'PASS', 'HUMAN_APPROVAL_REQUIRED'
                     )
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_work_items w
                   WHERE w.run_id = r.run_id
                     AND w.work_kind = 'ROUTE_AUTHORIZATION'
                 )
               )
             )
           )
           OR (
             r.state = 'REVISING'
             AND (
               (
                 NOT EXISTS (
                   SELECT 1 FROM json_documents p
                   WHERE p.collection = 'plans'
                     AND p.run_id = r.run_id
                     AND COALESCE(p.payload->>'status', '') <> 'SUPERSEDED'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_work_items w
                   WHERE w.run_id = r.run_id AND w.work_kind = 'PLAN_RUN'
                 )
               )
               OR (
                 EXISTS (
                   SELECT 1 FROM json_documents p
                   WHERE p.collection = 'plans'
                     AND p.run_id = r.run_id
                     AND COALESCE(p.payload->>'status', '') <> 'SUPERSEDED'
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_work_items w
                   WHERE w.run_id = r.run_id AND w.work_kind = 'VALIDATE_PLAN'
                 )
               )
             )
           )
           OR (
             r.state = 'APPROVED'
             AND NOT EXISTS (
               SELECT 1 FROM scheduler_work_items w
               WHERE w.run_id = r.run_id AND w.work_kind = 'EXECUTE_PLAN'
             )
           )
           OR (
             r.state = 'EXECUTING'
             AND EXISTS (
               SELECT 1 FROM json_documents e
               WHERE e.collection = 'execution_attempts'
                 AND e.run_id = r.run_id
                 AND e.payload->>'status' IN (
                   'SUCCEEDED', 'FAILED', 'PARTIAL', 'CONTAINED'
                 )
             )
             AND NOT EXISTS (
               SELECT 1 FROM scheduler_work_items w
               WHERE w.run_id = r.run_id AND w.work_kind = 'VERIFY_OUTCOME'
             )
           )
           OR (
             r.state = 'COMPLETED'
             AND (
               (
                 NOT EXISTS (
                   SELECT 1 FROM json_documents l
                   WHERE l.collection = 'learning_ledger'
                     AND l.run_id = r.run_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_work_items w
                   WHERE w.run_id = r.run_id AND w.work_kind = 'LEARN_FROM_RUN'
                 )
               )
               OR (
                 NOT EXISTS (
                   SELECT 1 FROM json_documents h
                   WHERE h.collection = 'health_snapshots'
                     AND h.project_id = r.project_id
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM scheduler_work_items w
                   WHERE w.run_id = r.run_id
                     AND w.work_kind = 'BUILD_OBSERVABILITY'
                 )
               )
             )
           )
         )
       ORDER BY r.updated_at ASC, r.run_id ASC
       LIMIT $2`,
      params,
    );
    return result.rows.map((row) => row.run_id);
  }

  async transitionInProject(
    runId: string,
    projectId: string,
    expected: RunState,
    expectedRecordRevision: number,
    next: RunState,
    updatedAt: string,
    extras: { admittedAt?: string; failureReasonCode?: string } = {},
  ): Promise<RunRecord> {
    await this.getByIdInProject(runId, projectId);
    return this.transition(
      runId,
      expected,
      expectedRecordRevision,
      next,
      updatedAt,
      extras,
    );
  }
}

export class PostgresEventStore implements EventStore {
  constructor(private readonly db: PostgresDatabase) {}

  async append(event: EventEnvelope): Promise<EventEnvelope> {
    const parsed = parseEventEnvelope(event);
    try {
      await this.db.query(
        `INSERT INTO events (event_id, run_id, project_id, event_type, payload, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::timestamptz)`,
        [
          parsed.eventId,
          parsed.runId,
          parsed.projectId,
          parsed.eventType,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async listByRunId(runId: string): Promise<readonly EventEnvelope[]> {
    const result = await this.db.query<{ payload: unknown; event_id: string }>(
      `SELECT event_id, payload FROM events WHERE run_id = $1 ORDER BY created_at ASC`,
      [runId],
    );
    return result.rows.map((row) =>
      hydrateRecord(parseEventEnvelope, row.payload, `events:${row.event_id}`),
    );
  }
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: PostgresDatabase) {}

  async getByKey(key: string): Promise<IdempotencyRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row ? (row.payload as IdempotencyRecord) : null;
  }

  async reserve(
    key: string,
    fingerprint: string,
    reservedAt: string,
  ): Promise<IdempotencyReserveResult> {
    const record: IdempotencyRecord = {
      key,
      fingerprint,
      status: "RESERVED",
      runId: null,
      reservedAt,
      updatedAt: reservedAt,
    };
    const inserted = await this.db.query<{ key: string }>(
      `INSERT INTO idempotency_keys (key, fingerprint, status, run_id, payload, reserved_at, updated_at)
       VALUES ($1, $2, 'RESERVED', NULL, $3::jsonb, $4::timestamptz, $4::timestamptz)
       ON CONFLICT (key) DO NOTHING
       RETURNING key`,
      [key, fingerprint, JSON.stringify(record), reservedAt],
    );
    if (inserted.rows.length > 0) {
      return { status: "NEW" };
    }
    const existing = await this.getByKey(key);
    if (!existing) {
      throw new DurabilityError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency key ${key} conflicted but could not be loaded`,
      );
    }
    if (existing.fingerprint !== fingerprint) {
      return {
        status: "OBJECTIVE_VERSION_CONFLICT",
        runId: existing.runId,
        fingerprint: existing.fingerprint,
      };
    }
    if (existing.status === "COMPLETED") {
      return {
        status: "COMPLETED_DUPLICATE",
        runId: existing.runId,
        fingerprint: existing.fingerprint,
      };
    }
    return {
      status: "ACTIVE_DUPLICATE",
      runId: existing.runId,
      fingerprint: existing.fingerprint,
    };
  }

  async complete(key: string, runId: string, updatedAt: string): Promise<void> {
    const existing = await this.getByKey(key);
    if (!existing || existing.status !== "RESERVED") {
      throw new DurabilityError(
        "IDEMPOTENCY_CONFLICT",
        `Cannot complete idempotency key ${key}`,
      );
    }
    const next: IdempotencyRecord = {
      ...existing,
      status: "ACTIVE",
      runId,
      updatedAt,
    };
    const result = await this.db.query(
      `UPDATE idempotency_keys
       SET status = 'ACTIVE', run_id = $2, payload = $3::jsonb, updated_at = $4::timestamptz
       WHERE key = $1 AND status = 'RESERVED'`,
      [key, runId, JSON.stringify(next), updatedAt],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "IDEMPOTENCY_CONFLICT",
        `Idempotency complete lost for ${key}`,
      );
    }
  }

  async markCompleted(key: string, updatedAt: string): Promise<void> {
    const existing = await this.getByKey(key);
    if (!existing || existing.status !== "ACTIVE" || existing.runId === null) {
      throw new DurabilityError(
        "IDEMPOTENCY_CONFLICT",
        `Cannot mark idempotency key completed: ${key}`,
      );
    }
    const next: IdempotencyRecord = {
      ...existing,
      status: "COMPLETED",
      updatedAt,
    };
    await this.db.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', payload = $2::jsonb, updated_at = $3::timestamptz
       WHERE key = $1 AND status = 'ACTIVE'`,
      [key, JSON.stringify(next), updatedAt],
    );
  }

  async release(key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM idempotency_keys WHERE key = $1 AND status = 'RESERVED' AND run_id IS NULL`,
      [key],
    );
  }
}

export class PostgresObjectiveRepository implements ObjectiveRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(objective: Objective): Promise<Objective> {
    const parsed = parseObjective(objective);
    await this.db.query(
      `INSERT INTO objectives (project_id, objective_id, objective_version, fingerprint, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (project_id, objective_id, objective_version) DO NOTHING`,
      [
        parsed.projectId,
        parsed.objectiveId,
        parsed.objectiveVersion,
        objectiveFingerprint(objectiveFingerprintContent(parsed)),
        JSON.stringify(parsed),
      ],
    );
    return parsed;
  }

  async getById(
    objectiveId: string,
    objectiveVersion: number,
  ): Promise<Objective | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM objectives
       WHERE objective_id = $1 AND objective_version = $2`,
      [objectiveId, objectiveVersion],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          parseObjective,
          row.payload,
          `objectives:${objectiveId}:${objectiveVersion}`,
        )
      : null;
  }

  async getByRunBinding(runId: string): Promise<Objective | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT o.payload
       FROM objective_run_bindings b
       JOIN objectives o
         ON o.project_id = b.project_id
        AND o.objective_id = b.objective_id
        AND o.objective_version = b.objective_version
       WHERE b.run_id = $1`,
      [runId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(parseObjective, row.payload, `objective_binding:${runId}`)
      : null;
  }

  async bindRun(
    runId: string,
    objectiveId: string,
    objectiveVersion: number,
  ): Promise<void> {
    const objective = await this.getById(objectiveId, objectiveVersion);
    await this.db.query(
      `INSERT INTO objective_run_bindings (run_id, project_id, objective_id, objective_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (run_id) DO NOTHING`,
      [runId, objective?.projectId ?? "", objectiveId, objectiveVersion],
    );
  }
}

function isWellFormedLock(value: ProjectLock): boolean {
  return (
    value.projectId.length > 0 &&
    value.runId.length > 0 &&
    value.lockOwner.length > 0 &&
    value.acquiredAt.length > 0 &&
    value.expiresAt.length > 0
  );
}

export class PostgresProjectLockService implements ProjectLockService {
  constructor(private readonly db: PostgresDatabase) {}

  async getActiveLock(projectId: string): Promise<ProjectLock | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM project_locks WHERE project_id = $1`,
      [projectId],
    );
    const row = result.rows[0];
    return row ? (row.payload as ProjectLock) : null;
  }

  async acquire(command: AcquireLockCommand): Promise<LockAcquireResult> {
    const lock: ProjectLock = {
      projectId: command.projectId,
      runId: command.runId,
      lockOwner: command.lockOwner,
      acquiredAt: command.acquiredAt,
      expiresAt: command.expiresAt,
    };
    if (command.resourceScope !== undefined) {
      lock.resourceScope = command.resourceScope;
    }
    if (!isWellFormedLock(lock)) {
      return { result: "RESOURCE_CONFLICT", lock: null };
    }
    const inserted = await this.db.query<{ run_id: string }>(
      `INSERT INTO project_locks (project_id, run_id, payload)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (project_id) DO NOTHING
       RETURNING run_id`,
      [command.projectId, command.runId, JSON.stringify(lock)],
    );
    if (inserted.rows.length > 0) {
      return { result: "LOCK_ACQUIRED", lock };
    }
    const existing = await this.getActiveLock(command.projectId);
    if (existing && existing.runId === command.runId) {
      return { result: "LOCK_ALREADY_OWNED", lock: existing };
    }
    return { result: "RESOURCE_CONFLICT", lock: existing };
  }

  async release(projectId: string, runId: string): Promise<void> {
    await this.db.query(
      `DELETE FROM project_locks WHERE project_id = $1 AND run_id = $2`,
      [projectId, runId],
    );
  }
}
