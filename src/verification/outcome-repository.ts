import {
  parseOutcomeVerificationRecord,
  type OutcomeVerificationRecord,
} from "../domain/verification/index.js";

export interface OutcomeVerificationRepository {
  append(
    record: OutcomeVerificationRecord,
  ): Promise<OutcomeVerificationRecord>;
  getById(
    outcomeVerificationId: string,
  ): Promise<OutcomeVerificationRecord | null>;
  getLatestByRun(runId: string): Promise<OutcomeVerificationRecord | null>;
  getByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<OutcomeVerificationRecord | null>;
  listByRun(runId: string): Promise<readonly OutcomeVerificationRecord[]>;
  exists(outcomeVerificationId: string): Promise<boolean>;
}

export class InMemoryOutcomeVerificationRepository
  implements OutcomeVerificationRepository
{
  private readonly byId = new Map<string, OutcomeVerificationRecord>();
  private readonly byRun = new Map<string, string[]>();
  private readonly byAttempt = new Map<string, string>();

  async append(
    record: OutcomeVerificationRecord,
  ): Promise<OutcomeVerificationRecord> {
    const parsed = parseOutcomeVerificationRecord(record);
    if (this.byId.has(parsed.outcomeVerificationId)) {
      throw new Error(
        `Outcome verification record already exists: ${parsed.outcomeVerificationId}`,
      );
    }
    this.byId.set(parsed.outcomeVerificationId, Object.freeze(parsed));
    const runOrder = this.byRun.get(parsed.runId) ?? [];
    runOrder.push(parsed.outcomeVerificationId);
    this.byRun.set(parsed.runId, runOrder);
    this.byAttempt.set(
      parsed.executionAttemptId,
      parsed.outcomeVerificationId,
    );
    return parsed;
  }

  async getById(
    outcomeVerificationId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    return this.byId.get(outcomeVerificationId) ?? null;
  }

  async getLatestByRun(
    runId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    const ids = this.byRun.get(runId) ?? [];
    const last = ids[ids.length - 1];
    return last !== undefined ? (this.byId.get(last) ?? null) : null;
  }

  async getByExecutionAttempt(
    executionAttemptId: string,
  ): Promise<OutcomeVerificationRecord | null> {
    const id = this.byAttempt.get(executionAttemptId);
    return id !== undefined ? (this.byId.get(id) ?? null) : null;
  }

  async listByRun(
    runId: string,
  ): Promise<readonly OutcomeVerificationRecord[]> {
    const ids = this.byRun.get(runId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((r): r is OutcomeVerificationRecord => r !== undefined);
  }

  async exists(outcomeVerificationId: string): Promise<boolean> {
    return this.byId.has(outcomeVerificationId);
  }
}
