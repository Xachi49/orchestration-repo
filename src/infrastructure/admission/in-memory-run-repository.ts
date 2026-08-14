import {
  RunRecordSchema,
  type RunRecord,
  type RunRepository,
} from "../../admission/run-repository.js";

export class InMemoryRunRepository implements RunRepository {
  private readonly runs = new Map<string, RunRecord>();
  failNextCreate = false;

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
}
