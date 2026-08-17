import type { ResourceBudgetProfile } from "../control-plane/budgets/budget.js";
import { MemoryError } from "./errors.js";

export const LEARNING_OPERATION_CATEGORY = {
  CANDIDATE_EXTRACTION: "CANDIDATE_EXTRACTION",
} as const;

export type LearningOperationCategory =
  (typeof LEARNING_OPERATION_CATEGORY)[keyof typeof LEARNING_OPERATION_CATEGORY];

export interface LearningInferenceRecord {
  recordId: string;
  runId: string;
  historicalRunRecordId: string;
  operationCategory: LearningOperationCategory;
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

export interface LearningInferenceLedger {
  reserve(input: {
    recordId: string;
    runId: string;
    historicalRunRecordId: string;
    provider: string;
    model: string;
    reservedTokens: number;
    nowIso: string;
  }): Promise<LearningInferenceRecord>;
  settle(input: {
    recordId: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    nowIso: string;
  }): Promise<LearningInferenceRecord>;
  release(recordId: string, nowIso: string): Promise<LearningInferenceRecord>;
  listByRun(runId: string): Promise<readonly LearningInferenceRecord[]>;
}

export class InMemoryLearningInferenceLedger
  implements LearningInferenceLedger
{
  private readonly byId = new Map<string, LearningInferenceRecord>();
  private readonly byRun = new Map<string, string[]>();

  async reserve(input: {
    recordId: string;
    runId: string;
    historicalRunRecordId: string;
    provider: string;
    model: string;
    reservedTokens: number;
    nowIso: string;
  }): Promise<LearningInferenceRecord> {
    const record: LearningInferenceRecord = {
      recordId: input.recordId,
      runId: input.runId,
      historicalRunRecordId: input.historicalRunRecordId,
      operationCategory: "CANDIDATE_EXTRACTION",
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
  }): Promise<LearningInferenceRecord> {
    const existing = this.require(input.recordId);
    const next: LearningInferenceRecord = {
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
  ): Promise<LearningInferenceRecord> {
    const existing = this.require(recordId);
    const next: LearningInferenceRecord = {
      ...existing,
      status: "RELEASED",
      settledAt: nowIso,
    };
    this.byId.set(recordId, next);
    return next;
  }

  async listByRun(runId: string): Promise<readonly LearningInferenceRecord[]> {
    const ids = this.byRun.get(runId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((r): r is LearningInferenceRecord => r !== undefined);
  }

  private require(recordId: string): LearningInferenceRecord {
    const existing = this.byId.get(recordId);
    if (!existing) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Learning inference record not found: ${recordId}`,
      );
    }
    return existing;
  }
}

export class LearningInferenceBudget {
  constructor(private readonly ledger: LearningInferenceLedger) {}

  async assertCanReserve(input: {
    runId: string;
    budget: ResourceBudgetProfile;
    reservedTokens: number;
  }): Promise<void> {
    const prior = await this.ledger.listByRun(input.runId);
    const usedCalls = prior.filter(
      (r) => r.status === "SETTLED" || r.status === "RESERVED",
    ).length;
    const usedTokens = prior
      .filter((r) => r.status === "SETTLED")
      .reduce((sum, r) => sum + r.totalTokens, 0);
    if (usedCalls + 1 > input.budget.maximumLlmCalls) {
      throw new MemoryError(
        "LEARNING_RESOURCE_BUDGET_EXCEEDED",
        "Learning model call budget exceeded",
        { runId: input.runId },
      );
    }
    if (usedTokens + input.reservedTokens > input.budget.maximumTotalTokens) {
      throw new MemoryError(
        "LEARNING_RESOURCE_BUDGET_EXCEEDED",
        "Learning token budget exceeded",
        { runId: input.runId },
      );
    }
  }
}
