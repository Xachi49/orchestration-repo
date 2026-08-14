import { parseEventEnvelope, type EventEnvelope } from "../../domain/run/event-envelope.js";
import type { EventStore } from "../../admission/event-store.js";

export class InMemoryEventStore implements EventStore {
  private readonly events: EventEnvelope[] = [];
  failNextAppend = false;

  async append(event: EventEnvelope): Promise<EventEnvelope> {
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new Error("simulated event append failure");
    }
    const parsed = parseEventEnvelope(event);
    this.events.push(parsed);
    return parsed;
  }

  async listByRunId(runId: string): Promise<readonly EventEnvelope[]> {
    return this.events.filter((event) => event.runId === runId);
  }
}
