import { hashCanonical } from "../ingestion/hashing.js";
import type {
  RunTelemetryRecord,
  PhaseTelemetryRecord,
  MetricProvenance,
  FailureAttribution,
  BottleneckFinding,
  SLOEvaluation,
  AnomalyFinding,
  OptimizationCandidate,
  SystemHealthSnapshot,
  RunTrace,
  RunFunnelReport,
} from "../domain/observability/index.js";

export class RunTelemetryHasher {
  hash(
    record: Omit<RunTelemetryRecord, "telemetryHash" | "createdAt">,
  ): string {
    return hashCanonical({
      runTelemetryId: record.runTelemetryId,
      runId: record.runId,
      projectId: record.projectId,
      objectiveId: record.objectiveId,
      terminalState: record.terminalState,
      terminalOutcome: record.terminalOutcome,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      totalDurationMs: record.totalDurationMs ?? null,
      totalDurationQuality: record.totalDurationQuality,
      phaseDurations: record.phaseDurations,
      planningRevisionCount: record.planningRevisionCount,
      validationAttemptCount: record.validationAttemptCount,
      approvalWaitMs: record.approvalWaitMs ?? null,
      approvalWaitQuality: record.approvalWaitQuality,
      executionAttemptCount: record.executionAttemptCount,
      rollbackCount: record.rollbackCount,
      containmentOccurred: record.containmentOccurred,
      verificationAttemptCount: record.verificationAttemptCount,
      learningProcessed: record.learningProcessed,
      resourceSummary: record.resourceSummary,
      failureStage: record.failureStage ?? null,
      trustClass: record.trustClass,
      sourceRecordRefs: [...record.sourceRecordRefs].sort(),
    });
  }
}

export class PhaseTelemetryHasher {
  hash(record: Omit<PhaseTelemetryRecord, "phaseTelemetryHash">): string {
    return hashCanonical({
      phaseTelemetryId: record.phaseTelemetryId,
      runId: record.runId,
      projectId: record.projectId,
      phase: record.phase,
      startedAt: record.startedAt ?? null,
      finishedAt: record.finishedAt ?? null,
      durationMs: record.durationMs ?? null,
      startedAtQuality: record.startedAtQuality,
      finishedAtQuality: record.finishedAtQuality,
      durationQuality: record.durationQuality,
      resourceQuality: record.resourceQuality,
      attemptCount: record.attemptCount,
      retryCount: record.retryCount,
      modelCallCount: record.modelCallCount,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      status: record.status,
      errorCodes: [...record.errorCodes].sort(),
      resourceConsumption: record.resourceConsumption,
      trustClass: record.trustClass,
    });
  }
}

export class MetricProvenanceHasher {
  hash(record: Omit<MetricProvenance, "metricHash">): string {
    return hashCanonical({
      metricId: record.metricId,
      metricName: record.metricName,
      calculationVersion: record.calculationVersion,
      windowFingerprint: record.windowFingerprint,
      sourceRunIds: [...record.sourceRunIds].sort(),
      sourceTelemetryIds: [...record.sourceTelemetryIds].sort(),
      sampleSize: record.sampleSize,
      numerator: record.numerator ?? null,
      denominator: record.denominator ?? null,
      measurementQuality: record.measurementQuality,
      coverage: record.coverage,
      sourceRecordRefs: [...record.sourceRecordRefs].sort(),
      trustClass: record.trustClass,
    });
  }
}

export class HealthSnapshotHasher {
  hash(
    snapshot: Omit<SystemHealthSnapshot, "snapshotHash" | "generatedAt">,
  ): string {
    return hashCanonical({
      snapshotId: snapshot.snapshotId,
      projectId: snapshot.projectId,
      windowFingerprint: snapshot.windowFingerprint,
      healthStatus: snapshot.healthStatus,
      reliabilityMetrics: snapshot.reliabilityMetrics.map((m) => m.provenance.metricHash),
      latencyMetrics: snapshot.latencyMetrics.map((m) => m.provenance.metricHash),
      resourceMetrics: snapshot.resourceMetrics.map((m) => m.attributionHash),
      sloEvaluationIds: [...snapshot.sloEvaluationIds].sort(),
      anomalyIds: [...snapshot.anomalyIds].sort(),
      bottleneckIds: [...snapshot.bottleneckIds].sort(),
      optimizationCandidateIds: [...snapshot.optimizationCandidateIds].sort(),
      qualityFindings: snapshot.qualityFindings.map((f) => f.findingId).sort(),
    });
  }
}

export class RunTraceHasher {
  hash(trace: Omit<RunTrace, "traceHash">): string {
    return hashCanonical({
      runId: trace.runId,
      projectId: trace.projectId,
      correlationId: trace.correlationId,
      traceId: trace.traceId,
      terminalState: trace.terminalState,
      stages: trace.stages,
    });
  }
}

export class RunFunnelHasher {
  hash(report: Omit<RunFunnelReport, "funnelHash">): string {
    return hashCanonical({
      projectId: report.projectId,
      windowFingerprint: report.windowFingerprint,
      stageCounts: report.stageCounts,
      dropOffByPhase: report.dropOffByPhase,
    });
  }
}

export class FailureAttributionHasher {
  hash(record: Omit<FailureAttribution, "attributionHash">): string {
    return hashCanonical({
      attributionId: record.attributionId,
      runId: record.runId,
      projectId: record.projectId,
      primaryFailurePhase: record.primaryFailurePhase,
      primaryFailureCode: record.primaryFailureCode,
      primaryFailureCategory: record.primaryFailureCategory,
      contributingFailureCodes: [...record.contributingFailureCodes].sort(),
      retryCount: record.retryCount,
      containmentReason: record.containmentReason ?? null,
      affectedCapabilityIds: [...record.affectedCapabilityIds].sort(),
      affectedStepIds: [...record.affectedStepIds].sort(),
      affectedCriterionIds: [...record.affectedCriterionIds].sort(),
    });
  }
}

export class BottleneckFindingHasher {
  hash(record: Omit<BottleneckFinding, "findingHash" | "detectedAt">): string {
    return hashCanonical({
      bottleneckId: record.bottleneckId,
      projectId: record.projectId,
      category: record.category,
      severity: record.severity,
      windowFingerprint: record.windowFingerprint,
      affectedRunIds: [...record.affectedRunIds].sort(),
      metricRefs: [...record.metricRefs].sort(),
      evidenceRefs: [...record.evidenceRefs].sort(),
      explanation: record.explanation,
      evidenceClass: record.evidenceClass,
    });
  }
}

export class SLOEvaluationHasher {
  hash(record: Omit<SLOEvaluation, "evaluationHash" | "evaluatedAt">): string {
    return hashCanonical({
      evaluationId: record.evaluationId,
      sloId: record.sloId,
      projectId: record.projectId,
      status: record.status,
      observedValue: record.observedValue ?? null,
      target: record.target,
      sampleSize: record.sampleSize,
      windowFingerprint: record.windowFingerprint,
      supportingMetricRefs: [...record.supportingMetricRefs].sort(),
      measurementQuality: record.measurementQuality ?? null,
      insufficientReason: record.insufficientReason ?? null,
    });
  }
}

export class AnomalyFindingHasher {
  hash(record: Omit<AnomalyFinding, "findingHash" | "detectedAt">): string {
    return hashCanonical({
      anomalyId: record.anomalyId,
      projectId: record.projectId,
      metricName: record.metricName,
      classification: record.classification,
      severity: record.severity,
      currentValue: record.currentValue ?? null,
      baselineValue: record.baselineValue ?? null,
      threshold: record.threshold ?? null,
      windowFingerprint: record.windowFingerprint,
      affectedRunIds: [...record.affectedRunIds].sort(),
      evidenceRefs: [...record.evidenceRefs].sort(),
      measurementQuality: record.measurementQuality,
      status: record.status,
    });
  }
}

export class OptimizationCandidateHasher {
  hash(record: Omit<OptimizationCandidate, "candidateHash" | "createdAt">): string {
    return hashCanonical({
      optimizationCandidateId: record.optimizationCandidateId,
      projectId: record.projectId,
      category: record.category,
      suggestedChangeClass: record.suggestedChangeClass,
      problemStatement: record.problemStatement,
      supportingMetricRefs: [...record.supportingMetricRefs].sort(),
      supportingAnomalyRefs: [...record.supportingAnomalyRefs].sort(),
      affectedRunIds: [...record.affectedRunIds].sort(),
      riskClass: record.riskClass,
      expectedBenefitClass: record.expectedBenefitClass,
      status: record.status,
      supportingMeasurementQuality: record.supportingMeasurementQuality,
    });
  }
}

export function windowFingerprint(input: {
  projectId: string;
  kind: string;
  includedRunIds: readonly string[];
  startAt?: string;
  endAt?: string;
  lastN?: number;
}): string {
  return hashCanonical({
    projectId: input.projectId,
    kind: input.kind,
    includedRunIds: [...input.includedRunIds].sort(),
    startAt: input.startAt ?? null,
    endAt: input.endAt ?? null,
    lastN: input.lastN ?? null,
  });
}
