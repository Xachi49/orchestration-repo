import {
  parseStepExecutionResult,
  type StepExecutionResult,
} from "../domain/execution/index.js";
import { ExecutionError } from "./errors.js";

export interface StepExecutionRepository {
  /**
   * Reserve the idempotency key. Does NOT cross the side-effect boundary.
   * Status is RESERVED until markRunning().
   */
  reserve(input: {
    idempotencyKey: string;
    runId: string;
    executionAttemptId: string;
    stepId: string;
    capabilityId: string;
    actionType: string;
    startedAt: string;
  }): Promise<
    | { outcome: "RESERVED"; result: StepExecutionResult }
    | { outcome: "REPLAY"; result: StepExecutionResult }
  >;

  /**
   * Atomically transition RESERVED → RUNNING before SafeActuator invocation.
   * RUNNING means the side-effect boundary may have been crossed.
   */
  markRunning(idempotencyKey: string): Promise<StepExecutionResult>;

  getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<StepExecutionResult | null>;

  complete(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult>;

  fail(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult>;

  /**
   * Reconcile a RUNNING record to SUCCEEDED when actuator evidence proves
   * the side effect completed. Otherwise leave RUNNING / fail closed.
   */
  reconcileSucceeded(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult>;

  listByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<readonly StepExecutionResult[]>;
}

/**
 * In-memory step execution store.
 *
 * ```text
 * RESERVED  → side-effect boundary NOT crossed (safe to continue)
 * RUNNING   → side-effect boundary MAY have been crossed
 * SUCCEEDED | FAILED → terminal
 *
 * same key + SUCCEEDED → replay
 * same key + RUNNING   → STEP_EXECUTION_STATE_UNKNOWN (no blind re-run)
 * same key + RESERVED  → return existing reservation
 * ```
 *
 * Durable implementations must CAS RESERVED→RUNNING and unique-key reserve.
 */
export class InMemoryStepExecutionRepository
  implements StepExecutionRepository
{
  private readonly byKey = new Map<string, StepExecutionResult>();
  private readonly byAttempt = new Map<string, string[]>();

  async reserve(input: {
    idempotencyKey: string;
    runId: string;
    executionAttemptId: string;
    stepId: string;
    capabilityId: string;
    actionType: string;
    startedAt: string;
  }): Promise<
    | { outcome: "RESERVED"; result: StepExecutionResult }
    | { outcome: "REPLAY"; result: StepExecutionResult }
  > {
    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) {
      if (existing.status === "SUCCEEDED" || existing.status === "COMPENSATED") {
        return { outcome: "REPLAY", result: existing };
      }
      if (existing.status === "RUNNING") {
        throw new ExecutionError(
          "STEP_EXECUTION_STATE_UNKNOWN",
          `Step ${existing.stepId} is RUNNING with uncertain side-effect state; refusing blind re-execution`,
          { idempotencyKey: input.idempotencyKey, stepId: existing.stepId },
        );
      }
      if (existing.status === "RESERVED") {
        return { outcome: "RESERVED", result: existing };
      }
      if (
        existing.status === "FAILED" ||
        existing.status === "CONTAINED" ||
        existing.status === "SKIPPED"
      ) {
        throw new ExecutionError(
          "EXECUTION_IDEMPOTENCY_CONFLICT",
          `Step previously ended in ${existing.status}; refusing blind re-execution`,
          { idempotencyKey: input.idempotencyKey, status: existing.status },
        );
      }
    }

    const reserved = parseStepExecutionResult({
      stepId: input.stepId,
      idempotencyKey: input.idempotencyKey,
      capabilityId: input.capabilityId,
      actionType: input.actionType,
      status: "RESERVED",
      startedAt: input.startedAt,
      outputArtifactRefs: [],
      outputHashes: [],
      affectedTargets: [],
      executionAttemptId: input.executionAttemptId,
      runId: input.runId,
    });
    this.byKey.set(input.idempotencyKey, reserved);
    const order = this.byAttempt.get(input.executionAttemptId) ?? [];
    if (!order.includes(input.idempotencyKey)) {
      order.push(input.idempotencyKey);
      this.byAttempt.set(input.executionAttemptId, order);
    }
    return { outcome: "RESERVED", result: reserved };
  }

  async markRunning(idempotencyKey: string): Promise<StepExecutionResult> {
    const existing = this.byKey.get(idempotencyKey);
    if (!existing) {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `Cannot markRunning: unknown key ${idempotencyKey}`,
      );
    }
    if (existing.status === "RUNNING") {
      return existing;
    }
    if (existing.status !== "RESERVED") {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        `markRunning requires RESERVED, got ${existing.status}`,
        { idempotencyKey, status: existing.status },
      );
    }
    const running = parseStepExecutionResult({
      ...existing,
      status: "RUNNING",
    });
    this.byKey.set(idempotencyKey, running);
    return running;
  }

  async getByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<StepExecutionResult | null> {
    return this.byKey.get(idempotencyKey) ?? null;
  }

  async complete(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult> {
    const existing = this.byKey.get(idempotencyKey);
    if (!existing) {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `Cannot complete unknown key ${idempotencyKey}`,
      );
    }
    if (existing.status !== "RUNNING") {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        `complete() requires RUNNING, got ${existing.status}`,
      );
    }
    const parsed = parseStepExecutionResult(result);
    if (parsed.idempotencyKey !== idempotencyKey) {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        "Idempotency key mismatch on complete",
      );
    }
    if (parsed.status !== "SUCCEEDED" && parsed.status !== "COMPENSATED") {
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `complete() requires SUCCEEDED/COMPENSATED, got ${parsed.status}`,
      );
    }
    this.byKey.set(idempotencyKey, parsed);
    return parsed;
  }

  async fail(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult> {
    const existing = this.byKey.get(idempotencyKey);
    if (existing && existing.status !== "RUNNING" && existing.status !== "RESERVED") {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        `fail() requires RESERVED or RUNNING, got ${existing.status}`,
      );
    }
    const parsed = parseStepExecutionResult(result);
    if (parsed.idempotencyKey !== idempotencyKey) {
      throw new ExecutionError(
        "EXECUTION_IDEMPOTENCY_CONFLICT",
        "Idempotency key mismatch on fail",
      );
    }
    this.byKey.set(idempotencyKey, parsed);
    return parsed;
  }

  async reconcileSucceeded(
    idempotencyKey: string,
    result: StepExecutionResult,
  ): Promise<StepExecutionResult> {
    const existing = this.byKey.get(idempotencyKey);
    if (!existing || existing.status !== "RUNNING") {
      throw new ExecutionError(
        "STEP_EXECUTION_STATE_UNKNOWN",
        `Cannot reconcile: expected RUNNING for ${idempotencyKey}`,
      );
    }
    const parsed = parseStepExecutionResult({
      ...result,
      status: "SUCCEEDED",
      idempotencyKey,
    });
    this.byKey.set(idempotencyKey, parsed);
    return parsed;
  }

  async listByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<readonly StepExecutionResult[]> {
    const keys = this.byAttempt.get(executionAttemptId) ?? [];
    return keys
      .map((key) => this.byKey.get(key))
      .filter((r): r is StepExecutionResult => r !== undefined);
  }
}
