import type { ResourceBudgetProfile } from "../../../control-plane/budgets/budget.js";
import type {
  ExecutionResourceLedgerRecord,
  ExecutionResourceLedgerStore,
} from "../../../execution/resource-ledger-store.js";
import { ExecutionError } from "../../../execution/errors.js";
import { DurabilityError } from "../../../durability/errors.js";
import { assertProjectScope } from "../../../domain/project-scope.js";
import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";

function mapRow(row: {
  execution_attempt_id: string;
  run_id: string;
  project_id: string;
  budget_profile_id: string;
  api_calls: number;
  duration_ms: string | number;
  reserved_duration_ms: string | number;
  test_executions: number;
  task_creations: number;
  artifact_bytes: string | number;
  steps_executed: number;
  ceiling_duration_ms: string | number;
  ceiling_api_calls: number;
  ceiling_plan_steps: number;
  record_revision: string | number;
}): ExecutionResourceLedgerRecord {
  return {
    executionAttemptId: row.execution_attempt_id,
    runId: row.run_id,
    projectId: row.project_id,
    budgetProfileId: row.budget_profile_id,
    usage: {
      apiCalls: row.api_calls,
      durationMs: Number(row.duration_ms),
      reservedDurationMs: Number(row.reserved_duration_ms),
      testExecutions: row.test_executions,
      taskCreations: row.task_creations,
      artifactBytes: Number(row.artifact_bytes),
      stepsExecuted: row.steps_executed,
    },
    ceilingDurationMs: Number(row.ceiling_duration_ms),
    ceilingApiCalls: row.ceiling_api_calls,
    ceilingPlanSteps: row.ceiling_plan_steps,
    recordRevision: Number(row.record_revision),
  };
}

type LedgerRow = Parameters<typeof mapRow>[0];

export class PostgresExecutionResourceLedgerStore
  implements ExecutionResourceLedgerStore
{
  constructor(private readonly db: PostgresDatabase) {}

  async initialize(input: {
    executionAttemptId: string;
    runId: string;
    projectId: string;
    budget: ResourceBudgetProfile;
  }): Promise<ExecutionResourceLedgerRecord> {
    const ceilingDurationMs = input.budget.maximumExecutionMinutes * 60_000;
    try {
      const result = await this.db.query<LedgerRow>(
        `INSERT INTO execution_resource_ledgers (
           execution_attempt_id, run_id, project_id, budget_profile_id,
           ceiling_duration_ms, ceiling_api_calls, ceiling_plan_steps
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (execution_attempt_id) DO UPDATE
           SET updated_at = NOW()
         RETURNING *`,
        [
          input.executionAttemptId,
          input.runId,
          input.projectId,
          input.budget.budgetProfileId,
          ceilingDurationMs,
          input.budget.maximumApiCalls,
          input.budget.maximumPlanSteps,
        ],
      );
      return mapRow(result.rows[0]!);
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async load(
    executionAttemptId: string,
  ): Promise<ExecutionResourceLedgerRecord | null> {
    const result = await this.db.query<LedgerRow>(
      `SELECT * FROM execution_resource_ledgers WHERE execution_attempt_id = $1`,
      [executionAttemptId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async loadInProject(
    executionAttemptId: string,
    projectId: string,
  ): Promise<ExecutionResourceLedgerRecord | null> {
    const record = await this.load(executionAttemptId);
    if (!record) {
      return null;
    }
    assertProjectScope(
      record.projectId,
      projectId,
      "execution resource ledger",
      executionAttemptId,
    );
    return record;
  }

  async reserveDurationMs(
    executionAttemptId: string,
    expectedRevision: number,
    ms: number,
  ): Promise<ExecutionResourceLedgerRecord> {
    if (ms <= 0) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Insufficient execution time remains to safely start this operation",
        { requestedMs: ms },
      );
    }
    const result = await this.db.query<LedgerRow>(
      `UPDATE execution_resource_ledgers
       SET reserved_duration_ms = reserved_duration_ms + $3,
           record_revision = record_revision + 1,
           updated_at = NOW()
       WHERE execution_attempt_id = $1
         AND record_revision = $2
         AND (duration_ms + reserved_duration_ms + $3) <= ceiling_duration_ms
       RETURNING *`,
      [executionAttemptId, expectedRevision, ms],
    );
    if (result.rowCount !== 1) {
      const current = await this.load(executionAttemptId);
      if (!current) {
        throw new DurabilityError(
          "PERSISTED_RECORD_INVALID",
          `Missing execution resource ledger for ${executionAttemptId}`,
        );
      }
      if (current.recordRevision !== expectedRevision) {
        throw new DurabilityError(
          "DURABLE_CONFLICT",
          `Execution resource ledger revision conflict for ${executionAttemptId}`,
        );
      }
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Insufficient execution time remains",
        {
          remainingMs:
            current.ceilingDurationMs -
            current.usage.durationMs -
            current.usage.reservedDurationMs,
          requestedMs: ms,
        },
      );
    }
    return mapRow(result.rows[0]!);
  }

  async settleReservedDuration(
    executionAttemptId: string,
    expectedRevision: number,
    reservedMs: number,
    actualMs: number,
  ): Promise<ExecutionResourceLedgerRecord> {
    const result = await this.db.query<LedgerRow>(
      `UPDATE execution_resource_ledgers
       SET reserved_duration_ms = GREATEST(0, reserved_duration_ms - $3),
           duration_ms = duration_ms + GREATEST(0, $4),
           record_revision = record_revision + 1,
           updated_at = NOW()
       WHERE execution_attempt_id = $1
         AND record_revision = $2
         AND (duration_ms + GREATEST(0, reserved_duration_ms - $3) + GREATEST(0, $4))
             <= ceiling_duration_ms
       RETURNING *`,
      [executionAttemptId, expectedRevision, reservedMs, actualMs],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "DURABLE_CONFLICT",
        `Execution resource ledger settle failed for ${executionAttemptId}`,
      );
    }
    const record = mapRow(result.rows[0]!);
    this.assertWithinCeilings(record);
    return record;
  }

  async releaseReservation(
    executionAttemptId: string,
    expectedRevision: number,
    reservedMs: number,
  ): Promise<ExecutionResourceLedgerRecord> {
    const result = await this.db.query<LedgerRow>(
      `UPDATE execution_resource_ledgers
       SET reserved_duration_ms = GREATEST(0, reserved_duration_ms - $3),
           record_revision = record_revision + 1,
           updated_at = NOW()
       WHERE execution_attempt_id = $1 AND record_revision = $2
       RETURNING *`,
      [executionAttemptId, expectedRevision, reservedMs],
    );
    if (result.rowCount !== 1) {
      throw new DurabilityError(
        "DURABLE_CONFLICT",
        `Execution resource ledger release failed for ${executionAttemptId}`,
      );
    }
    return mapRow(result.rows[0]!);
  }

  async recordStep(
    executionAttemptId: string,
    expectedRevision: number,
    delta: Partial<{
      apiCalls: number;
      durationMs: number;
      testExecutions: number;
      taskCreations: number;
      artifactBytes: number;
      stepsExecuted: number;
    }>,
  ): Promise<ExecutionResourceLedgerRecord> {
    const result = await this.db.query<LedgerRow>(
      `UPDATE execution_resource_ledgers
       SET api_calls = api_calls + $3,
           duration_ms = duration_ms + $4,
           test_executions = test_executions + $5,
           task_creations = task_creations + $6,
           artifact_bytes = artifact_bytes + $7,
           steps_executed = steps_executed + $8,
           record_revision = record_revision + 1,
           updated_at = NOW()
       WHERE execution_attempt_id = $1
         AND record_revision = $2
         AND api_calls + $3 <= ceiling_api_calls
         AND steps_executed + $8 <= ceiling_plan_steps
         AND duration_ms + reserved_duration_ms + $4 <= ceiling_duration_ms
       RETURNING *`,
      [
        executionAttemptId,
        expectedRevision,
        delta.apiCalls ?? 0,
        delta.durationMs ?? 0,
        delta.testExecutions ?? 0,
        delta.taskCreations ?? 0,
        delta.artifactBytes ?? 0,
        delta.stepsExecuted ?? 1,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Execution resource budget exceeded while recording step",
        { executionAttemptId, delta },
      );
    }
    return mapRow(result.rows[0]!);
  }

  private assertWithinCeilings(record: ExecutionResourceLedgerRecord): void {
    const u = record.usage;
    const committed = u.durationMs + u.reservedDurationMs;
    if (committed > record.ceilingDurationMs) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Execution duration exceeds ceiling",
        { usage: u },
      );
    }
    if (u.apiCalls > record.ceilingApiCalls) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "API calls exceed ceiling",
        { usage: u },
      );
    }
    if (u.stepsExecuted > record.ceilingPlanSteps) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Executed steps exceed ceiling",
        { usage: u },
      );
    }
  }
}
