import {
  VerifiedRepositoryContextSchema,
  type VerifiedRepositoryContext,
  type VerifiedRepositoryContextStore,
} from "../../ingestion/context.js";

export class InMemoryVerifiedRepositoryContextStore
  implements VerifiedRepositoryContextStore
{
  private readonly byRun = new Map<string, VerifiedRepositoryContext>();

  async getByRunId(runId: string): Promise<VerifiedRepositoryContext | null> {
    return this.byRun.get(runId) ?? null;
  }

  async save(
    context: VerifiedRepositoryContext,
  ): Promise<VerifiedRepositoryContext> {
    const parsed = VerifiedRepositoryContextSchema.parse(context);
    this.byRun.set(parsed.runId, parsed);
    return parsed;
  }
}
