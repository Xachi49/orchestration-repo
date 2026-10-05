import type { EventEnvelope } from "../domain/run/event-envelope.js";

export const PROJECT_OBJECTIVE_SUBMITTED = "PROJECT_OBJECTIVE_SUBMITTED";

/**
 * A same-objective run replacement was admitted.
 * This is not PROJECT_OBJECTIVE_SUBMITTED: the objective was not resubmitted.
 */
export const PROJECT_RUN_REPLACEMENT_ADMITTED =
  "PROJECT_RUN_REPLACEMENT_ADMITTED";

/**
 * In-memory event persistence only. No message queue.
 * Future durable implementations must atomically coordinate event append
 * with run persistence and idempotency binding (transaction or outbox).
 */
export interface EventStore {
  append(event: EventEnvelope): Promise<EventEnvelope>;
  listByRunId(runId: string): Promise<readonly EventEnvelope[]>;
}
