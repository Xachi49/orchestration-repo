import {
  parsePromotedPrecedent,
  type PromotedPrecedent,
  type PrecedentStatus,
} from "../domain/memory/precedent.js";
import { MemoryError } from "./errors.js";

export interface PromotedPrecedentRepository {
  append(precedent: PromotedPrecedent): Promise<PromotedPrecedent>;
  getById(id: string): Promise<PromotedPrecedent | null>;
  getLatestVersion(precedentId: string): Promise<PromotedPrecedent | null>;
  listByProject(projectId: string): Promise<readonly PromotedPrecedent[]>;
  listActiveByProject(projectId: string): Promise<readonly PromotedPrecedent[]>;
  listAllActive(): Promise<readonly PromotedPrecedent[]>;
  updateStatus(
    precedentId: string,
    version: number,
    status: PrecedentStatus,
  ): Promise<PromotedPrecedent>;
}

/**
 * Append-only precedent store. Status transitions create a new frozen record
 * keyed by precedentId+version (status metadata only; content never mutates).
 */
export class InMemoryPromotedPrecedentRepository
  implements PromotedPrecedentRepository
{
  private readonly byKey = new Map<string, PromotedPrecedent>();
  private readonly versionsById = new Map<string, number[]>();

  private key(precedentId: string, version: number): string {
    return `${precedentId}:v${version}`;
  }

  async append(precedent: PromotedPrecedent): Promise<PromotedPrecedent> {
    const parsed = parsePromotedPrecedent(precedent);
    const k = this.key(parsed.precedentId, parsed.version);
    if (this.byKey.has(k)) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Precedent version already exists: ${k}`,
      );
    }
    Object.freeze(parsed);
    this.byKey.set(k, parsed);
    const versions = this.versionsById.get(parsed.precedentId) ?? [];
    versions.push(parsed.version);
    versions.sort((a, b) => a - b);
    this.versionsById.set(parsed.precedentId, versions);
    return parsed;
  }

  async getById(id: string): Promise<PromotedPrecedent | null> {
    return this.getLatestVersion(id);
  }

  async getLatestVersion(
    precedentId: string,
  ): Promise<PromotedPrecedent | null> {
    const versions = this.versionsById.get(precedentId) ?? [];
    const latest = versions[versions.length - 1];
    if (latest === undefined) {
      return null;
    }
    return this.byKey.get(this.key(precedentId, latest)) ?? null;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly PromotedPrecedent[]> {
    const latest: PromotedPrecedent[] = [];
    for (const precedentId of this.versionsById.keys()) {
      const record = await this.getLatestVersion(precedentId);
      if (record && record.projectId === projectId) {
        latest.push(record);
      }
    }
    return latest;
  }

  async listActiveByProject(
    projectId: string,
  ): Promise<readonly PromotedPrecedent[]> {
    const all = await this.listByProject(projectId);
    return all.filter((p) => p.status === "ACTIVE");
  }

  async listAllActive(): Promise<readonly PromotedPrecedent[]> {
    const latest: PromotedPrecedent[] = [];
    for (const precedentId of this.versionsById.keys()) {
      const record = await this.getLatestVersion(precedentId);
      if (record && record.status === "ACTIVE") {
        latest.push(record);
      }
    }
    return latest;
  }

  async updateStatus(
    precedentId: string,
    version: number,
    status: PrecedentStatus,
  ): Promise<PromotedPrecedent> {
    const k = this.key(precedentId, version);
    const existing = this.byKey.get(k);
    if (!existing) {
      throw new MemoryError(
        "PRECEDENT_NOT_FOUND",
        `Precedent not found: ${k}`,
      );
    }
    // Status-only transition preserves content hash identity of the version.
    const next = parsePromotedPrecedent({ ...existing, status });
    Object.freeze(next);
    this.byKey.set(k, next);
    return next;
  }
}
