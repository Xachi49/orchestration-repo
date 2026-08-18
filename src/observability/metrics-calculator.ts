import type {
  ReliabilityMetric,
  LatencyMetric,
  LatencyStats,
  MetricProvenance,
  RunTelemetryRecord,
  MeasurementQuality,
  MeasurementCoverage,
} from "../domain/observability/index.js";
import {
  trustClassForMeasurementQuality,
  emptyCoverage,
} from "../domain/observability/quality.js";
import { MetricProvenanceHasher } from "./hasher.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";

const CALC_VERSION = "v1";

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid];
}

function isLatencyEligible(quality: MeasurementQuality | undefined): boolean {
  return quality === "EXACT" || quality === "RECONSTRUCTED";
}

function coverageFrom(
  candidateCount: number,
  eligibleCount: number,
  exclusionReasons: string[],
): MeasurementCoverage {
  return {
    candidateCount,
    eligibleCount,
    excludedCount: Math.max(0, candidateCount - eligibleCount),
    exclusionReasons: eligibleCount < candidateCount ? exclusionReasons : [],
  };
}

function buildProvenance(input: {
  metricName: string;
  windowFingerprint: string;
  sourceRunIds: readonly string[];
  sourceTelemetryIds: readonly string[];
  sampleSize: number;
  numerator?: number;
  denominator?: number;
  measurementQuality: MeasurementQuality;
  coverage: MeasurementCoverage;
  identities: SequenceObservabilityIdentityGenerator;
}): MetricProvenance {
  const hasher = new MetricProvenanceHasher();
  const metricId = input.identities.next("metric");
  const partial: Omit<MetricProvenance, "metricHash"> = {
    metricId,
    metricName: input.metricName,
    calculationVersion: `${input.metricName}/${CALC_VERSION}`,
    windowFingerprint: input.windowFingerprint,
    sourceRunIds: [...input.sourceRunIds],
    sourceTelemetryIds: [...input.sourceTelemetryIds],
    sourceRecordRefs: [...input.sourceTelemetryIds],
    sampleSize: input.sampleSize,
    measurementQuality: input.measurementQuality,
    coverage: input.coverage,
    trustClass: trustClassForMeasurementQuality(input.measurementQuality),
  };
  if (input.numerator !== undefined) partial.numerator = input.numerator;
  if (input.denominator !== undefined) partial.denominator = input.denominator;
  return { ...partial, metricHash: hasher.hash(partial) };
}

function rateMetric(
  metricName: string,
  numerator: number,
  denominator: number,
  windowFingerprint: string,
  records: readonly RunTelemetryRecord[],
  identities: SequenceObservabilityIdentityGenerator,
): ReliabilityMetric {
  const insufficientSample = denominator === 0;
  const coverage = coverageFrom(
    records.length,
    records.length,
    [],
  );
  const provenance = buildProvenance({
    metricName,
    windowFingerprint,
    sourceRunIds: records.map((r) => r.runId),
    sourceTelemetryIds: records.map((r) => r.runTelemetryId),
    sampleSize: denominator,
    numerator,
    denominator,
    measurementQuality: "EXACT",
    coverage,
    identities,
  });
  return {
    metricName,
    numerator,
    denominator,
    rate: insufficientSample ? undefined : numerator / denominator,
    insufficientSample,
    provenance,
  };
}

export function computeReliabilityMetrics(
  records: readonly RunTelemetryRecord[],
  windowFingerprint: string,
  identities = new SequenceObservabilityIdentityGenerator(),
): ReliabilityMetric[] {
  const n = records.length;
  const count = (pred: (r: RunTelemetryRecord) => boolean) =>
    records.filter(pred).length;

  return [
    rateMetric(
      "runCompletionRate",
      count((r) => r.terminalState === "COMPLETED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "verifiedSuccessRate",
      count((r) => r.terminalOutcome === "VERIFIED_SUCCESS"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "partialSuccessRate",
      count((r) => r.terminalOutcome === "PARTIAL_SUCCESS"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "verificationFailureRate",
      count((r) => r.terminalOutcome === "VERIFICATION_FAILED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "inconclusiveRate",
      count((r) => r.terminalOutcome === "INCONCLUSIVE"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "containmentRate",
      count((r) => r.containmentOccurred || r.terminalOutcome === "CONTAINED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "blockedRate",
      count((r) => r.terminalState === "BLOCKED" || r.terminalOutcome === "BLOCKED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "approvalRejectionRate",
      count((r) => r.terminalOutcome === "REJECTED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "approvalExpiryRate",
      count((r) => r.terminalOutcome === "EXPIRED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "executionFailureRate",
      count((r) => r.terminalState === "FAILED"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "rollbackRate",
      count((r) => r.rollbackCount > 0),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "revisionRate",
      count((r) => r.planningRevisionCount > 0 || r.validationAttemptCount > 1),
      n,
      windowFingerprint,
      records,
      identities,
    ),
    rateMetric(
      "validationBlockRate",
      count((r) => r.failureStage === "VALIDATION"),
      n,
      windowFingerprint,
      records,
      identities,
    ),
  ];
}

function latencyStats(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { count: 0, insufficientSample: true };
  }
  const p95 = values.length >= 5 ? percentile(values, 95) : undefined;
  return {
    count: values.length,
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
    meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    medianMs: median(values),
    p95Ms: p95,
    insufficientSample: values.length === 0,
  };
}

function latencyQuality(qualities: MeasurementQuality[]): MeasurementQuality {
  if (qualities.length === 0) return "UNKNOWN";
  if (qualities.every((q) => q === "EXACT")) return "EXACT";
  if (qualities.every((q) => q === "EXACT" || q === "RECONSTRUCTED")) {
    return "RECONSTRUCTED";
  }
  return "UNKNOWN";
}

export function computeLatencyMetrics(
  records: readonly RunTelemetryRecord[],
  windowFingerprint: string,
  identities = new SequenceObservabilityIdentityGenerator(),
): LatencyMetric[] {
  const metrics: LatencyMetric[] = [];
  const totalEligible = records.filter(
    (r) =>
      r.totalDurationMs !== undefined &&
      isLatencyEligible(r.totalDurationQuality),
  );
  const totalValues = totalEligible.map((r) => r.totalDurationMs!);
  metrics.push({
    metricName: "totalRunLatency",
    stats: latencyStats(totalValues),
    provenance: buildProvenance({
      metricName: "totalRunLatency",
      windowFingerprint,
      sourceRunIds: totalEligible.map((r) => r.runId),
      sourceTelemetryIds: totalEligible.map((r) => r.runTelemetryId),
      sampleSize: totalValues.length,
      measurementQuality: latencyQuality(
        totalEligible.map((r) => r.totalDurationQuality),
      ),
      coverage: coverageFrom(
        records.length,
        totalEligible.length,
        ["MISSING_EXACT_PHASE_START", "MISSING_EXACT_PHASE_END"],
      ),
      identities,
    }),
  });

  const approvalEligible = records.filter(
    (r) =>
      r.approvalWaitMs !== undefined &&
      isLatencyEligible(r.approvalWaitQuality),
  );
  const approvalWaits = approvalEligible.map((r) => r.approvalWaitMs!);
  metrics.push({
    metricName: "approvalWaitLatency",
    phase: "AUTHORIZATION",
    stats: latencyStats(approvalWaits),
    provenance: buildProvenance({
      metricName: "approvalWaitLatency",
      windowFingerprint,
      sourceRunIds: approvalEligible.map((r) => r.runId),
      sourceTelemetryIds: approvalEligible.map((r) => r.runTelemetryId),
      sampleSize: approvalWaits.length,
      measurementQuality: latencyQuality(
        approvalEligible.map((r) => r.approvalWaitQuality),
      ),
      coverage: coverageFrom(
        records.length,
        approvalEligible.length,
        ["INSUFFICIENT_MEASUREMENT_QUALITY"],
      ),
      identities,
    }),
  });

  const phases = [
    "ADMISSION",
    "INGESTION",
    "PLANNING",
    "VALIDATION",
    "AUTHORIZATION",
    "EXECUTION",
    "VERIFICATION",
    "LEARNING",
  ] as const;

  for (const phase of phases) {
    const eligibleEntries: { durationMs: number; quality: MeasurementQuality; runId: string; telemetryId: string }[] =
      [];
    for (const record of records) {
      const entry = record.phaseDurations.find((d) => d.phase === phase);
      if (
        entry &&
        entry.durationMs !== undefined &&
        isLatencyEligible(entry.measurementQuality)
      ) {
        eligibleEntries.push({
          durationMs: entry.durationMs,
          quality: entry.measurementQuality,
          runId: record.runId,
          telemetryId: record.runTelemetryId,
        });
      }
    }
    metrics.push({
      metricName: `${phase.toLowerCase()}Latency`,
      phase,
      stats: latencyStats(eligibleEntries.map((e) => e.durationMs)),
      provenance: buildProvenance({
        metricName: `${phase.toLowerCase()}Latency`,
        windowFingerprint,
        sourceRunIds: eligibleEntries.map((e) => e.runId),
        sourceTelemetryIds: eligibleEntries.map((e) => e.telemetryId),
        sampleSize: eligibleEntries.length,
        measurementQuality: latencyQuality(eligibleEntries.map((e) => e.quality)),
        coverage: coverageFrom(
          records.length,
          eligibleEntries.length,
          ["PROXY_TIMESTAMP_EXCLUDED", "MISSING_EXACT_PHASE_START"],
        ),
        identities,
      }),
    });
  }

  return metrics;
}

export { emptyCoverage };
