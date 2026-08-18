import { z } from "zod";
import { ReliabilityMetricSchema, LatencyMetricSchema } from "./metrics.js";
import { ResourceAttributionRecordSchema } from "./metrics.js";
import { SLOEvaluationSchema } from "./slo.js";
import { AnomalyFindingSchema } from "./anomaly.js";
import { BottleneckFindingSchema } from "./failure.js";
import { TelemetryQualityFindingSchema } from "./quality.js";

export const SystemHealthStatusSchema = z.enum([
  "HEALTHY",
  "DEGRADED",
  "CRITICAL",
  "INSUFFICIENT_DATA",
]);
export type SystemHealthStatus = z.infer<typeof SystemHealthStatusSchema>;

export const SystemHealthSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    projectId: z.string().min(1),
    windowFingerprint: z.string().min(1),
    healthStatus: SystemHealthStatusSchema,
    reliabilityMetrics: z.array(ReliabilityMetricSchema).default([]),
    latencyMetrics: z.array(LatencyMetricSchema).default([]),
    resourceMetrics: z.array(ResourceAttributionRecordSchema).default([]),
    sloEvaluationIds: z.array(z.string()).default([]),
    sloEvaluations: z.array(SLOEvaluationSchema).default([]),
    anomalyIds: z.array(z.string()).default([]),
    anomalies: z.array(AnomalyFindingSchema).default([]),
    bottleneckIds: z.array(z.string()).default([]),
    bottlenecks: z.array(BottleneckFindingSchema).default([]),
    optimizationCandidateIds: z.array(z.string()).default([]),
    qualityFindings: z.array(TelemetryQualityFindingSchema).default([]),
    generatedAt: z.string().datetime(),
    snapshotHash: z.string().min(1),
  })
  .strict();
export type SystemHealthSnapshot = z.infer<typeof SystemHealthSnapshotSchema>;

export const ObservabilityResultSchema = z
  .object({
    projectId: z.string().min(1),
    windowFingerprint: z.string().min(1),
    healthSnapshotId: z.string().min(1),
    healthStatus: SystemHealthStatusSchema,
    metricRefs: z.array(z.string()).default([]),
    sloEvaluationIds: z.array(z.string()).default([]),
    anomalyIds: z.array(z.string()).default([]),
    bottleneckIds: z.array(z.string()).default([]),
    optimizationCandidateIds: z.array(z.string()).default([]),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type ObservabilityResult = z.infer<typeof ObservabilityResultSchema>;

export const RunTraceStageSchema = z
  .object({
    phase: z.string().min(1),
    reached: z.boolean(),
    recordId: z.string().optional(),
    recordHash: z.string().optional(),
    status: z.string().optional(),
    errorCode: z.string().optional(),
    timestamp: z.string().datetime().optional(),
  })
  .strict();
export type RunTraceStage = z.infer<typeof RunTraceStageSchema>;

export const RunTraceSchema = z
  .object({
    runId: z.string().min(1),
    projectId: z.string().min(1),
    correlationId: z.string().min(1),
    traceId: z.string().min(1),
    terminalState: z.string().min(1),
    stages: z.array(RunTraceStageSchema),
    traceHash: z.string().min(1),
  })
  .strict();
export type RunTrace = z.infer<typeof RunTraceSchema>;

export const RunFunnelStageSchema = z.enum([
  "ADMITTED",
  "INGESTED",
  "PLANNED",
  "VALIDATED",
  "AWAITING_APPROVAL",
  "APPROVED",
  "EXECUTED",
  "VERIFIED_SUCCESS",
  "COMPLETED",
  "LEARNED",
]);
export type RunFunnelStage = z.infer<typeof RunFunnelStageSchema>;

export const RunFunnelReportSchema = z
  .object({
    projectId: z.string().min(1),
    windowFingerprint: z.string().min(1),
    stageCounts: z.record(RunFunnelStageSchema, z.number().int().nonnegative()),
    dropOffByPhase: z.record(z.string(), z.number().int().nonnegative()).default({}),
    funnelHash: z.string().min(1),
  })
  .strict();
export type RunFunnelReport = z.infer<typeof RunFunnelReportSchema>;
