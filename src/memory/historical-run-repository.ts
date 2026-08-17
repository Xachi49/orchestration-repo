import {
  parseHistoricalRunRecord,
  type HistoricalRunRecord,
} from "../domain/memory/historical-run.js";
import { MemoryError } from "./errors.js";

export interface HistoricalRunRepository {
  append(record: HistoricalRunRecord): Promise<HistoricalRunRecord>;
  getById(id: string): Promise<HistoricalRunRecord | null>;
  getByRunId(runId: string): Promise<HistoricalRunRecord | null>;
  getByOutcomeIdentity(input: {
    runId: string;
    outcome: string;
    outcomeVerificationId?: string;
  }): Promise<HistoricalRunRecord | null>;
  listByProject(projectId: string): Promise<readonly HistoricalRunRecord[]>;
}

export class InMemoryHistoricalRunRepository
  implements HistoricalRunRepository
{
  private readonly byId = new Map<string, HistoricalRunRecord>();
  private readonly byRun = new Map<string, string>();
  private readonly byOutcomeKey = new Map<string, string>();

  private outcomeKey(input: {
    runId: string;
    outcome: string;
    outcomeVerificationId?: string;
  }): string {
    return [
      input.runId,
      input.outcome,
      input.outcomeVerificationId ?? "",
    ].join(":");
  }

  async append(record: HistoricalRunRecord): Promise<HistoricalRunRecord> {
    const parsed = parseHistoricalRunRecord(record);
    if (this.byId.has(parsed.historicalRunRecordId)) {
      throw new MemoryError(
        "HISTORICAL_RUN_CONFLICT",
        `Historical run record already exists: ${parsed.historicalRunRecordId}`,
      );
    }
    const key = this.outcomeKey({
      runId: parsed.runId,
      outcome: parsed.outcome,
      ...(parsed.outcomeVerificationId !== undefined
        ? { outcomeVerificationId: parsed.outcomeVerificationId }
        : {}),
    });
    const existingId = this.byOutcomeKey.get(key);
    if (existingId) {
      const existing = this.byId.get(existingId)!;
      return existing;
    }
    Object.freeze(parsed);
    this.byId.set(parsed.historicalRunRecordId, parsed);
    this.byRun.set(parsed.runId, parsed.historicalRunRecordId);
    this.byOutcomeKey.set(key, parsed.historicalRunRecordId);
    return parsed;
  }

  async getById(id: string): Promise<HistoricalRunRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async getByRunId(runId: string): Promise<HistoricalRunRecord | null> {
    const id = this.byRun.get(runId);
    return id !== undefined ? (this.byId.get(id) ?? null) : null;
  }

  async getByOutcomeIdentity(input: {
    runId: string;
    outcome: string;
    outcomeVerificationId?: string;
  }): Promise<HistoricalRunRecord | null> {
    const id = this.byOutcomeKey.get(this.outcomeKey(input));
    return id !== undefined ? (this.byId.get(id) ?? null) : null;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly HistoricalRunRecord[]> {
    return [...this.byId.values()].filter((r) => r.projectId === projectId);
  }
}
