/**
 * Narrowly-scoped delivery secret persistence.
 * Plaintext approval nonces must never appear in general outbox payloads.
 */
export interface ApprovalDeliverySecretStore {
  storePending(approvalRequestId: string, plaintextNonce: string): Promise<void>;
  revealPending(approvalRequestId: string): Promise<string | null>;
  markDelivered(approvalRequestId: string): Promise<void>;
  invalidate(approvalRequestId: string): Promise<void>;
}

export interface DeliverySecretProtector {
  encrypt(plaintext: string): {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  };
  decrypt(input: {
    ciphertext: Buffer;
    iv: Buffer;
    tag: Buffer;
  }): string;
}
