import { InMemoryTransactionManager } from "../../durability/transaction.js";
import type {
  ExecutionResourceLedgerRecord,
  ExecutionResourceLedgerStore,
} from "../../execution/resource-ledger-store.js";
import type { ResourceBudgetProfile } from "../../control-plane/budgets/budget.js";
import { ExecutionError } from "../../execution/errors.js";

/** In-memory durable store for unit tests; mirrors postgres CAS semantics. */
export class InMemoryExecutionResourceLedgerStore
  implements ExecutionResourceLedgerStore
{
  private readonly records = new Map<string, ExecutionResourceLedgerRecord>();

  async initialize(input: {
    executionAttemptId: string;
    runId: string;
    projectId: string;
    budget: ResourceBudgetProfile;
  }): Promise<ExecutionResourceLedgerRecord> {
    const existing = this.records.get(input.executionAttemptId);
    if (existing) {
      return existing;
    }
    const record: ExecutionResourceLedgerRecord = {
      executionAttemptId: input.executionAttemptId,
      runId: input.runId,
      projectId: input.projectId,
      budgetProfileId: input.budget.budgetProfileId,
      usage: {
        apiCalls: 0,
        durationMs: 0,
        reservedDurationMs: 0,
        testExecutions: 0,
        taskCreations: 0,
        artifactBytes: 0,
        stepsExecuted: 0,
      },
      ceilingDurationMs: input.budget.maximumExecutionMinutes * 60_000,
      ceilingApiCalls: input.budget.maximumApiCalls,
      ceilingPlanSteps: input.budget.maximumPlanSteps,
      recordRevision: 1,
    };
    this.records.set(input.executionAttemptId, record);
    return record;
  }

  async load(
    executionAttemptId: string,
  ): Promise<ExecutionResourceLedgerRecord | null> {
    const record = this.records.get(executionAttemptId);
    return record ? structuredClone(record) : null;
  }

  async reserveDurationMs(
    executionAttemptId: string,
    expectedRevision: number,
    ms: number,
  ): Promise<ExecutionResourceLedgerRecord> {
    return this.mutate(executionAttemptId, expectedRevision, (record) => {
      const remaining =
        record.ceilingDurationMs -
        record.usage.durationMs -
        record.usage.reservedDurationMs;
      if (ms <= 0 || ms > remaining) {
        throw new ExecutionError(
          "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
          "Insufficient execution time remains",
          { remainingMs: remaining, requestedMs: ms },
        );
      }
      record.usage.reservedDurationMs += ms;
    });
  }

  async settleReservedDuration(
    executionAttemptId: string,
    expectedRevision: number,
    reservedMs: number,
    actualMs: number,
  ): Promise<ExecutionResourceLedgerRecord> {
    return this.mutate(executionAttemptId, expectedRevision, (record) => {
      record.usage.reservedDurationMs = Math.max(
        0,
        record.usage.reservedDurationMs - reservedMs,
      );
      record.usage.durationMs += Math.max(0, actualMs);
      this.assertWithinCeilings(record);
    });
  }

  async releaseReservation(
    executionAttemptId: string,
    expectedRevision: number,
    reservedMs: number,
  ): Promise<ExecutionResourceLedgerRecord> {
    return this.mutate(executionAttemptId, expectedRevision, (record) => {
      record.usage.reservedDurationMs = Math.max(
        0,
        record.usage.reservedDurationMs - reservedMs,
      );
    });
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
    return this.mutate(executionAttemptId, expectedRevision, (record) => {
      record.usage = {
        apiCalls: record.usage.apiCalls + (delta.apiCalls ?? 0),
        durationMs: record.usage.durationMs + (delta.durationMs ?? 0),
        reservedDurationMs: record.usage.reservedDurationMs,
        testExecutions: record.usage.testExecutions + (delta.testExecutions ?? 0),
        taskCreations: record.usage.taskCreations + (delta.taskCreations ?? 0),
        artifactBytes: record.usage.artifactBytes + (delta.artifactBytes ?? 0),
        stepsExecuted: record.usage.stepsExecuted + (delta.stepsExecuted ?? 1),
      };
      this.assertWithinCeilings(record);
    });
  }

  private mutate(
    executionAttemptId: string,
    expectedRevision: number,
    fn: (record: ExecutionResourceLedgerRecord) => void,
  ): Promise<ExecutionResourceLedgerRecord> {
    const record = this.records.get(executionAttemptId);
    if (!record || record.recordRevision !== expectedRevision) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Execution resource ledger revision conflict",
        { executionAttemptId, expectedRevision },
      );
    }
    fn(record);
    record.recordRevision += 1;
    return Promise.resolve(structuredClone(record));
  }

  private assertWithinCeilings(record: ExecutionResourceLedgerRecord): void {
    const u = record.usage;
    if (u.durationMs + u.reservedDurationMs > record.ceilingDurationMs) {
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

export const inMemoryExecutionResourceLedgerStore =
  new InMemoryExecutionResourceLedgerStore();

export const inMemoryExecutionResourceTransactions =
  new InMemoryTransactionManager();
