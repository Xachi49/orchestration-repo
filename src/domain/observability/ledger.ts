import { z } from "zod";

export const ObservabilityLedgerEventTypeSchema = z.enum([
  "TELEMETRY_NORMALIZED",
  "METRIC_COMPUTED",
  "SLO_EVALUATED",
  "ANOMALY_DETECTED",
  "BOTTLENECK_DETECTED",
  "OPTIMIZATION_CANDIDATE_CREATED",
  "OPTIMIZATION_CANDIDATE_REVIEWED",
  "HEALTH_SNAPSHOT_CREATED",
]);
export type ObservabilityLedgerEventType = z.infer<
  typeof ObservabilityLedgerEventTypeSchema
>;

export const ObservabilityLedgerEventSchema = z
  .object({
    eventId: z.string().min(1),
    eventType: ObservabilityLedgerEventTypeSchema,
    projectId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    snapshotId: z.string().min(1).optional(),
    payload: z.record(z.string(), z.unknown()).default({}),
    createdAt: z.string().datetime(),
  })
  .strict();
export type ObservabilityLedgerEvent = z.infer<
  typeof ObservabilityLedgerEventSchema
>;
