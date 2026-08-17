import { z } from "zod";

export const LearningLedgerEventTypeSchema = z.enum([
  "HISTORICAL_RUN_RECORDED",
  "LEARNING_CANDIDATE_CREATED",
  "LEARNING_CANDIDATE_REJECTED",
  "PRECEDENT_PROMOTION_REQUESTED",
  "PRECEDENT_PROMOTED",
  "PRECEDENT_SUPERSEDED",
  "PRECEDENT_RETIRED",
  "PRECEDENT_CONTRADICTION_DETECTED",
  "PRECEDENT_RETRIEVED",
  "PRECEDENT_INVALIDATED",
  "TRUST_CLASS_UPGRADED",
]);
export type LearningLedgerEventType = z.infer<
  typeof LearningLedgerEventTypeSchema
>;

export const LearningLedgerEventSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: LearningLedgerEventTypeSchema,
    runId: z.string().min(1).optional(),
    projectId: z.string().min(1).optional(),
    historicalRunRecordId: z.string().min(1).optional(),
    learningCandidateId: z.string().min(1).optional(),
    precedentId: z.string().min(1).optional(),
    contradictionId: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();

export type LearningLedgerEvent = z.infer<typeof LearningLedgerEventSchema>;

export function parseLearningLedgerEvent(input: unknown): LearningLedgerEvent {
  return LearningLedgerEventSchema.parse(input);
}
