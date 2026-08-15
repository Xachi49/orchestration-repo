import {
  parseExecutionArtifact,
  type ExecutionArtifact,
} from "../domain/execution/index.js";

export interface ExecutionArtifactRepository {
  save(artifact: ExecutionArtifact): Promise<ExecutionArtifact>;
  getById(artifactId: string): Promise<ExecutionArtifact | null>;
  listByRun(runId: string): Promise<readonly ExecutionArtifact[]>;
  listByAttempt(
    executionAttemptId: string,
  ): Promise<readonly ExecutionArtifact[]>;
}

export class InMemoryExecutionArtifactRepository
  implements ExecutionArtifactRepository
{
  private readonly byId = new Map<string, ExecutionArtifact>();
  private readonly byRun = new Map<string, string[]>();
  private readonly byAttempt = new Map<string, string[]>();

  async save(artifact: ExecutionArtifact): Promise<ExecutionArtifact> {
    const parsed = parseExecutionArtifact(artifact);
    this.byId.set(parsed.artifactId, parsed);
    const runOrder = this.byRun.get(parsed.runId) ?? [];
    if (!runOrder.includes(parsed.artifactId)) {
      runOrder.push(parsed.artifactId);
      this.byRun.set(parsed.runId, runOrder);
    }
    const attemptOrder = this.byAttempt.get(parsed.executionAttemptId) ?? [];
    if (!attemptOrder.includes(parsed.artifactId)) {
      attemptOrder.push(parsed.artifactId);
      this.byAttempt.set(parsed.executionAttemptId, attemptOrder);
    }
    return parsed;
  }

  async getById(artifactId: string): Promise<ExecutionArtifact | null> {
    return this.byId.get(artifactId) ?? null;
  }

  async listByRun(runId: string): Promise<readonly ExecutionArtifact[]> {
    const ids = this.byRun.get(runId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((a): a is ExecutionArtifact => a !== undefined);
  }

  async listByAttempt(
    executionAttemptId: string,
  ): Promise<readonly ExecutionArtifact[]> {
    const ids = this.byAttempt.get(executionAttemptId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((a): a is ExecutionArtifact => a !== undefined);
  }
}
