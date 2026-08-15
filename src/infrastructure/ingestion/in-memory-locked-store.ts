import {
  LockedRepositoryStateSchema,
  type LockedRepositoryState,
  type LockedRepositoryStore,
} from "../../ingestion/locked-state.js";

export class InMemoryLockedRepositoryStore implements LockedRepositoryStore {
  private readonly byRun = new Map<string, LockedRepositoryState>();

  async getByRunId(runId: string): Promise<LockedRepositoryState | null> {
    return this.byRun.get(runId) ?? null;
  }

  async save(state: LockedRepositoryState): Promise<LockedRepositoryState> {
    const parsed = LockedRepositoryStateSchema.parse(state);
    this.byRun.set(parsed.runId, parsed);
    return parsed;
  }
}
