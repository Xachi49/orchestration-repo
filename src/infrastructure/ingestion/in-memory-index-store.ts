import {
  ProjectIndexSchema,
  repositoryIndexCacheKeyString,
  type ProjectIndex,
  type RepositoryIndexCacheKey,
  type RepositoryIndexStore,
} from "../../ingestion/index-model.js";

/**
 * In-memory index cache keyed by:
 * repositoryIdentity + commitSha + indexVersion + indexConfigurationFingerprint
 *
 * Not distributed. Future durable stores must use the same composite identity
 * with atomic compare-and-set semantics where needed.
 */
export class InMemoryRepositoryIndexStore implements RepositoryIndexStore {
  private readonly byKey = new Map<string, ProjectIndex>();

  async get(key: RepositoryIndexCacheKey): Promise<ProjectIndex | null> {
    return this.byKey.get(repositoryIndexCacheKeyString(key)) ?? null;
  }

  async save(index: ProjectIndex): Promise<ProjectIndex> {
    const parsed = ProjectIndexSchema.parse(index);
    this.byKey.set(
      repositoryIndexCacheKeyString({
        repositoryIdentity: parsed.repositoryIdentity,
        commitSha: parsed.commitSha,
        indexVersion: parsed.indexVersion,
        indexConfigurationFingerprint: parsed.indexConfigurationFingerprint,
      }),
      parsed,
    );
    return parsed;
  }

  async exists(key: RepositoryIndexCacheKey): Promise<boolean> {
    return this.byKey.has(repositoryIndexCacheKeyString(key));
  }
}
