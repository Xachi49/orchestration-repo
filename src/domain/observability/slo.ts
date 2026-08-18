import { z } from "zod";

export const SLOOperatorSchema = z.enum([
  "GTE",
  "LTE",
]);
export type SLOOperator = z.infer<typeof SLOOperatorSchema>;

export const SLOSeveritySchema = z.enum(["INFO", "WARNING", "CRITICAL"]);
export type SLOSeverity = z.infer<typeof SLOSeveritySchema>;

export const SLODefinitionSchema = z
  .object({
    sloId: z.string().min(1),
    projectId: z.string().min(1),
    metricName: z.string().min(1),
    calculationVersion: z.string().min(1),
    operator: SLOOperatorSchema,
    target: z.number(),
    minimumSampleSize: z.number().int().positive().default(1),
    windowKind: z.enum(["LAST_N_RUNS", "TIME_RANGE", "PROJECT_LIFETIME"]),
    lastN: z.number().int().positive().optional(),
    severity: SLOSeveritySchema.default("WARNING"),
    enabled: z.boolean().default(true),
    version: z.number().int().positive().default(1),
  })
  .strict();
export type SLODefinition = z.infer<typeof SLODefinitionSchema>;

export const SLOEvaluationStatusSchema = z.enum([
  "PASS",
  "FAIL",
  "INSUFFICIENT_DATA",
]);
export type SLOEvaluationStatus = z.infer<typeof SLOEvaluationStatusSchema>;

export const SLOEvaluationSchema = z
  .object({
    evaluationId: z.string().min(1),
    sloId: z.string().min(1),
    projectId: z.string().min(1),
    status: SLOEvaluationStatusSchema,
    observedValue: z.number().optional(),
    target: z.number(),
    sampleSize: z.number().int().nonnegative(),
    windowFingerprint: z.string().min(1),
    supportingMetricRefs: z.array(z.string()).default([]),
    measurementQuality: z
      .enum(["EXACT", "RECONSTRUCTED", "PARTIAL", "UNKNOWN"])
      .optional(),
    insufficientReason: z
      .enum([
        "INSUFFICIENT_SAMPLE",
        "INSUFFICIENT_MEASUREMENT_QUALITY",
        "INCOMPLETE_SOURCE_COVERAGE",
      ])
      .optional(),
    evaluatedAt: z.string().datetime(),
    evaluationHash: z.string().min(1),
  })
  .strict();
export type SLOEvaluation = z.infer<typeof SLOEvaluationSchema>;

export const ErrorBudgetDefinitionSchema = z
  .object({
    errorBudgetId: z.string().min(1),
    sloId: z.string().min(1),
    allowedFailureRate: z.number().min(0).max(1),
    windowFingerprint: z.string().min(1),
  })
  .strict();
export type ErrorBudgetDefinition = z.infer<typeof ErrorBudgetDefinitionSchema>;
