import { z } from "zod";

export const MetricWindowKindSchema = z.enum([
  "LAST_N_RUNS",
  "TIME_RANGE",
  "PROJECT_LIFETIME",
]);
export type MetricWindowKind = z.infer<typeof MetricWindowKindSchema>;

export const MetricWindowSchema = z
  .object({
    projectId: z.string().min(1),
    kind: MetricWindowKindSchema,
    /** Terminal runs included in this window (sorted). */
    includedRunIds: z.array(z.string()).default([]),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
    lastN: z.number().int().positive().optional(),
    windowFingerprint: z.string().min(1),
  })
  .strict();
export type MetricWindow = z.infer<typeof MetricWindowSchema>;

export const TelemetryFingerprintSchema = z
  .object({
    projectId: z.string().min(1),
    includedRunIds: z.array(z.string()),
    sourceRecordHashes: z.array(z.string()).default([]),
    calculationVersions: z.array(z.string()).default([]),
    fingerprint: z.string().min(1),
  })
  .strict();
export type TelemetryFingerprint = z.infer<typeof TelemetryFingerprintSchema>;
