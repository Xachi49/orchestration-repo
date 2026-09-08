/**
 * Transport-neutral federation delivery boundary.
 * Delivery != authority. Consumers must revalidate authoritative state.
 */

export interface FederationTransportMessage {
  messageId: string;
  messageType: string;
  federationId: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface FederationTransport {
  enqueue(message: FederationTransportMessage): Promise<void>;
  /** Idempotent durable consumption — exactly-once delivery is not assumed. */
  consume(
    handler: (message: FederationTransportMessage) => Promise<void>,
  ): Promise<void>;
}

/** Deterministic in-process adapter for unit tests. */
export class InProcessFederationTransport implements FederationTransport {
  readonly messages: FederationTransportMessage[] = [];
  private readonly consumed = new Set<string>();

  async enqueue(message: FederationTransportMessage): Promise<void> {
    this.messages.push(message);
  }

  async consume(
    handler: (message: FederationTransportMessage) => Promise<void>,
  ): Promise<void> {
    for (const message of this.messages) {
      if (this.consumed.has(message.messageId)) continue;
      await handler(message);
      this.consumed.add(message.messageId);
    }
  }
}
