import { createHash } from "node:crypto";
import {
  parseApprovalDecisionCard,
  type ApprovalDecisionCard,
} from "../domain/authorization/index.js";
import { canonicalizeValue } from "../domain/plan/plan-hasher.js";

/**
 * Hashes authoritative decision-card content only (not display formatting).
 * Human authorization binds to this hash.
 */
export interface DecisionCardHasher {
  hash(card: ApprovalDecisionCard): string;
  canonicalize(card: ApprovalDecisionCard): string;
}

export class Sha256DecisionCardHasher implements DecisionCardHasher {
  canonicalize(card: ApprovalDecisionCard): string {
    const parsed = parseApprovalDecisionCard(card);
    return JSON.stringify(canonicalizeValue(parsed));
  }

  hash(card: ApprovalDecisionCard): string {
    return createHash("sha256")
      .update(this.canonicalize(card), "utf8")
      .digest("hex");
  }
}

export function hashDecisionNonce(nonce: string): string {
  return createHash("sha256").update(nonce, "utf8").digest("hex");
}
