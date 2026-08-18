import { z } from "zod";
import { TelemetryTrustClassSchema, type TelemetryTrustClass } from "./trust.js";

/**
 * How completely a derived measurement represents the intended quantity.
 * DETERMINISTICALLY DERIVED != NECESSARILY COMPLETE.
 */
export const MeasurementQualitySchema = z.enum([
  "EXACT",
  "RECONSTRUCTED",
  "PARTIAL",
  "UNKNOWN",
]);
export type MeasurementQuality = z.infer<typeof MeasurementQualitySchema>;

/**
 * EXACT: directly derived from authoritative records whose semantics match the quantity.
 * RECONSTRUCTED: deterministically derived from multiple authoritative records, not directly recorded.
 * PARTIAL: relevant source data is missing; the value is known incomplete.
 * UNKNOWN: cannot be calculated safely.
 */
export const MeasurementCoverageSchema = z
  .object({
    candidateCount: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative().default(0),
    exclusionReasons: z.array(z.string()).default([]),
  })
  .strict();
export type MeasurementCoverage = z.infer<typeof MeasurementCoverageSchema>;

/** Bounded refs — identifiers only, never source payloads. */
export const MetricSourceProvenanceSchema = z
  .object({
    sourceRecordRefs: z.array(z.string()).default([]),
    calculationVersion: z.string().min(1),
    measurementQuality: MeasurementQualitySchema,
    coverage: MeasurementCoverageSchema,
  })
  .strict();
export type MetricSourceProvenance = z.infer<typeof MetricSourceProvenanceSchema>;

export const TelemetryQualityReasonSchema = z.enum([
  "MISSING_EXACT_PHASE_START",
  "MISSING_EXACT_PHASE_END",
  "PARTIAL_RESOURCE_LEDGER",
  "SOURCE_RECORD_GAP",
  "INSUFFICIENT_ELIGIBLE_SAMPLES",
  "PROXY_TIMESTAMP_EXCLUDED",
]);
export type TelemetryQualityReason = z.infer<typeof TelemetryQualityReasonSchema>;

export const TelemetryQualityFindingSchema = z
  .object({
    findingId: z.string().min(1),
    projectId: z.string().min(1),
    reason: TelemetryQualityReasonSchema,
    phase: z.string().optional(),
    runId: z.string().optional(),
    windowFingerprint: z.string().optional(),
    explanation: z.string().min(1),
  })
  .strict();
export type TelemetryQualityFinding = z.infer<
  typeof TelemetryQualityFindingSchema
>;

export const SLOInsufficientReasonSchema = z.enum([
  "INSUFFICIENT_SAMPLE",
  "INSUFFICIENT_MEASUREMENT_QUALITY",
  "INCOMPLETE_SOURCE_COVERAGE",
]);
export type SLOInsufficientReason = z.infer<typeof SLOInsufficientReasonSchema>;

export const BottleneckEvidenceClassSchema = z.enum([
  "CONFIRMED",
  "SUSPECTED",
]);
export type BottleneckEvidenceClass = z.infer<
  typeof BottleneckEvidenceClassSchema
>;

export function trustClassForMeasurementQuality(
  quality: MeasurementQuality,
): TelemetryTrustClass {
  if (quality === "EXACT" || quality === "RECONSTRUCTED") {
    return "AUTHORITATIVE_DERIVED";
  }
  return "BEST_EFFORT_DERIVED";
}

export function isSloEligibleQuality(
  quality: MeasurementQuality,
  options?: { permitsReconstruction?: boolean },
): {
  eligible: boolean;
  reason?: SLOInsufficientReason;
} {
  if (quality === "EXACT") {
    return { eligible: true };
  }
  if (quality === "RECONSTRUCTED" && options?.permitsReconstruction !== false) {
    return { eligible: true };
  }
  if (quality === "PARTIAL") {
    return { eligible: false, reason: "INCOMPLETE_SOURCE_COVERAGE" };
  }
  return { eligible: false, reason: "INSUFFICIENT_MEASUREMENT_QUALITY" };
}

export function isAuthoritativeDecisionEligible(
  quality: MeasurementQuality,
): boolean {
  return quality === "EXACT" || quality === "RECONSTRUCTED";
}

export function combineMeasurementQuality(
  qualities: readonly MeasurementQuality[],
): MeasurementQuality {
  if (qualities.length === 0) return "UNKNOWN";
  if (qualities.includes("UNKNOWN")) return "UNKNOWN";
  if (qualities.includes("PARTIAL")) return "PARTIAL";
  if (qualities.includes("RECONSTRUCTED")) return "RECONSTRUCTED";
  return "EXACT";
}

export function emptyCoverage(candidateCount = 0): MeasurementCoverage {
  return {
    candidateCount,
    eligibleCount: 0,
    excludedCount: candidateCount,
    exclusionReasons:
      candidateCount > 0 ? ["INSUFFICIENT_ELIGIBLE_SAMPLES"] : [],
  };
}

void TelemetryTrustClassSchema;
