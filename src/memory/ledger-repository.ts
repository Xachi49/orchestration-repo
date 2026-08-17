import {
  parseLearningLedgerEvent,
  type LearningLedgerEvent,
} from "../domain/memory/ledger.js";

export interface LearningLedgerRepository {
  append(event: LearningLedgerEvent): Promise<LearningLedgerEvent>;
  listByRun(runId: string): Promise<readonly LearningLedgerEvent[]>;
  listByProject(projectId: string): Promise<readonly LearningLedgerEvent[]>;
  listAll(): Promise<readonly LearningLedgerEvent[]>;
}

/** Append-only learning ledger. Historical events are never edited. */
export class InMemoryLearningLedgerRepository
  implements LearningLedgerRepository
{
  private readonly events: LearningLedgerEvent[] = [];

  async append(event: LearningLedgerEvent): Promise<LearningLedgerEvent> {
    const parsed = parseLearningLedgerEvent(event);
    Object.freeze(parsed);
    this.events.push(parsed);
    return parsed;
  }

  async listByRun(runId: string): Promise<readonly LearningLedgerEvent[]> {
    return this.events.filter((e) => e.runId === runId);
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly LearningLedgerEvent[]> {
    return this.events.filter((e) => e.projectId === projectId);
  }

  async listAll(): Promise<readonly LearningLedgerEvent[]> {
    return [...this.events];
  }
}
