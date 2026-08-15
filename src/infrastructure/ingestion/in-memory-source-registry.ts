import { parseRepositorySource, type RepositorySource } from "../../ingestion/repository-source.js";
import type { RepositorySourceRegistry } from "../../ingestion/repository-source.js";

export class InMemoryRepositorySourceRegistry implements RepositorySourceRegistry {
  private readonly sources: ReadonlyMap<string, RepositorySource>;

  constructor(seed: readonly RepositorySource[] = []) {
    const map = new Map<string, RepositorySource>();
    for (const item of seed) {
      const source = parseRepositorySource(item);
      if (map.has(source.projectId)) {
        throw new Error(`Duplicate repository source for ${source.projectId}`);
      }
      map.set(source.projectId, Object.freeze(source));
    }
    this.sources = map;
  }

  async getByProjectId(projectId: string): Promise<RepositorySource | null> {
    return this.sources.get(projectId) ?? null;
  }

  async exists(projectId: string): Promise<boolean> {
    return this.sources.has(projectId);
  }

  async list(): Promise<readonly RepositorySource[]> {
    return [...this.sources.values()];
  }
}
