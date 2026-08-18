import { z } from "zod";
import {
  MeasurementQualitySchema,
  MeasurementCoverageSchema,
} from "./quality.js";

export const MetricProvenanceSchema = z
  .object({
    metricId: z.string().min(1),
    metricName: z.string().min(1),
    calculationVersion: z.string().min(1),
    windowFingerprint: z.string().min(1),
    sourceRunIds: z.array(z.string()).default([]),
    sourceTelemetryIds: z.array(z.string()).default([]),
    sourceRecordRefs: z.array(z.string()).default([]),
    sampleSize: z.number().int().nonnegative(),
    numerator: z.number().nonnegative().optional(),
    denominator: z.number().nonnegative().optional(),
    measurementQuality: MeasurementQualitySchema,
    coverage: MeasurementCoverageSchema,
    trustClass: z.enum([
      "AUTHORITATIVE_DERIVED",
      "BEST_EFFORT_DERIVED",
      "MODEL_INTERPRETED",
    ]),
    metricHash: z.string().min(1),
  })
  .strict();
export type MetricProvenance = z.infer<typeof MetricProvenanceSchema>;

export const ReliabilityMetricSchema = z
  .object({
    metricName: z.string().min(1),
    numerator: z.number().nonnegative(),
    denominator: z.number().nonnegative(),
    rate: z.number().min(0).max(1).optional(),
    insufficientSample: z.boolean().default(false),
    provenance: MetricProvenanceSchema,
  })
  .strict();
export type ReliabilityMetric = z.infer<typeof ReliabilityMetricSchema>;

export const LatencyStatsSchema = z
  .object({
    count: z.number().int().nonnegative(),
    minMs: z.number().int().nonnegative().optional(),
    maxMs: z.number().int().nonnegative().optional(),
    meanMs: z.number().nonnegative().optional(),
    medianMs: z.number().nonnegative().optional(),
    p95Ms: z.number().nonnegative().optional(),
    insufficientSample: z.boolean().default(false),
  })
  .strict();
export type LatencyStats = z.infer<typeof LatencyStatsSchema>;

export const LatencyMetricSchema = z
  .object({
    metricName: z.string().min(1),
    phase: z.string().optional(),
    stats: LatencyStatsSchema,
    provenance: MetricProvenanceSchema,
  })
  .strict();
export type LatencyMetric = z.infer<typeof LatencyMetricSchema>;

export const ResourceAttributionRecordSchema = z
  .object({
    attributionId: z.string().min(1),
    projectId: z.string().min(1),
    windowFingerprint: z.string().min(1),
    category: z.enum([
      "PLANNING",
      "VALIDATION",
      "SEMANTIC_REVISION",
      "VERIFICATION",
      "LEARNING",
      "EXECUTION",
    ]),
    modelCallCount: z.number().int().nonnegative().default(0),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0),
    executionMinutes: z.number().nonnegative().default(0),
    testRuns: z.number().int().nonnegative().default(0),
    artifactBytes: z.number().int().nonnegative().default(0),
    apiCallCount: z.number().int().nonnegative().default(0),
    approvalWaitMs: z.number().int().nonnegative().default(0),
    rollbackCount: z.number().int().nonnegative().default(0),
    sourceRunIds: z.array(z.string()).default([]),
    measurementQuality: MeasurementQualitySchema.default("UNKNOWN"),
    usageCompleteness: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]).default("UNKNOWN"),
    coverage: MeasurementCoverageSchema.optional(),
    attributionHash: z.string().min(1),
  })
  .strict();
export type ResourceAttributionRecord = z.infer<
  typeof ResourceAttributionRecordSchema
>;

/** Future-ready; monetary fields absent until pricing authority exists. */
export const CostAttributionSchema = z
  .object({
    attributionId: z.string().min(1),
    monetaryCost: z.literal("UNKNOWN"),
    note: z.string().default("Token/resource usage only; no pricing authority"),
  })
  .strict();
export type CostAttribution = z.infer<typeof CostAttributionSchema>;
