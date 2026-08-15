import { randomBytes } from "node:crypto";
import { hashDecisionNonce } from "./decision-card-hasher.js";

/**
 * System-issued decision nonce for replay protection.
 * Callers must never invent the nonce; they present the nonce delivered
 * through the trusted approval surface.
 */
export interface DecisionNonceGenerator {
  generate(): string;
}

/** Cryptographically strong nonce for production / default stacks. */
export class CryptoDecisionNonceGenerator implements DecisionNonceGenerator {
  generate(): string {
    return randomBytes(32).toString("base64url");
  }
}

/** Deterministic nonce sequence for tests. */
export class SequenceDecisionNonceGenerator implements DecisionNonceGenerator {
  private counter = 0;

  generate(): string {
    this.counter += 1;
    return `test-decision-nonce-${this.counter}`;
  }
}

export function issueDecisionNonce(generator: DecisionNonceGenerator): {
  plaintext: string;
  nonceHash: string;
} {
  const plaintext = generator.generate();
  return {
    plaintext,
    nonceHash: hashDecisionNonce(plaintext),
  };
}
