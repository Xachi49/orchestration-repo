import { z } from "zod";

export const AnomalyClassificationSchema = z.enum([
  "THRESHOLD_EXCEEDED",
  "BASELINE_SPIKE",
  "REPEATED_ERROR",
  "CONSECUTIVE_CAPABILITY_FAILURE",
  "CONTRADICTION_BACKLOG",
  "RESOURCE_SPIKE",
]);
export type AnomalyClassification = z.infer<typeof AnomalyClassificationSchema>;

export const AnomalyStatusSchema = z.enum([
  "OPEN",
  "ACKNOWLEDGED",
  "RESOLVED",
]);
export type AnomalyStatus = z.infer<typeof AnomalyStatusSchema>;

export const AnomalyFindingSchema = z
  .object({
    anomalyId: z.string().min(1),
    projectId: z.string().min(1),
    metricName: z.string().min(1),
    classification: AnomalyClassificationSchema,
    severity: z.enum(["INFO", "WARNING", "MATERIAL", "CRITICAL"]),
    currentValue: z.number().optional(),
    baselineValue: z.number().optional(),
    threshold: z.number().optional(),
    windowFingerprint: z.string().min(1),
    affectedRunIds: z.array(z.string()).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    measurementQuality: z
      .enum(["EXACT", "RECONSTRUCTED", "PARTIAL", "UNKNOWN"])
      .default("EXACT"),
    detectedAt: z.string().datetime(),
    status: AnomalyStatusSchema.default("OPEN"),
    findingHash: z.string().min(1),
  })
  .strict();
export type AnomalyFinding = z.infer<typeof AnomalyFindingSchema>;

export const SuggestedChangeClassSchema = z.enum([
  "REVIEW_PROMPT",
  "REVIEW_MODEL_CONFIGURATION",
  "REVIEW_RESOURCE_BUDGET",
  "REVIEW_CAPABILITY_RUNTIME",
  "REVIEW_POLICY_RULE",
  "REVIEW_APPROVAL_WORKFLOW",
  "REVIEW_VERIFICATION_BINDING",
  "REVIEW_PRECEDENT",
  "REVIEW_TEST_PROFILE",
  "REVIEW_PROCESS",
]);
export type SuggestedChangeClass = z.infer<typeof SuggestedChangeClassSchema>;

export const OptimizationCandidateCategorySchema = z.enum([
  "PLANNING",
  "VALIDATION",
  "AUTHORIZATION",
  "EXECUTION",
  "VERIFICATION",
  "RESOURCE",
  "CAPABILITY",
  "PRECEDENT",
  "PROCESS",
]);
export type OptimizationCandidateCategory = z.infer<
  typeof OptimizationCandidateCategorySchema
>;

export const OptimizationCandidateStatusSchema = z.enum([
  "OPEN",
  "REVIEWED",
  "ACCEPTED_FOR_FUTURE_CHANGE",
  "REJECTED",
]);
export type OptimizationCandidateStatus = z.infer<
  typeof OptimizationCandidateStatusSchema
>;

export const OptimizationCandidateSchema = z
  .object({
    optimizationCandidateId: z.string().min(1),
    projectId: z.string().min(1),
    category: OptimizationCandidateCategorySchema,
    suggestedChangeClass: SuggestedChangeClassSchema,
    problemStatement: z.string().min(1),
    supportingMetricRefs: z.array(z.string()).default([]),
    supportingAnomalyRefs: z.array(z.string()).default([]),
    affectedRunIds: z.array(z.string()).default([]),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).default("MEDIUM"),
    expectedBenefitClass: z
      .enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"])
      .default("UNKNOWN"),
    createdAt: z.string().datetime(),
    status: OptimizationCandidateStatusSchema.default("OPEN"),
    supportingMeasurementQuality: z
      .enum(["EXACT", "RECONSTRUCTED", "PARTIAL", "UNKNOWN"])
      .default("EXACT"),
    candidateHash: z.string().min(1),
  })
  .strict();
export type OptimizationCandidate = z.infer<typeof OptimizationCandidateSchema>;
