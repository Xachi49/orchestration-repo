import {
  parseLearningCandidate,
  type LearningCandidate,
  type LearningCandidateStatus,
} from "../domain/memory/candidate.js";
import { MemoryError } from "./errors.js";

export interface LearningCandidateRepository {
  append(candidate: LearningCandidate): Promise<LearningCandidate>;
  getById(id: string): Promise<LearningCandidate | null>;
  getByHash(candidateHash: string): Promise<LearningCandidate | null>;
  listByRunRecord(
    historicalRunRecordId: string,
  ): Promise<readonly LearningCandidate[]>;
  listByProject(projectId: string): Promise<readonly LearningCandidate[]>;
  updateStatus(
    id: string,
    status: LearningCandidateStatus,
  ): Promise<LearningCandidate>;
}

export class InMemoryLearningCandidateRepository
  implements LearningCandidateRepository
{
  private readonly byId = new Map<string, LearningCandidate>();
  private readonly byHash = new Map<string, string>();
  private readonly byRunRecord = new Map<string, string[]>();

  async append(candidate: LearningCandidate): Promise<LearningCandidate> {
    const parsed = parseLearningCandidate(candidate);
    const existingByHash = this.byHash.get(parsed.candidateHash);
    if (existingByHash) {
      return this.byId.get(existingByHash)!;
    }
    if (this.byId.has(parsed.learningCandidateId)) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Candidate already exists: ${parsed.learningCandidateId}`,
      );
    }
    Object.freeze(parsed);
    this.byId.set(parsed.learningCandidateId, parsed);
    this.byHash.set(parsed.candidateHash, parsed.learningCandidateId);
    const order = this.byRunRecord.get(parsed.sourceHistoricalRunRecordId) ?? [];
    order.push(parsed.learningCandidateId);
    this.byRunRecord.set(parsed.sourceHistoricalRunRecordId, order);
    return parsed;
  }

  async getById(id: string): Promise<LearningCandidate | null> {
    return this.byId.get(id) ?? null;
  }

  async getByHash(candidateHash: string): Promise<LearningCandidate | null> {
    const id = this.byHash.get(candidateHash);
    return id !== undefined ? (this.byId.get(id) ?? null) : null;
  }

  async listByRunRecord(
    historicalRunRecordId: string,
  ): Promise<readonly LearningCandidate[]> {
    const ids = this.byRunRecord.get(historicalRunRecordId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((c): c is LearningCandidate => c !== undefined);
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly LearningCandidate[]> {
    return [...this.byId.values()].filter((c) => c.projectId === projectId);
  }

  async updateStatus(
    id: string,
    status: LearningCandidateStatus,
  ): Promise<LearningCandidate> {
    const existing = this.byId.get(id);
    if (!existing) {
      throw new MemoryError("CANDIDATE_NOT_FOUND", `Candidate not found: ${id}`);
    }
    const next = parseLearningCandidate({ ...existing, status });
    Object.freeze(next);
    this.byId.set(id, next);
    return next;
  }
}
