import {
  parsePrecedentContradictionRecord,
  type PrecedentContradictionRecord,
  type ContradictionResolutionStatus,
} from "../domain/memory/contradiction.js";
import { MemoryError } from "./errors.js";

export interface PrecedentContradictionRepository {
  append(
    record: PrecedentContradictionRecord,
  ): Promise<PrecedentContradictionRecord>;
  getById(id: string): Promise<PrecedentContradictionRecord | null>;
  listOpen(): Promise<readonly PrecedentContradictionRecord[]>;
  listForPrecedent(
    precedentId: string,
  ): Promise<readonly PrecedentContradictionRecord[]>;
  listForCandidate(
    candidateId: string,
  ): Promise<readonly PrecedentContradictionRecord[]>;
  updateResolution(
    id: string,
    status: ContradictionResolutionStatus,
  ): Promise<PrecedentContradictionRecord>;
}

export class InMemoryPrecedentContradictionRepository
  implements PrecedentContradictionRepository
{
  private readonly byId = new Map<string, PrecedentContradictionRecord>();

  async append(
    record: PrecedentContradictionRecord,
  ): Promise<PrecedentContradictionRecord> {
    const parsed = parsePrecedentContradictionRecord(record);
    if (this.byId.has(parsed.contradictionId)) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Contradiction already exists: ${parsed.contradictionId}`,
      );
    }
    Object.freeze(parsed);
    this.byId.set(parsed.contradictionId, parsed);
    return parsed;
  }

  async getById(id: string): Promise<PrecedentContradictionRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async listOpen(): Promise<readonly PrecedentContradictionRecord[]> {
    return [...this.byId.values()].filter(
      (r) => r.resolutionStatus === "OPEN",
    );
  }

  async listForPrecedent(
    precedentId: string,
  ): Promise<readonly PrecedentContradictionRecord[]> {
    return [...this.byId.values()].filter((r) =>
      r.precedentIds.includes(precedentId),
    );
  }

  async listForCandidate(
    candidateId: string,
  ): Promise<readonly PrecedentContradictionRecord[]> {
    return [...this.byId.values()].filter((r) =>
      r.candidateIds.includes(candidateId),
    );
  }

  async updateResolution(
    id: string,
    status: ContradictionResolutionStatus,
  ): Promise<PrecedentContradictionRecord> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Contradiction not found: ${id}`,
      );
    }
    const next = parsePrecedentContradictionRecord({
      ...existing,
      resolutionStatus: status,
    });
    Object.freeze(next);
    this.byId.set(id, next);
    return next;
  }
}
