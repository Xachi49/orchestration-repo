import {
  parseApprovalDecisionCard,
  type ApprovalDecisionCard,
} from "../domain/authorization/index.js";
import { AuthorizationError } from "./errors.js";

export interface DecisionCardStore {
  save(
    approvalRequestId: string,
    card: ApprovalDecisionCard,
  ): Promise<ApprovalDecisionCard>;
  get(approvalRequestId: string): Promise<ApprovalDecisionCard | null>;
}

export class InMemoryDecisionCardStore implements DecisionCardStore {
  private readonly byRequest = new Map<string, ApprovalDecisionCard>();

  async save(
    approvalRequestId: string,
    card: ApprovalDecisionCard,
  ): Promise<ApprovalDecisionCard> {
    const parsed = parseApprovalDecisionCard(card);
    this.byRequest.set(approvalRequestId, parsed);
    return parsed;
  }

  async get(approvalRequestId: string): Promise<ApprovalDecisionCard | null> {
    return this.byRequest.get(approvalRequestId) ?? null;
  }
}

export function requireDecisionCard(
  store: DecisionCardStore,
  approvalRequestId: string,
): Promise<ApprovalDecisionCard> {
  return store.get(approvalRequestId).then((card) => {
    if (!card) {
      throw new AuthorizationError(
        "DECISION_CARD_HASH_MISMATCH",
        `No decision card stored for ${approvalRequestId}`,
      );
    }
    return card;
  });
}
