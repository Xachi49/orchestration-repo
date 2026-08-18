import type {
  AnomalyFinding,
  BottleneckFinding,
  OptimizationCandidate,
  ReliabilityMetric,
  RunTelemetryRecord,
  LatencyMetric,
} from "../domain/observability/index.js";
import { isAuthoritativeDecisionEligible } from "../domain/observability/quality.js";
import {
  AnomalyFindingHasher,
  BottleneckFindingHasher,
  OptimizationCandidateHasher,
} from "./hasher.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";

export interface AnomalyThresholds {
  revisionRateThreshold?: number;
  containmentSpikeFactor?: number;
  inconclusiveRateThreshold?: number;
  approvalWaitP95Ms?: number;
  repeatedErrorMinRuns?: number;
}

const DEFAULT_THRESHOLDS: Required<AnomalyThresholds> = {
  revisionRateThreshold: 0.5,
  containmentSpikeFactor: 2,
  inconclusiveRateThreshold: 0.2,
  approvalWaitP95Ms: 60_000,
  repeatedErrorMinRuns: 3,
};

export class AnomalyDetectionService {
  private readonly anomalyHasher = new AnomalyFindingHasher();

  constructor(
    private readonly identities = new SequenceObservabilityIdentityGenerator(),
    private readonly thresholds: AnomalyThresholds = {},
  ) {}

  detect(input: {
    projectId: string;
    windowFingerprint: string;
    reliabilityMetrics: readonly ReliabilityMetric[];
    latencyMetrics: readonly LatencyMetric[];
    runRecords: readonly RunTelemetryRecord[];
    baselineMetrics?: readonly ReliabilityMetric[];
    detectedAt: string;
  }): AnomalyFinding[] {
    const t = { ...DEFAULT_THRESHOLDS, ...this.thresholds };
    const findings: AnomalyFinding[] = [];

    const revision = input.reliabilityMetrics.find(
      (m) => m.metricName === "revisionRate",
    );
    if (
      revision &&
      !revision.insufficientSample &&
      revision.rate !== undefined &&
      revision.rate > t.revisionRateThreshold &&
      isAuthoritativeDecisionEligible(revision.provenance.measurementQuality)
    ) {
      findings.push(
        this.anomaly({
          projectId: input.projectId,
          metricName: "revisionRate",
          classification: "THRESHOLD_EXCEEDED",
          severity: "MATERIAL",
          currentValue: revision.rate,
          threshold: t.revisionRateThreshold,
          windowFingerprint: input.windowFingerprint,
          affectedRunIds: input.runRecords
            .filter((r) => r.planningRevisionCount > 0)
            .map((r) => r.runId),
          evidenceRefs: [revision.provenance.metricId],
          measurementQuality: revision.provenance.measurementQuality,
          detectedAt: input.detectedAt,
        }),
      );
    }

    const inconclusive = input.reliabilityMetrics.find(
      (m) => m.metricName === "inconclusiveRate",
    );
    if (
      inconclusive &&
      !inconclusive.insufficientSample &&
      inconclusive.rate !== undefined &&
      inconclusive.rate > t.inconclusiveRateThreshold &&
      isAuthoritativeDecisionEligible(inconclusive.provenance.measurementQuality)
    ) {
      findings.push(
        this.anomaly({
          projectId: input.projectId,
          metricName: "inconclusiveRate",
          classification: "THRESHOLD_EXCEEDED",
          severity: "WARNING",
          currentValue: inconclusive.rate,
          threshold: t.inconclusiveRateThreshold,
          windowFingerprint: input.windowFingerprint,
          affectedRunIds: input.runRecords
            .filter((r) => r.terminalOutcome === "INCONCLUSIVE")
            .map((r) => r.runId),
          evidenceRefs: [inconclusive.provenance.metricId],
          measurementQuality: inconclusive.provenance.measurementQuality,
          detectedAt: input.detectedAt,
        }),
      );
    }

    const containment = input.reliabilityMetrics.find(
      (m) => m.metricName === "containmentRate",
    );
    const baselineContainment = input.baselineMetrics?.find(
      (m) => m.metricName === "containmentRate",
    );
    if (
      containment &&
      baselineContainment &&
      !containment.insufficientSample &&
      !baselineContainment.insufficientSample &&
      containment.rate !== undefined &&
      baselineContainment.rate !== undefined &&
      baselineContainment.rate > 0 &&
      containment.rate > baselineContainment.rate * t.containmentSpikeFactor &&
      isAuthoritativeDecisionEligible(containment.provenance.measurementQuality) &&
      isAuthoritativeDecisionEligible(
        baselineContainment.provenance.measurementQuality,
      )
    ) {
      findings.push(
        this.anomaly({
          projectId: input.projectId,
          metricName: "containmentRate",
          classification: "BASELINE_SPIKE",
          severity: "CRITICAL",
          currentValue: containment.rate,
          baselineValue: baselineContainment.rate,
          threshold: baselineContainment.rate * t.containmentSpikeFactor,
          windowFingerprint: input.windowFingerprint,
          affectedRunIds: input.runRecords
            .filter((r) => r.containmentOccurred)
            .map((r) => r.runId),
          evidenceRefs: [
            containment.provenance.metricId,
            baselineContainment.provenance.metricId,
          ],
          measurementQuality: containment.provenance.measurementQuality,
          detectedAt: input.detectedAt,
        }),
      );
    }

    const approvalLatency = input.latencyMetrics.find(
      (m) => m.metricName === "approvalWaitLatency",
    );
    if (
      approvalLatency &&
      approvalLatency.stats.p95Ms !== undefined &&
      approvalLatency.stats.p95Ms > t.approvalWaitP95Ms &&
      isAuthoritativeDecisionEligible(
        approvalLatency.provenance.measurementQuality,
      )
    ) {
      findings.push(
        this.anomaly({
          projectId: input.projectId,
          metricName: "approvalWaitLatency",
          classification: "THRESHOLD_EXCEEDED",
          severity: "WARNING",
          currentValue: approvalLatency.stats.p95Ms,
          threshold: t.approvalWaitP95Ms,
          windowFingerprint: input.windowFingerprint,
          affectedRunIds: input.runRecords
            .filter((r) => r.approvalWaitMs !== undefined)
            .map((r) => r.runId),
          evidenceRefs: [approvalLatency.provenance.metricId],
          measurementQuality: approvalLatency.provenance.measurementQuality,
          detectedAt: input.detectedAt,
        }),
      );
    }

    const errorCounts = new Map<string, string[]>();
    for (const run of input.runRecords) {
      if (run.terminalState === "COMPLETED") continue;
      const code = run.failureStage ?? "UNKNOWN";
      const list = errorCounts.get(code) ?? [];
      list.push(run.runId);
      errorCounts.set(code, list);
    }
    for (const [code, runIds] of errorCounts) {
      if (runIds.length >= t.repeatedErrorMinRuns) {
        findings.push(
          this.anomaly({
            projectId: input.projectId,
            metricName: "repeatedError",
            classification: "REPEATED_ERROR",
            severity: "MATERIAL",
            currentValue: runIds.length,
            threshold: t.repeatedErrorMinRuns,
            windowFingerprint: input.windowFingerprint,
            affectedRunIds: runIds,
            evidenceRefs: [`error:${code}`],
            measurementQuality: "EXACT",
            detectedAt: input.detectedAt,
          }),
        );
      }
    }

    return findings;
  }

  private anomaly(
    input: Omit<AnomalyFinding, "anomalyId" | "findingHash" | "status">,
  ): AnomalyFinding {
    const partial = {
      ...input,
      anomalyId: this.identities.next("anomaly"),
      status: "OPEN" as const,
    };
    return {
      ...partial,
      findingHash: this.anomalyHasher.hash(partial),
    };
  }
}

export class BottleneckDetectionService {
  private readonly hasher = new BottleneckFindingHasher();

  constructor(
    private readonly identities = new SequenceObservabilityIdentityGenerator(),
  ) {}

  detect(input: {
    projectId: string;
    windowFingerprint: string;
    reliabilityMetrics: readonly ReliabilityMetric[];
    latencyMetrics: readonly LatencyMetric[];
    runRecords: readonly RunTelemetryRecord[];
    detectedAt: string;
  }): BottleneckFinding[] {
    const findings: BottleneckFinding[] = [];
    const revision = input.reliabilityMetrics.find(
      (m) => m.metricName === "revisionRate",
    );
    if (
      revision?.rate !== undefined &&
      revision.rate > 0.3 &&
      isAuthoritativeDecisionEligible(revision.provenance.measurementQuality)
    ) {
      findings.push(this.bottleneck({
        projectId: input.projectId,
        category: "REVISION_LOOP",
        severity: "MATERIAL",
        windowFingerprint: input.windowFingerprint,
        affectedRunIds: input.runRecords
          .filter((r) => r.validationAttemptCount > 1)
          .map((r) => r.runId),
        metricRefs: [revision.provenance.metricId],
        evidenceRefs: [],
        explanation: `Revision rate ${revision.numerator}/${revision.denominator} indicates validation/planning loop pressure`,
        evidenceClass: "CONFIRMED",
        detectedAt: input.detectedAt,
      }));
    }

    const approval = input.latencyMetrics.find(
      (m) => m.metricName === "approvalWaitLatency",
    );
    if (
      approval &&
      approval.stats.meanMs !== undefined &&
      approval.stats.meanMs > 10_000 &&
      isAuthoritativeDecisionEligible(approval.provenance.measurementQuality)
    ) {
      findings.push(this.bottleneck({
        projectId: input.projectId,
        category: "APPROVAL_WAIT",
        severity: "WARNING",
        windowFingerprint: input.windowFingerprint,
        affectedRunIds: input.runRecords
          .filter((r) => r.approvalWaitMs !== undefined)
          .map((r) => r.runId),
        metricRefs: [approval.provenance.metricId],
        evidenceRefs: [],
        explanation: `Mean approval wait ${approval.stats.meanMs}ms exceeds operational threshold`,
        evidenceClass: "CONFIRMED",
        detectedAt: input.detectedAt,
      }));
    }

    return findings;
  }

  private bottleneck(
    input: Omit<BottleneckFinding, "bottleneckId" | "findingHash">,
  ): BottleneckFinding {
    const partial = {
      ...input,
      bottleneckId: this.identities.next("bottleneck"),
    };
    return {
      ...partial,
      findingHash: this.hasher.hash(partial),
    };
  }
}

export class OptimizationCandidateService {
  private readonly hasher = new OptimizationCandidateHasher();

  constructor(
    private readonly identities = new SequenceObservabilityIdentityGenerator(),
  ) {}

  generate(input: {
    projectId: string;
    anomalies: readonly AnomalyFinding[];
    bottlenecks: readonly BottleneckFinding[];
    reliabilityMetrics: readonly ReliabilityMetric[];
    createdAt: string;
  }): OptimizationCandidate[] {
    const candidates: OptimizationCandidate[] = [];

    for (const anomaly of input.anomalies) {
      const candidate = this.fromAnomaly(anomaly, input.createdAt);
      if (candidate) candidates.push(candidate);
    }

    for (const bottleneck of input.bottlenecks) {
      if (bottleneck.evidenceClass !== "CONFIRMED") continue;
      candidates.push(this.fromBottleneck(bottleneck, input.createdAt));
    }

    const expiry = input.reliabilityMetrics.find(
      (m) => m.metricName === "approvalExpiryRate",
    );
    if (
      expiry &&
      !expiry.insufficientSample &&
      expiry.rate !== undefined &&
      expiry.rate > 0.1 &&
      isAuthoritativeDecisionEligible(expiry.provenance.measurementQuality)
    ) {
      candidates.push(
        this.candidate({
          projectId: input.projectId,
          category: "AUTHORIZATION",
          suggestedChangeClass: "REVIEW_APPROVAL_WORKFLOW",
          problemStatement: `Approval expiry rate ${expiry.numerator}/${expiry.denominator} suggests workflow review`,
          supportingMetricRefs: [expiry.provenance.metricId],
          supportingAnomalyRefs: [],
          affectedRunIds: [],
          supportingMeasurementQuality: expiry.provenance.measurementQuality,
          createdAt: input.createdAt,
        }),
      );
    }

    return candidates;
  }

  private fromAnomaly(
    anomaly: AnomalyFinding,
    createdAt: string,
  ): OptimizationCandidate | null {
    const mapping: Partial<
      Record<
        AnomalyFinding["metricName"],
        OptimizationCandidate["suggestedChangeClass"]
      >
    > = {
      revisionRate: "REVIEW_PROMPT",
      inconclusiveRate: "REVIEW_VERIFICATION_BINDING",
      containmentRate: "REVIEW_CAPABILITY_RUNTIME",
      approvalWaitLatency: "REVIEW_APPROVAL_WORKFLOW",
    };
    const changeClass = mapping[anomaly.metricName];
    if (!changeClass) return null;
    if (!isAuthoritativeDecisionEligible(anomaly.measurementQuality)) {
      return null;
    }
    return this.candidate({
      projectId: anomaly.projectId,
      category:
        changeClass === "REVIEW_VERIFICATION_BINDING"
          ? "VERIFICATION"
          : changeClass === "REVIEW_CAPABILITY_RUNTIME"
            ? "CAPABILITY"
            : changeClass === "REVIEW_APPROVAL_WORKFLOW"
              ? "AUTHORIZATION"
              : "PLANNING",
      suggestedChangeClass: changeClass,
      problemStatement: `Anomaly on ${anomaly.metricName}: ${anomaly.classification}`,
      supportingMetricRefs: [],
      supportingAnomalyRefs: [anomaly.anomalyId],
      affectedRunIds: anomaly.affectedRunIds,
      supportingMeasurementQuality: anomaly.measurementQuality,
      createdAt,
    });
  }

  private fromBottleneck(
    bottleneck: BottleneckFinding,
    createdAt: string,
  ): OptimizationCandidate {
    const changeClass =
      bottleneck.category === "APPROVAL_WAIT"
        ? "REVIEW_APPROVAL_WORKFLOW"
        : bottleneck.category === "REVISION_LOOP"
          ? "REVIEW_PROCESS"
          : bottleneck.category === "VERIFICATION_INCONCLUSIVE"
            ? "REVIEW_VERIFICATION_BINDING"
            : "REVIEW_PROCESS";
    return this.candidate({
      projectId: bottleneck.projectId,
      category:
        changeClass === "REVIEW_APPROVAL_WORKFLOW"
          ? "AUTHORIZATION"
          : changeClass === "REVIEW_VERIFICATION_BINDING"
            ? "VERIFICATION"
            : "PROCESS",
      suggestedChangeClass: changeClass,
      problemStatement: bottleneck.explanation,
      supportingMetricRefs: bottleneck.metricRefs,
      supportingAnomalyRefs: [],
      affectedRunIds: bottleneck.affectedRunIds,
      supportingMeasurementQuality: "EXACT",
      createdAt,
    });
  }

  private candidate(
    input: Omit<
      OptimizationCandidate,
      "optimizationCandidateId" | "candidateHash" | "status" | "riskClass" | "expectedBenefitClass"
    >,
  ): OptimizationCandidate {
    const partial = {
      ...input,
      optimizationCandidateId: this.identities.next("opt-candidate"),
      riskClass: "MEDIUM" as const,
      expectedBenefitClass: "UNKNOWN" as const,
      status: "OPEN" as const,
    };
    return {
      ...partial,
      candidateHash: this.hasher.hash(partial),
    };
  }
}
