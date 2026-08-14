import { z } from "zod";
import { ObjectiveVersionSchema } from "../objective/objective.js";

/**
 * Envelope for all control-plane / run-lifecycle events.
 * `data` remains untrusted until validated against a typed schema for eventType.
 */
export const EventEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    eventVersion: z.string().min(1),
    runId: z.string().min(1),
    correlationId: z.string().min(1),
    causationId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    traceId: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    schemaVersion: z.string().min(1),
    data: z.unknown(),
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function parseEventEnvelope(input: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(input);
}
