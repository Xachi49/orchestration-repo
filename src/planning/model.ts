import type { GapAnalysis, PlanProposal } from "./proposal.js";
import type { PlanningContext } from "./context.js";
import { PlanningError } from "./errors.js";

/**
 * Provider-independent token usage from a single planning model call.
 * Monetary cost is omitted unless deterministically available from the provider.
 */
export interface PlanningModelTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface PlanningModelOutput<T> {
  value: T;
  usage?: PlanningModelTokenUsage;
}

/**
 * Provider-independent planning model port.
 * Proposes only — no tools, no execution, no approval, no policy authority.
 */
export interface PlanningModel {
  readonly provider: string;
  readonly modelId: string;
  readonly toolsEnabled: false;

  analyzeGaps(input: {
    context: PlanningContext;
    promptVersion: string;
  }): Promise<PlanningModelOutput<GapAnalysis>>;

  proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>>;
}

export type PlanningModelOperation = "GAP_ANALYSIS" | "PLAN_PROPOSAL";

export type PlanningModelUsageStatus =
  | "STARTED"
  | "SUCCESS"
  | "FAILED"
  | "TIMEOUT"
  | "REFUSED"
  | "RELEASED";

/**
 * Authoritative Phase 4 planning-inference usage record.
 * Distinct from PlanProposal estimated future execution resources.
 *
 * While `status === "STARTED"`, `reservedTokens` counts against the run budget.
 * On settle, reservation is released and `totalUsage` holds the charged amount.
 */
export interface PlanningModelUsage {
  callId: string;
  runId: string;
  planningAttempt: number;
  operation: PlanningModelOperation;
  provider: string;
  model: string;
  reservedTokens: number;
  inputUsage?: number;
  outputUsage?: number;
  /** Charged tokens after settle (actual or conservative reservation). */
  totalUsage?: number;
  startedAt: string;
  completedAt?: string;
  status: PlanningModelUsageStatus;
  budgetInvariantViolation?: boolean;
  charging?: "ACTUAL" | "RESERVATION" | "NONE";
}

export interface PlanningUsageAggregate {
  /** Completed provider-bound attempts + in-flight STARTED (excludes RELEASED). */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** completedActualTokens + activeReservedTokens */
  totalTokens: number;
  completedActualTokens: number;
  activeReservedTokens: number;
  budgetInvariantViolated: boolean;
}

export interface PlanningTokenReservationRequest {
  callId: string;
  runId: string;
  planningAttempt: number;
  operation: PlanningModelOperation;
  provider: string;
  model: string;
  reservedTokens: number;
  startedAt: string;
  maximumLlmCalls: number;
  maximumTotalTokens: number;
  budgetProfileId: string;
}

export type PlanningUsageSettle =
  | {
      outcome: "SUCCESS" | "FAILED" | "TIMEOUT" | "REFUSED";
      completedAt: string;
      charging: "ACTUAL";
      inputUsage?: number;
      outputUsage?: number;
      totalUsage: number;
      markInvariantViolation?: boolean;
    }
  | {
      outcome: "SUCCESS" | "FAILED" | "TIMEOUT" | "REFUSED";
      completedAt: string;
      charging: "RESERVATION";
    }
  | {
      outcome: "RELEASED";
      completedAt: string;
      charging: "NONE";
      reason: "PRE_DISPATCH_FAILURE";
    };

/**
 * Planning-inference usage ledger.
 *
 * `reserve` must be atomic w.r.t. other reservations for the same runId.
 * The in-memory implementation provides process-local atomicity.
 * Durable implementations require transactional or compare-and-swap reservation
 * so concurrent planners cannot oversubscribe maximumTotalTokens.
 */
export interface PlanningUsageLedger {
  reserve(
    request: PlanningTokenReservationRequest,
  ): Promise<PlanningModelUsage>;
  settle(
    callId: string,
    update: PlanningUsageSettle,
  ): Promise<PlanningModelUsage>;
  listByRunId(runId: string): Promise<readonly PlanningModelUsage[]>;
  hasBudgetInvariantViolation(runId: string): Promise<boolean>;
}

export function aggregatePlanningUsage(
  records: readonly PlanningModelUsage[],
): PlanningUsageAggregate {
  let inputTokens = 0;
  let outputTokens = 0;
  let completedActualTokens = 0;
  let activeReservedTokens = 0;
  let llmCalls = 0;
  let budgetInvariantViolated = false;

  for (const record of records) {
    if (record.budgetInvariantViolation) {
      budgetInvariantViolated = true;
    }
    if (record.status === "RELEASED") {
      continue;
    }
    llmCalls += 1;
    if (record.status === "STARTED") {
      activeReservedTokens += record.reservedTokens;
      continue;
    }
    completedActualTokens += record.totalUsage ?? 0;
    inputTokens += record.inputUsage ?? 0;
    outputTokens += record.outputUsage ?? 0;
  }

  return {
    llmCalls,
    inputTokens,
    outputTokens,
    completedActualTokens,
    activeReservedTokens,
    totalTokens: completedActualTokens + activeReservedTokens,
    budgetInvariantViolated,
  };
}

export function resolveChargedTokenTotal(
  usage: PlanningModelTokenUsage | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  if (typeof usage.totalTokens === "number") {
    return usage.totalTokens;
  }
  if (
    typeof usage.inputTokens === "number" ||
    typeof usage.outputTokens === "number"
  ) {
    return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  }
  return undefined;
}

/**
 * Error thrown when a model call fails before any provider dispatch.
 * Releases reservation without charging.
 */
export class PlanningPreDispatchError extends Error {
  readonly preDispatch = true as const;

  constructor(message: string) {
    super(message);
    this.name = "PlanningPreDispatchError";
  }
}

export function isPlanningPreDispatchError(
  error: unknown,
): error is PlanningPreDispatchError {
  return (
    error instanceof PlanningPreDispatchError ||
    (typeof error === "object" &&
      error !== null &&
      "preDispatch" in error &&
      (error as { preDispatch: unknown }).preDispatch === true)
  );
}

export class InMemoryPlanningUsageLedger implements PlanningUsageLedger {
  private readonly byCallId = new Map<string, PlanningModelUsage>();
  private readonly invariantRuns = new Set<string>();
  /** Per-run serialization chain for process-local atomic reserve/settle. */
  private readonly runLocks = new Map<string, Promise<unknown>>();

  private async withRunLock<T>(
    runId: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.runLocks.set(
      runId,
      previous.catch(() => undefined).then(() => gate),
    );
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private recordsForRun(runId: string): PlanningModelUsage[] {
    return [...this.byCallId.values()].filter(
      (record) => record.runId === runId,
    );
  }

  async reserve(
    request: PlanningTokenReservationRequest,
  ): Promise<PlanningModelUsage> {
    return this.withRunLock(request.runId, () => {
      if (this.byCallId.has(request.callId)) {
        throw new Error(
          `Planning usage callId already exists: ${request.callId}`,
        );
      }
      if (
        this.invariantRuns.has(request.runId) ||
        this.recordsForRun(request.runId).some(
          (record) => record.budgetInvariantViolation,
        )
      ) {
        throw new PlanningError(
          "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION",
          "Planning inference budget invariant previously violated; further model calls are blocked",
          { runId: request.runId },
        );
      }

      const aggregate = aggregatePlanningUsage(
        this.recordsForRun(request.runId),
      );

      if (aggregate.llmCalls >= request.maximumLlmCalls) {
        throw new PlanningError(
          "PLANNING_MODEL_BUDGET_EXCEEDED",
          "Planning inference LLM call budget exhausted",
          {
            dimension: "maximumLlmCalls",
            used: aggregate.llmCalls,
            limit: request.maximumLlmCalls,
            budgetProfileId: request.budgetProfileId,
          },
        );
      }

      const remaining =
        request.maximumTotalTokens -
        aggregate.completedActualTokens -
        aggregate.activeReservedTokens;

      if (request.reservedTokens > remaining) {
        throw new PlanningError(
          "PLANNING_MODEL_BUDGET_EXCEEDED",
          "Planning inference token reservation exceeds remaining budget",
          {
            dimension: "maximumTotalTokens",
            requiredReservation: request.reservedTokens,
            remaining,
            completedActualTokens: aggregate.completedActualTokens,
            activeReservedTokens: aggregate.activeReservedTokens,
            limit: request.maximumTotalTokens,
            budgetProfileId: request.budgetProfileId,
          },
        );
      }

      const record: PlanningModelUsage = {
        callId: request.callId,
        runId: request.runId,
        planningAttempt: request.planningAttempt,
        operation: request.operation,
        provider: request.provider,
        model: request.model,
        reservedTokens: request.reservedTokens,
        startedAt: request.startedAt,
        status: "STARTED",
      };
      this.byCallId.set(request.callId, record);
      return { ...record };
    });
  }

  async settle(
    callId: string,
    update: PlanningUsageSettle,
  ): Promise<PlanningModelUsage> {
    const existing = this.byCallId.get(callId);
    if (!existing) {
      throw new Error(`Unknown planning usage callId: ${callId}`);
    }
    return this.withRunLock(existing.runId, () => {
      const current = this.byCallId.get(callId);
      if (!current) {
        throw new Error(`Unknown planning usage callId: ${callId}`);
      }
      if (current.status !== "STARTED") {
        throw new Error(
          `Planning usage callId ${callId} already settled as ${current.status}`,
        );
      }

      if (update.charging === "NONE") {
        const released: PlanningModelUsage = {
          ...current,
          status: "RELEASED",
          completedAt: update.completedAt,
          charging: "NONE",
          totalUsage: 0,
        };
        this.byCallId.set(callId, released);
        return { ...released };
      }

      if (update.charging === "RESERVATION") {
        const settled: PlanningModelUsage = {
          ...current,
          status: update.outcome,
          completedAt: update.completedAt,
          charging: "RESERVATION",
          totalUsage: current.reservedTokens,
        };
        this.byCallId.set(callId, settled);
        return { ...settled };
      }

      const settled: PlanningModelUsage = {
        ...current,
        status: update.outcome,
        completedAt: update.completedAt,
        charging: "ACTUAL",
        totalUsage: update.totalUsage,
      };
      if (update.inputUsage !== undefined) {
        settled.inputUsage = update.inputUsage;
      }
      if (update.outputUsage !== undefined) {
        settled.outputUsage = update.outputUsage;
      }
      if (update.markInvariantViolation) {
        settled.budgetInvariantViolation = true;
        this.invariantRuns.add(current.runId);
      }
      this.byCallId.set(callId, settled);
      return { ...settled };
    });
  }

  async listByRunId(runId: string): Promise<readonly PlanningModelUsage[]> {
    return this.recordsForRun(runId);
  }

  async hasBudgetInvariantViolation(runId: string): Promise<boolean> {
    if (this.invariantRuns.has(runId)) {
      return true;
    }
    return this.recordsForRun(runId).some(
      (record) => record.budgetInvariantViolation === true,
    );
  }
}
