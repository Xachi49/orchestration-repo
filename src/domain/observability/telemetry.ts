import { z } from "zod";
import { HistoricalOutcomeSchema } from "../memory/historical-run.js";
import { RunStateSchema } from "../run/run-state.js";
import { ObservabilityPhaseSchema } from "./phase.js";
import { TelemetryTrustClassSchema } from "./trust.js";
import { MeasurementQualitySchema } from "./quality.js";

export const PhaseDurationEntrySchema = z
  .object({
    phase: ObservabilityPhaseSchema,
    durationMs: z.number().int().nonnegative().optional(),
    unknown: z.boolean().default(false),
    measurementQuality: MeasurementQualitySchema.default("UNKNOWN"),
    sourceRecordRefs: z.array(z.string()).default([]),
  })
  .strict();

export const ResourceSummaryEntrySchema = z
  .object({
    category: z.string().min(1),
    modelCallCount: z.number().int().nonnegative().default(0),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0),
    executionMinutes: z.number().nonnegative().default(0),
    apiCallCount: z.number().int().nonnegative().default(0),
    measurementQuality: MeasurementQualitySchema.default("UNKNOWN"),
    usageCompleteness: z.enum(["COMPLETE", "PARTIAL", "UNKNOWN"]).default("UNKNOWN"),
  })
  .strict();

export const RunTelemetryRecordSchema = z
  .object({
    runTelemetryId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    terminalState: RunStateSchema,
    terminalOutcome: HistoricalOutcomeSchema.or(z.literal("UNKNOWN")),
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    totalDurationMs: z.number().int().nonnegative().optional(),
    totalDurationQuality: MeasurementQualitySchema.default("UNKNOWN"),
    approvalWaitQuality: MeasurementQualitySchema.default("UNKNOWN"),
    phaseDurations: z.array(PhaseDurationEntrySchema).default([]),
    planningRevisionCount: z.number().int().nonnegative().default(0),
    validationAttemptCount: z.number().int().nonnegative().default(0),
    approvalWaitMs: z.number().int().nonnegative().optional(),
    executionAttemptCount: z.number().int().nonnegative().default(0),
    rollbackCount: z.number().int().nonnegative().default(0),
    containmentOccurred: z.boolean().default(false),
    verificationAttemptCount: z.number().int().nonnegative().default(0),
    learningProcessed: z.boolean().default(false),
    resourceSummary: z.array(ResourceSummaryEntrySchema).default([]),
    failureStage: ObservabilityPhaseSchema.optional(),
    trustClass: TelemetryTrustClassSchema.default("AUTHORITATIVE_DERIVED"),
    sourceRecordRefs: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
    telemetryHash: z.string().min(1),
  })
  .strict();
export type RunTelemetryRecord = z.infer<typeof RunTelemetryRecordSchema>;

export const PhaseTelemetryRecordSchema = z
  .object({
    phaseTelemetryId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    phase: ObservabilityPhaseSchema,
    startedAt: z.string().datetime().optional(),
    finishedAt: z.string().datetime().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    startedAtQuality: MeasurementQualitySchema.default("UNKNOWN"),
    finishedAtQuality: MeasurementQualitySchema.default("UNKNOWN"),
    durationQuality: MeasurementQualitySchema.default("UNKNOWN"),
    resourceQuality: MeasurementQualitySchema.default("UNKNOWN"),
    attemptCount: z.number().int().nonnegative().default(1),
    retryCount: z.number().int().nonnegative().default(0),
    modelCallCount: z.number().int().nonnegative().default(0),
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    totalTokens: z.number().int().nonnegative().default(0),
    status: z.string().min(1),
    errorCodes: z.array(z.string()).default([]),
    resourceConsumption: z.record(z.string(), z.number()).default({}),
    trustClass: TelemetryTrustClassSchema.default("AUTHORITATIVE_DERIVED"),
    phaseTelemetryHash: z.string().min(1),
  })
  .strict();
export type PhaseTelemetryRecord = z.infer<typeof PhaseTelemetryRecordSchema>;
