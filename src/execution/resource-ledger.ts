import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { ExecutionError } from "./errors.js";

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
 * Discrete hard resources that can be known ahead of time are reserved
 * before the side-effect boundary is crossed.
 */
export class ExecutionResourceLedger {
  private usage: ExecutionResourceUsage = {
    apiCalls: 0,
    durationMs: 0,
    reservedDurationMs: 0,
    testExecutions: 0,
    taskCreations: 0,
    artifactBytes: 0,
    stepsExecuted: 0,
  };

  constructor(
    private readonly budget: ResourceBudgetProfile,
    readonly runId: string,
    readonly executionAttemptId: string,
  ) {}

  snapshot(): ExecutionResourceUsage {
    return { ...this.usage };
  }

  ceilingMs(): number {
    return this.budget.maximumExecutionMinutes * 60_000;
  }

  remainingExecutionMs(): number {
    return Math.max(
      0,
      this.ceilingMs() - this.usage.durationMs - this.usage.reservedDurationMs,
    );
  }

  /**
   * Strictest allowed runtime for a step before actuation.
   * Returns 0 when the step must not start.
   */
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

  /**
   * Reserve discrete duration before crossing the side-effect boundary.
   * Fails closed if insufficient remaining budget.
   */
  reserveDurationMs(ms: number): void {
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

  /** Convert reservation into consumed duration after actuation settles. */
  settleReservedDuration(reservedMs: number, actualMs: number): void {
    this.usage.reservedDurationMs = Math.max(
      0,
      this.usage.reservedDurationMs - reservedMs,
    );
    this.usage.durationMs += Math.max(0, actualMs);
    this.assertWithinBudget();
  }

  releaseReservation(reservedMs: number): void {
    this.usage.reservedDurationMs = Math.max(
      0,
      this.usage.reservedDurationMs - reservedMs,
    );
  }

  /**
   * Fail closed before side effects if discrete counters would exceed ceilings.
   * Duration is reserved separately via reserveDurationMs.
   * Does not invent monetary costs.
   */
  assertDiscreteBudgetAvailable(delta: {
    stepsExecuted?: number;
    apiCalls?: number;
  }): void {
    const nextSteps = this.usage.stepsExecuted + (delta.stepsExecuted ?? 0);
    if (nextSteps > this.budget.maximumPlanSteps) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Executed steps would exceed ceiling of ${this.budget.maximumPlanSteps}`,
        { usage: this.usage, requested: delta },
      );
    }
    const nextApi = this.usage.apiCalls + (delta.apiCalls ?? 0);
    if (nextApi > this.budget.maximumApiCalls) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `API calls would exceed ceiling of ${this.budget.maximumApiCalls}`,
        { usage: this.usage, requested: delta },
      );
    }
  }

  recordStep(delta: Partial<ExecutionResourceUsage>): void {
    this.usage = {
      apiCalls: this.usage.apiCalls + (delta.apiCalls ?? 0),
      durationMs: this.usage.durationMs + (delta.durationMs ?? 0),
      reservedDurationMs: this.usage.reservedDurationMs,
      testExecutions: this.usage.testExecutions + (delta.testExecutions ?? 0),
      taskCreations: this.usage.taskCreations + (delta.taskCreations ?? 0),
      artifactBytes: this.usage.artifactBytes + (delta.artifactBytes ?? 0),
      stepsExecuted: this.usage.stepsExecuted + (delta.stepsExecuted ?? 1),
    };
    this.assertWithinBudget();
  }

  assertWithinBudget(): void {
    const maxMinutes = this.budget.maximumExecutionMinutes;
    const committed = this.usage.durationMs + this.usage.reservedDurationMs;
    if (committed > maxMinutes * 60_000) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Execution duration exceeds ceiling of ${maxMinutes} minutes`,
        { usage: this.usage },
      );
    }
    if (this.usage.apiCalls > this.budget.maximumApiCalls) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `API calls exceed ceiling of ${this.budget.maximumApiCalls}`,
        { usage: this.usage },
      );
    }
    if (this.usage.stepsExecuted > this.budget.maximumPlanSteps) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        `Executed steps exceed ceiling of ${this.budget.maximumPlanSteps}`,
        { usage: this.usage },
      );
    }
  }
}
