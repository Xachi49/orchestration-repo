import { z } from "zod";
import { ObservabilityPhaseSchema } from "./phase.js";

export const FailureCategorySchema = z.enum([
  "INPUT",
  "AUTHORITY",
  "REPOSITORY_TRUTH",
  "PLANNING",
  "VALIDATION",
  "APPROVAL",
  "CAPABILITY",
  "EXECUTION",
  "RESOURCE",
  "ROLLBACK",
  "CONTAINMENT",
  "VERIFICATION",
  "EVIDENCE",
  "MEMORY",
  "INFRASTRUCTURE",
  "UNKNOWN",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const FailureAttributionSchema = z
  .object({
    attributionId: z.string().min(1),
    runId: z.string().min(1),
    projectId: z.string().min(1),
    primaryFailurePhase: ObservabilityPhaseSchema,
    primaryFailureCode: z.string().min(1),
    primaryFailureCategory: FailureCategorySchema,
    contributingFailureCodes: z.array(z.string()).default([]),
    retryCount: z.number().int().nonnegative().default(0),
    containmentReason: z.string().optional(),
    affectedCapabilityIds: z.array(z.string()).default([]),
    affectedStepIds: z.array(z.string()).default([]),
    affectedCriterionIds: z.array(z.string()).default([]),
    attributionHash: z.string().min(1),
  })
  .strict();
export type FailureAttribution = z.infer<typeof FailureAttributionSchema>;

export const BottleneckCategorySchema = z.enum([
  "LATENCY",
  "APPROVAL_WAIT",
  "REVISION_LOOP",
  "VALIDATION_REJECTION",
  "RESOURCE_PRESSURE",
  "CAPABILITY_FAILURE",
  "VERIFICATION_INCONCLUSIVE",
  "CONTAINMENT",
  "REPEATED_ROLLBACK",
  "PRECEDENT_CONTRADICTION",
  "LEARNING_REVIEW_BACKLOG",
]);
export type BottleneckCategory = z.infer<typeof BottleneckCategorySchema>;

export const BottleneckFindingSchema = z
  .object({
    bottleneckId: z.string().min(1),
    projectId: z.string().min(1),
    category: BottleneckCategorySchema,
    severity: z.enum(["INFO", "WARNING", "MATERIAL", "CRITICAL"]),
    windowFingerprint: z.string().min(1),
    affectedRunIds: z.array(z.string()).default([]),
    metricRefs: z.array(z.string()).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    explanation: z.string().min(1),
    evidenceClass: z.enum(["CONFIRMED", "SUSPECTED"]).default("CONFIRMED"),
    detectedAt: z.string().datetime(),
    findingHash: z.string().min(1),
  })
  .strict();
export type BottleneckFinding = z.infer<typeof BottleneckFindingSchema>;
