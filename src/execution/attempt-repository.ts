import {
  parseExecutionAttempt,
  type ExecutionAttempt,
} from "../domain/execution/index.js";

export interface ExecutionAttemptRepository {
  save(attempt: ExecutionAttempt): Promise<ExecutionAttempt>;
  getById(executionAttemptId: string): Promise<ExecutionAttempt | null>;
  listByRun(runId: string): Promise<readonly ExecutionAttempt[]>;
  getLatestByRun(runId: string): Promise<ExecutionAttempt | null>;
}

export class InMemoryExecutionAttemptRepository
  implements ExecutionAttemptRepository
{
  private readonly byId = new Map<string, ExecutionAttempt>();
  private readonly byRun = new Map<string, string[]>();

  async save(attempt: ExecutionAttempt): Promise<ExecutionAttempt> {
    const parsed = parseExecutionAttempt(attempt);
    this.byId.set(parsed.executionAttemptId, parsed);
    const order = this.byRun.get(parsed.runId) ?? [];
    if (!order.includes(parsed.executionAttemptId)) {
      order.push(parsed.executionAttemptId);
      this.byRun.set(parsed.runId, order);
    }
    return parsed;
  }

  async getById(executionAttemptId: string): Promise<ExecutionAttempt | null> {
    return this.byId.get(executionAttemptId) ?? null;
  }

  async listByRun(runId: string): Promise<readonly ExecutionAttempt[]> {
    const ids = this.byRun.get(runId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((a): a is ExecutionAttempt => a !== undefined);
  }

  async getLatestByRun(runId: string): Promise<ExecutionAttempt | null> {
    const list = await this.listByRun(runId);
    return list[list.length - 1] ?? null;
  }
}
