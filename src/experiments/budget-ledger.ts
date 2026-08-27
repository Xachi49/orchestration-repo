import type { ExperimentBudgetEnvelope } from "./experiment.js";
import { ExperimentError } from "./errors.js";
import type { ExperimentUsageLedger } from "./repositories.js";
import type { ExperimentUsageLedgerRepository } from "./repositories.js";

export type ExperimentUsageDelta = {
  designCalls?: number;
  modelCalls?: number;
  sampleCount?: number;
  reservedActions?: number;
  committedActions?: number;
};

/**
 * Atomic experiment budget reservation against durable ledger ceilings.
 * Uses CAS + retry — never read-then-write without a fence.
 */
export async function reserveExperimentUsage(input: {
  usageLedger: ExperimentUsageLedgerRepository;
  experimentId: string;
  budget: ExperimentBudgetEnvelope;
  delta: ExperimentUsageDelta;
  nowIso: string;
  maxAttempts?: number;
}): Promise<ExperimentUsageLedger> {
  const maxAttempts = input.maxAttempts ?? 8;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ledger = await input.usageLedger.get(input.experimentId);
    if (!ledger) {
      throw new ExperimentError(
        "EXPERIMENT_BUDGET_EXCEEDED",
        `Usage ledger missing for experiment ${input.experimentId}`,
      );
    }
    const next = applyUsageDelta(ledger, input.delta, input.nowIso);
    assertWithinBudget(next, input.budget);
    try {
      return await input.usageLedger.saveCas(next, ledger.recordRevision);
    } catch (err) {
      lastError = err;
      if (
        err instanceof ExperimentError &&
        err.code === "EXPERIMENT_CAS_CONFLICT"
      ) {
        continue;
      }
      throw err;
    }
  }
  throw (
    lastError ??
    new ExperimentError(
      "EXPERIMENT_CAS_CONFLICT",
      `Failed to reserve experiment usage after ${maxAttempts} attempts`,
    )
  );
}

export function applyUsageDelta(
  ledger: ExperimentUsageLedger,
  delta: ExperimentUsageDelta,
  nowIso: string,
): ExperimentUsageLedger {
  return {
    ...ledger,
    designCalls: ledger.designCalls + (delta.designCalls ?? 0),
    modelCalls: ledger.modelCalls + (delta.modelCalls ?? 0),
    sampleCount: ledger.sampleCount + (delta.sampleCount ?? 0),
    reservedActions: Math.max(
      0,
      ledger.reservedActions + (delta.reservedActions ?? 0),
    ),
    committedActions: Math.max(
      0,
      ledger.committedActions + (delta.committedActions ?? 0),
    ),
    updatedAt: nowIso,
  };
}

export function assertWithinBudget(
  ledger: ExperimentUsageLedger,
  budget: ExperimentBudgetEnvelope,
): void {
  const actionUsage = ledger.reservedActions + ledger.committedActions;
  if (actionUsage > budget.maximumActions) {
    throw new ExperimentError(
      "EXPERIMENT_BUDGET_EXCEEDED",
      `Experiment action budget ${budget.maximumActions} exceeded`,
      {
        dimension: "maximumActions",
        used: actionUsage,
        limit: budget.maximumActions,
      },
    );
  }
  if (ledger.modelCalls + ledger.designCalls > budget.maximumModelCalls) {
    throw new ExperimentError(
      "EXPERIMENT_BUDGET_EXCEEDED",
      `Experiment model/design call budget ${budget.maximumModelCalls} exceeded`,
      {
        dimension: "maximumModelCalls",
        used: ledger.modelCalls + ledger.designCalls,
        limit: budget.maximumModelCalls,
      },
    );
  }
  if (ledger.sampleCount > budget.maximumSampleSize) {
    throw new ExperimentError(
      "EXPERIMENT_BUDGET_EXCEEDED",
      `Experiment sample budget ${budget.maximumSampleSize} exceeded`,
      {
        dimension: "maximumSampleSize",
        used: ledger.sampleCount,
        limit: budget.maximumSampleSize,
      },
    );
  }
}

/**
 * Compute sample-count delta for newly observed measurements only.
 * Replays / crash retries of the same measurementId do not double-charge.
 */
export function sampleCountDelta(input: {
  existing: readonly { measurementId: string; sampleCount: number }[];
  incoming: readonly { measurementId: string; sampleCount: number }[];
}): number {
  const prior = new Map(
    input.existing.map((m) => [m.measurementId, m.sampleCount]),
  );
  let delta = 0;
  for (const m of input.incoming) {
    const prev = prior.get(m.measurementId);
    if (prev === undefined) {
      delta += m.sampleCount;
    } else if (m.sampleCount > prev) {
      delta += m.sampleCount - prev;
    }
  }
  return delta;
}
