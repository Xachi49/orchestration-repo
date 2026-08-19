import {
  RunRecordSchema,
  withRunState,
  type RunRecord,
  type RunRepository,
} from "../../admission/run-repository.js";
import type { RunState } from "../../domain/run/run-state.js";

export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, RunRecord>();
  failNextCreate = false;
  failNextTransition = false;

  async create(record: RunRecord): Promise<RunRecord> {
    if (this.failNextCreate) {
      this.failNextCreate = false;
      throw new Error("simulated run creation failure");
    }
    const parsed = RunRecordSchema.parse(record);
    if (this.runs.has(parsed.runId)) {
      throw new Error(`Run already exists: ${parsed.runId}`);
    }
    this.runs.set(parsed.runId, Object.freeze(parsed));
    return parsed;
  }

  async getById(runId: string): Promise<RunRecord | null> {
    return this.runs.get(runId) ?? null;
  }

  async exists(runId: string): Promise<boolean> {
    return this.runs.has(runId);
  }

  async save(record: RunRecord): Promise<RunRecord> {
    const parsed = RunRecordSchema.parse(record);
    if (!this.runs.has(parsed.runId)) {
      throw new Error(`Run does not exist: ${parsed.runId}`);
    }
    this.runs.set(parsed.runId, Object.freeze(parsed));
    return parsed;
  }

  async listByProject(projectId: string): Promise<readonly RunRecord[]> {
    return [...this.runs.values()].filter(
      (record) => record.projectId === projectId,
    );
  }

  async transition(
    runId: string,
    expected: RunState,
    expectedRecordRevision: number,
    next: RunState,
    updatedAt: string,
    extras: { admittedAt?: string; failureReasonCode?: string } = {},
  ): Promise<RunRecord> {
    if (this.failNextTransition) {
      this.failNextTransition = false;
      throw new Error("simulated run transition failure");
    }
    const current = this.runs.get(runId);
    if (
      !current ||
      current.state !== expected ||
      current.recordRevision !== expectedRecordRevision
    ) {
      throw new Error(
        `Run CAS failed for ${runId}: expected ${expected}@${expectedRecordRevision}, was ${current?.state}@${current?.recordRevision}`,
      );
    }
    const updated = withRunState(current, next, updatedAt, extras);
    const nextRecord = RunRecordSchema.parse({
      ...updated,
      recordRevision: current.recordRevision + 1,
    });
    return this.save(nextRecord);
  }
}
