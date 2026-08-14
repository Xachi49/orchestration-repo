import type { EventEnvelope } from "../domain/run/event-envelope.js";

export const PROJECT_OBJECTIVE_SUBMITTED = "PROJECT_OBJECTIVE_SUBMITTED";

/**
 * In-memory event persistence only. No message queue.
 * Future durable implementations must atomically coordinate event append
 * with run persistence and idempotency binding (transaction or outbox).
 */
export interface EventStore {
  append(event: EventEnvelope): Promise<EventEnvelope>;
  listByRunId(runId: string): Promise<readonly EventEnvelope[]>;
}
