import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { ExecutionError } from "./errors.js";
import type {
  ExecutionResourceLedgerRecord,
  ExecutionResourceLedgerStore,
} from "./resource-ledger-store.js";

export interface ExecutionResourceUsage {
  apiCalls: number;
  durationMs: number;
  /** Duration reserved before actuation (not yet recorded as consumed). */
  reservedDurationMs: number;
  testExecutions: number;
  taskCreations: number;
  artifactBytes: number;
  stepsExecuted: number;
}

/**
 * Deterministic execution resource ledger against budget ceilings.
 * When a store is provided, all authority-bearing state is durable.
 */
export class ExecutionResourceLedger {
  private usage: ExecutionResourceUsage;
  private recordRevision: number;
  private readonly ceilingDurationMs: number;
  private readonly ceilingApiCalls: number;
  private readonly ceilingPlanSteps: number;

  constructor(
    private readonly budget: ResourceBudgetProfile,
    readonly runId: string,
    readonly executionAttemptId: string,
    private readonly store?: ExecutionResourceLedgerStore,
    initial?: ExecutionResourceLedgerRecord,
  ) {
    this.ceilingDurationMs = budget.maximumExecutionMinutes * 60_000;
    this.ceilingApiCalls = budget.maximumApiCalls;
    this.ceilingPlanSteps = budget.maximumPlanSteps;
    if (initial) {
      this.usage = { ...initial.usage };
      this.recordRevision = initial.recordRevision;
    } else {
      this.usage = {
        apiCalls: 0,
        durationMs: 0,
        reservedDurationMs: 0,
        testExecutions: 0,
        taskCreations: 0,
        artifactBytes: 0,
        stepsExecuted: 0,
      };
      this.recordRevision = 1;
    }
  }

  static async create(input: {
    budget: ResourceBudgetProfile;
    runId: string;
    projectId: string;
    executionAttemptId: string;
    store?: ExecutionResourceLedgerStore;
  }): Promise<ExecutionResourceLedger> {
    if (!input.store) {
      return new ExecutionResourceLedger(
        input.budget,
        input.runId,
        input.executionAttemptId,
      );
    }
    const record = await input.store.initialize({
      executionAttemptId: input.executionAttemptId,
      runId: input.runId,
      projectId: input.projectId,
      budget: input.budget,
    });
    return new ExecutionResourceLedger(
      input.budget,
      input.runId,
      input.executionAttemptId,
      input.store,
      record,
    );
  }

  static async loadExisting(input: {
    budget: ResourceBudgetProfile;
    store: ExecutionResourceLedgerStore;
    executionAttemptId: string;
  }): Promise<ExecutionResourceLedger | null> {
    const record = await input.store.load(input.executionAttemptId);
    if (!record) {
      return null;
    }
    return new ExecutionResourceLedger(
      input.budget,
      record.runId,
      record.executionAttemptId,
      input.store,
      record,
    );
  }

  snapshot(): ExecutionResourceUsage {
    return { ...this.usage };
  }

  ceilingMs(): number {
    return this.ceilingDurationMs;
  }

  remainingExecutionMs(): number {
    return Math.max(
      0,
      this.ceilingDurationMs -
        this.usage.durationMs -
        this.usage.reservedDurationMs,
    );
  }

  allowedRuntimeMs(bounds: {
    capabilityMaximumRuntimeSeconds: number;
    testProfileTimeoutSeconds?: number;
  }): number {
    const candidates = [
      bounds.capabilityMaximumRuntimeSeconds * 1000,
      this.remainingExecutionMs(),
    ];
    if (bounds.testProfileTimeoutSeconds !== undefined) {
      candidates.push(bounds.testProfileTimeoutSeconds * 1000);
    }
    return Math.max(0, Math.min(...candidates));
  }

  async reserveDurationMs(ms: number): Promise<void> {
    if (!this.store) {
      this.reserveDurationMsSync(ms);
      return;
    }
    const record = await this.store.reserveDurationMs(
      this.executionAttemptId,
      this.recordRevision,
      ms,
    );
    this.applyRecord(record);
  }

  async settleReservedDuration(reservedMs: number, actualMs: number): Promise<void> {
    if (!this.store) {
      this.settleReservedDurationSync(reservedMs, actualMs);
      return;
    }
    const record = await this.store.settleReservedDuration(
      this.executionAttemptId,
      this.recordRevision,
      reservedMs,
      actualMs,
    );
    this.applyRecord(record);
  }

  async releaseReservation(reservedMs: number): Promise<void> {
    if (!this.store) {
      this.releaseReservationSync(reservedMs);
      return;
    }
    const record = await this.store.releaseReservation(
      this.executionAttemptId,
      this.recordRevision,
      reservedMs,
    );
    this.applyRecord(record);
  }

  assertDiscreteBudgetAvailable(delta: {
    stepsExecuted?: number;
    apiCalls?: number;
  }): void {
    const nextSteps = this.usage.stepsExecuted + (delta.stepsExecuted ?? 0);
    if (nextSteps > this.ceilingPlanSteps) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Executed steps would exceed ceiling of ${this.ceilingPlanSteps}`,
        { usage: this.usage, requested: delta },
      );
    }
    const nextApi = this.usage.apiCalls + (delta.apiCalls ?? 0);
    if (nextApi > this.ceilingApiCalls) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `API calls would exceed ceiling of ${this.ceilingApiCalls}`,
        { usage: this.usage, requested: delta },
      );
    }
  }

  async recordStep(delta: Partial<ExecutionResourceUsage>): Promise<void> {
    if (!this.store) {
      this.recordStepSync(delta);
      return;
    }
    const record = await this.store.recordStep(
      this.executionAttemptId,
      this.recordRevision,
      delta,
    );
    this.applyRecord(record);
  }

  assertWithinBudget(): void {
    this.assertWithinBudgetSync();
  }

  private reserveDurationMsSync(ms: number): void {
    if (ms <= 0) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Insufficient execution time remains to safely start this operation",
        { remainingMs: this.remainingExecutionMs(), requestedMs: ms },
      );
    }
    if (ms > this.remainingExecutionMs()) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Insufficient execution time remains (need ${ms}ms, have ${this.remainingExecutionMs()}ms)`,
        { remainingMs: this.remainingExecutionMs(), requestedMs: ms },
      );
    }
    this.usage.reservedDurationMs += ms;
  }

  private settleReservedDurationSync(reservedMs: number, actualMs: number): void {
    this.usage.reservedDurationMs = Math.max(
      0,
      this.usage.reservedDurationMs - reservedMs,
    );
    this.usage.durationMs += Math.max(0, actualMs);
    this.assertWithinBudgetSync();
  }

  private releaseReservationSync(reservedMs: number): void {
    this.usage.reservedDurationMs = Math.max(
      0,
      this.usage.reservedDurationMs - reservedMs,
    );
  }

  private recordStepSync(delta: Partial<ExecutionResourceUsage>): void {
    this.usage = {
      apiCalls: this.usage.apiCalls + (delta.apiCalls ?? 0),
      durationMs: this.usage.durationMs + (delta.durationMs ?? 0),
      reservedDurationMs: this.usage.reservedDurationMs,
      testExecutions: this.usage.testExecutions + (delta.testExecutions ?? 0),
      taskCreations: this.usage.taskCreations + (delta.taskCreations ?? 0),
      artifactBytes: this.usage.artifactBytes + (delta.artifactBytes ?? 0),
      stepsExecuted: this.usage.stepsExecuted + (delta.stepsExecuted ?? 1),
    };
    this.assertWithinBudgetSync();
  }

  private assertWithinBudgetSync(): void {
    const committed = this.usage.durationMs + this.usage.reservedDurationMs;
    if (committed > this.ceilingDurationMs) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Execution duration exceeds ceiling of ${this.budget.maximumExecutionMinutes} minutes`,
        { usage: this.usage },
      );
    }
    if (this.usage.apiCalls > this.ceilingApiCalls) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `API calls exceed ceiling of ${this.ceilingApiCalls}`,
        { usage: this.usage },
      );
    }
    if (this.usage.stepsExecuted > this.ceilingPlanSteps) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Executed steps exceed ceiling of ${this.ceilingPlanSteps}`,
        { usage: this.usage },
      );
    }
  }

  private applyRecord(record: ExecutionResourceLedgerRecord): void {
    this.usage = { ...record.usage };
    this.recordRevision = record.recordRevision;
  }
}
