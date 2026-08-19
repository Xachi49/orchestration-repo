import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { VerificationError } from "./errors.js";

export const VERIFICATION_OPERATION_CATEGORY = {
  OUTCOME_VERIFICATION: "OUTCOME_VERIFICATION",
} as const;

export type VerificationOperationCategory =
  (typeof VERIFICATION_OPERATION_CATEGORY)[keyof typeof VERIFICATION_OPERATION_CATEGORY];

export interface VerificationInferenceRecord {
  recordId: string;
  runId: string;
  verificationAttemptId: string;
  operationCategory: VerificationOperationCategory;
  provider: string;
  model: string;
  reservedTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  status: "RESERVED" | "SETTLED" | "RELEASED" | "AMBIGUOUS_CHARGED";
  createdAt: string;
  settledAt?: string;
}

export interface VerificationInferenceLedger {
  reserve(input: {
    recordId: string;
    runId: string;
    verificationAttemptId: string;
    provider: string;
    model: string;
    reservedTokens: number;
    nowIso: string;
  }): Promise<VerificationInferenceRecord>;
  settle(input: {
    recordId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    nowIso: string;
  }): Promise<VerificationInferenceRecord>;
  release(recordId: string, nowIso: string): Promise<VerificationInferenceRecord>;
  chargeAmbiguous(
    recordId: string,
    nowIso: string,
  ): Promise<VerificationInferenceRecord>;
  listByRun(runId: string): Promise<readonly VerificationInferenceRecord[]>;
  markDispatched?(recordId: string): Promise<void>;
}

export class InMemoryVerificationInferenceLedger
  implements VerificationInferenceLedger
{
  private readonly byId = new Map<string, VerificationInferenceRecord>();
  private readonly byRun = new Map<string, string[]>();

  async reserve(input: {
    recordId: string;
    runId: string;
    verificationAttemptId: string;
    provider: string;
    model: string;
    reservedTokens: number;
    nowIso: string;
  }): Promise<VerificationInferenceRecord> {
    const record: VerificationInferenceRecord = {
      recordId: input.recordId,
      runId: input.runId,
      verificationAttemptId: input.verificationAttemptId,
      operationCategory: "OUTCOME_VERIFICATION",
      provider: input.provider,
      model: input.model,
      reservedTokens: input.reservedTokens,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      status: "RESERVED",
      createdAt: input.nowIso,
    };
    this.byId.set(record.recordId, record);
    const order = this.byRun.get(input.runId) ?? [];
    order.push(record.recordId);
    this.byRun.set(input.runId, order);
    return record;
  }

  async settle(input: {
    recordId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    nowIso: string;
  }): Promise<VerificationInferenceRecord> {
    const existing = this.require(input.recordId);
    const next: VerificationInferenceRecord = {
      ...existing,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      status: "SETTLED",
      settledAt: input.nowIso,
    };
    this.byId.set(input.recordId, next);
    return next;
  }

  async release(
    recordId: string,
    nowIso: string,
  ): Promise<VerificationInferenceRecord> {
    const existing = this.require(recordId);
    const next: VerificationInferenceRecord = {
      ...existing,
      status: "RELEASED",
      settledAt: nowIso,
      reservedTokens: 0,
    };
    this.byId.set(recordId, next);
    return next;
  }

  async chargeAmbiguous(
    recordId: string,
    nowIso: string,
  ): Promise<VerificationInferenceRecord> {
    const existing = this.require(recordId);
    const next: VerificationInferenceRecord = {
      ...existing,
      totalTokens: existing.reservedTokens,
      status: "AMBIGUOUS_CHARGED",
      settledAt: nowIso,
    };
    this.byId.set(recordId, next);
    return next;
  }

  async listByRun(
    runId: string,
  ): Promise<readonly VerificationInferenceRecord[]> {
    const ids = this.byRun.get(runId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((r): r is VerificationInferenceRecord => r !== undefined);
  }

  private require(recordId: string): VerificationInferenceRecord {
    const existing = this.byId.get(recordId);
    if (!existing) {
      throw new VerificationError(
        "VERIFICATION_PERSISTENCE_FAILED",
        `Inference record not found: ${recordId}`,
      );
    }
    return existing;
  }
}

/**
 * Enforce verification inference against ResourceBudgetProfile ceilings.
 * Does not invent new budget capacity. Does not reuse planning/validation ledgers.
 */
export class VerificationInferenceBudget {
  constructor(private readonly ledger: VerificationInferenceLedger) {}

  async assertCanReserve(input: {
    runId: string;
    budget: ResourceBudgetProfile;
    reservedTokens: number;
  }): Promise<void> {
    const records = await this.ledger.listByRun(input.runId);
    const llmCalls = records.filter(
      (r) => r.status === "SETTLED" || r.status === "AMBIGUOUS_CHARGED",
    ).length;
    const completedTokens = records
      .filter(
        (r) => r.status === "SETTLED" || r.status === "AMBIGUOUS_CHARGED",
      )
      .reduce((sum, r) => sum + r.totalTokens, 0);
    const activeReserved = records
      .filter((r) => r.status === "RESERVED")
      .reduce((sum, r) => sum + r.reservedTokens, 0);

    if (llmCalls >= input.budget.maximumLlmCalls) {
      throw new VerificationError(
        "VERIFICATION_RESOURCE_BUDGET_EXCEEDED",
        "Verification inference LLM call budget exhausted",
        {
          dimension: "maximumLlmCalls",
          used: llmCalls,
          limit: input.budget.maximumLlmCalls,
        },
      );
    }

    const remaining =
      input.budget.maximumTotalTokens - completedTokens - activeReserved;
    if (input.reservedTokens > remaining) {
      throw new VerificationError(
        "VERIFICATION_RESOURCE_BUDGET_EXCEEDED",
        "Verification inference token reservation exceeds remaining budget",
        {
          dimension: "maximumTotalTokens",
          requiredReservation: input.reservedTokens,
          remaining,
          limit: input.budget.maximumTotalTokens,
        },
      );
    }
  }
}
