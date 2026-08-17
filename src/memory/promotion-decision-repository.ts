import {
  parsePrecedentPromotionDecision,
  type PrecedentPromotionDecision,
} from "../domain/memory/promotion.js";
import { MemoryError } from "./errors.js";

export interface PrecedentPromotionDecisionRepository {
  append(
    decision: PrecedentPromotionDecision,
  ): Promise<PrecedentPromotionDecision>;
  getById(id: string): Promise<PrecedentPromotionDecision | null>;
  listByCandidate(
    learningCandidateId: string,
  ): Promise<readonly PrecedentPromotionDecision[]>;
}

export class InMemoryPrecedentPromotionDecisionRepository
  implements PrecedentPromotionDecisionRepository
{
  private readonly byId = new Map<string, PrecedentPromotionDecision>();
  private readonly byCandidate = new Map<string, string[]>();

  async append(
    decision: PrecedentPromotionDecision,
  ): Promise<PrecedentPromotionDecision> {
    const parsed = parsePrecedentPromotionDecision(decision);
    if (this.byId.has(parsed.promotionDecisionId)) {
      throw new MemoryError(
        "LEARNING_PERSISTENCE_FAILED",
        `Promotion decision already exists: ${parsed.promotionDecisionId}`,
      );
    }
    Object.freeze(parsed);
    this.byId.set(parsed.promotionDecisionId, parsed);
    const order = this.byCandidate.get(parsed.learningCandidateId) ?? [];
    order.push(parsed.promotionDecisionId);
    this.byCandidate.set(parsed.learningCandidateId, order);
    return parsed;
  }

  async getById(id: string): Promise<PrecedentPromotionDecision | null> {
    return this.byId.get(id) ?? null;
  }

  async listByCandidate(
    learningCandidateId: string,
  ): Promise<readonly PrecedentPromotionDecision[]> {
    const ids = this.byCandidate.get(learningCandidateId) ?? [];
    return ids
      .map((id) => this.byId.get(id))
      .filter((d): d is PrecedentPromotionDecision => d !== undefined);
  }
}
