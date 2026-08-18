import type { SLODefinition, SLOEvaluation } from "../domain/observability/index.js";
import type { ReliabilityMetric } from "../domain/observability/metrics.js";
import { isSloEligibleQuality } from "../domain/observability/quality.js";
import { SLOEvaluationHasher } from "./hasher.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";

export class SLORegistry {
  private readonly definitions = new Map<string, SLODefinition>();

  register(definition: SLODefinition): void {
    this.definitions.set(definition.sloId, definition);
  }

  getById(sloId: string): SLODefinition | null {
    return this.definitions.get(sloId) ?? null;
  }

  listByProject(projectId: string): readonly SLODefinition[] {
    return [...this.definitions.values()].filter(
      (d) => d.projectId === projectId,
    );
  }

  listActive(projectId: string): readonly SLODefinition[] {
    return this.listByProject(projectId).filter((d) => d.enabled);
  }
}

export function defaultProjectSlos(projectId: string): SLODefinition[] {
  return [
    {
      sloId: `${projectId}:verified-success`,
      projectId,
      metricName: "verifiedSuccessRate",
      calculationVersion: "verifiedSuccessRate/v1",
      operator: "GTE",
      target: 0.9,
      minimumSampleSize: 3,
      windowKind: "LAST_N_RUNS",
      lastN: 10,
      severity: "CRITICAL",
      enabled: true,
      version: 1,
    },
    {
      sloId: `${projectId}:containment`,
      projectId,
      metricName: "containmentRate",
      calculationVersion: "containmentRate/v1",
      operator: "LTE",
      target: 0.05,
      minimumSampleSize: 3,
      windowKind: "LAST_N_RUNS",
      lastN: 10,
      severity: "WARNING",
      enabled: true,
      version: 1,
    },
    {
      sloId: `${projectId}:inconclusive`,
      projectId,
      metricName: "inconclusiveRate",
      calculationVersion: "inconclusiveRate/v1",
      operator: "LTE",
      target: 0.1,
      minimumSampleSize: 3,
      windowKind: "LAST_N_RUNS",
      lastN: 10,
      severity: "WARNING",
      enabled: true,
      version: 1,
    },
  ];
}

const RECONSTRUCTION_PERMITTED = new Set([
  "verifiedSuccessRate",
  "containmentRate",
  "inconclusiveRate",
  "runCompletionRate",
  "partialSuccessRate",
  "verificationFailureRate",
  "blockedRate",
  "approvalRejectionRate",
  "approvalExpiryRate",
  "executionFailureRate",
  "rollbackRate",
  "revisionRate",
  "validationBlockRate",
  "approvalWaitLatency",
  "totalRunLatency",
]);

export class SLOEvaluationService {
  private readonly hasher = new SLOEvaluationHasher();

  constructor(
    private readonly identities = new SequenceObservabilityIdentityGenerator(),
  ) {}

  evaluate(
    slo: SLODefinition,
    reliabilityMetrics: readonly ReliabilityMetric[],
    windowFingerprint: string,
    evaluatedAt: string,
  ): SLOEvaluation {
    const metric = reliabilityMetrics.find((m) => m.metricName === slo.metricName);
    const sampleSize = metric?.denominator ?? 0;
    const quality = metric?.provenance.measurementQuality ?? "UNKNOWN";
    const eligibility = isSloEligibleQuality(quality, {
      permitsReconstruction: RECONSTRUCTION_PERMITTED.has(slo.metricName),
    });

    if (!eligibility.eligible) {
      const partial = {
        evaluationId: this.identities.next("slo-eval"),
        sloId: slo.sloId,
        projectId: slo.projectId,
        status: "INSUFFICIENT_DATA" as const,
        target: slo.target,
        sampleSize,
        windowFingerprint,
        supportingMetricRefs: metric ? [metric.provenance.metricId] : [],
        measurementQuality: quality,
        insufficientReason: eligibility.reason,
      };
      return {
        ...partial,
        evaluatedAt,
        evaluationHash: this.hasher.hash(partial),
      };
    }

    if (sampleSize < slo.minimumSampleSize) {
      const partial = {
        evaluationId: this.identities.next("slo-eval"),
        sloId: slo.sloId,
        projectId: slo.projectId,
        status: "INSUFFICIENT_DATA" as const,
        target: slo.target,
        sampleSize,
        windowFingerprint,
        supportingMetricRefs: metric ? [metric.provenance.metricId] : [],
        measurementQuality: quality,
        insufficientReason: "INSUFFICIENT_SAMPLE" as const,
      };
      return {
        ...partial,
        evaluatedAt,
        evaluationHash: this.hasher.hash(partial),
      };
    }

    const observed = metric?.rate;
    let status: SLOEvaluation["status"] = "INSUFFICIENT_DATA";
    if (observed !== undefined) {
      status =
        slo.operator === "GTE"
          ? observed >= slo.target
            ? "PASS"
            : "FAIL"
          : observed <= slo.target
            ? "PASS"
            : "FAIL";
    }

    const partial = {
      evaluationId: this.identities.next("slo-eval"),
      sloId: slo.sloId,
      projectId: slo.projectId,
      status,
      observedValue: observed,
      target: slo.target,
      sampleSize,
      windowFingerprint,
      supportingMetricRefs: metric ? [metric.provenance.metricId] : [],
      measurementQuality: quality,
      ...(status === "INSUFFICIENT_DATA"
        ? { insufficientReason: "INSUFFICIENT_SAMPLE" as const }
        : {}),
    };
    return {
      ...partial,
      evaluatedAt,
      evaluationHash: this.hasher.hash(partial),
    };
  }
}
