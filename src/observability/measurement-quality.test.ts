import { describe, expect, it } from "vitest";
import { createLocalObservabilityStack } from "../infrastructure/observability/local-stack.js";
import { createExecutionFriendlyPlanningModel } from "../execution/friendly-planning-model.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import { TelemetryNormalizationService } from "./normalization.js";
import {
  computeReliabilityMetrics,
  computeLatencyMetrics,
} from "./metrics-calculator.js";
import { ResourceAttributionService } from "./resource-attribution.js";
import { SLOEvaluationService, defaultProjectSlos } from "./slo-services.js";
import {
  AnomalyDetectionService,
  OptimizationCandidateService,
} from "./anomaly-services.js";
import { deriveHealthStatus } from "./integrity.js";
import { windowFingerprint, MetricProvenanceHasher } from "./hasher.js";
import type {
  MeasurementQuality,
  ReliabilityMetric,
  RunTelemetryRecord,
} from "../domain/observability/index.js";
import { isSloEligibleQuality } from "../domain/observability/quality.js";

async function completedRun() {
  const delivery = new FakeApprovalDeliveryService();
  const stack = createLocalObservabilityStack({
    approvalDelivery: delivery,
    planningModel: createExecutionFriendlyPlanningModel(),
  });
  const admitted = await stack.admission.admit(
    exampleAdmissionRequest({
      acceptanceCriteria: [
        "Local patch artifact prepared",
        "Registered test profile executed",
      ],
      constraints: ["Stay within authorized targets"],
      nonGoals: ["GitHub pull request creation"],
      requestedOutcome: "Prepare a local patch and run registered tests",
    }),
  );
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const runId = admitted.runId!;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  const routed = await stack.authorizationRouting.route(runId);
  const nonce = delivery.nonceFor(routed.approvalRequestId);
  if (!nonce) throw new Error("missing nonce");
  await stack.humanAuthorization.decide({
    approvalRequestId: routed.approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    submittedAt: stack.clock.nowIso(),
    decisionNonce: nonce,
  });
  await stack.execution.execute(runId);
  await stack.verification.verify(runId);
  await stack.memory.learn(runId);
  return { stack, runId };
}

function baseRun(
  overrides: Partial<RunTelemetryRecord> = {},
): RunTelemetryRecord {
  return {
    runTelemetryId: "tel-1",
    runId: "run-1",
    projectId: EXAMPLE_PROJECT_ID,
    objectiveId: "obj",
    terminalState: "COMPLETED",
    terminalOutcome: "VERIFIED_SUCCESS",
    phaseDurations: [],
    planningRevisionCount: 0,
    validationAttemptCount: 1,
    executionAttemptCount: 1,
    rollbackCount: 0,
    containmentOccurred: false,
    verificationAttemptCount: 1,
    learningProcessed: false,
    resourceSummary: [],
    trustClass: "AUTHORITATIVE_DERIVED",
    sourceRecordRefs: [],
    createdAt: "2026-08-17T00:00:00.000Z",
    telemetryHash: "hash",
    totalDurationQuality: "UNKNOWN",
    approvalWaitQuality: "UNKNOWN",
    ...overrides,
  };
}

function withQuality(
  metric: ReliabilityMetric,
  quality: MeasurementQuality,
): ReliabilityMetric {
  const { metricHash: _ignored, ...rest } = metric.provenance;
  void _ignored;
  const partial = {
    ...rest,
    measurementQuality: quality,
    trustClass:
      quality === "EXACT" || quality === "RECONSTRUCTED"
        ? ("AUTHORITATIVE_DERIVED" as const)
        : ("BEST_EFFORT_DERIVED" as const),
  };
  return {
    ...metric,
    provenance: {
      ...partial,
      metricHash: new MetricProvenanceHasher().hash(partial),
    },
  };
}

describe("Phase 10 measurement quality", () => {
  describe("timing", () => {
    it("does not manufacture ingestion duration from lastUpdatedAt proxy", async () => {
      const { stack, runId } = await completedRun();
      const { phaseTelemetry, runTelemetry } =
        await new TelemetryNormalizationService(stack.telemetrySources).normalizeRun(
          runId,
          stack.clock.nowIso(),
        );
      const ingestion = phaseTelemetry.find((p) => p.phase === "INGESTION");
      expect(ingestion?.startedAt).toBeUndefined();
      expect(ingestion?.durationMs).toBeUndefined();
      expect(ingestion?.durationQuality).toBe("UNKNOWN");
      expect(ingestion?.trustClass).toBe("BEST_EFFORT_DERIVED");
      const duration = runTelemetry.phaseDurations.find(
        (d) => d.phase === "INGESTION",
      );
      expect(duration?.durationMs).toBeUndefined();
      expect(duration?.measurementQuality).toBe("UNKNOWN");
    });

    it("records EXACT admission latency when createdAt and admittedAt exist", async () => {
      const { stack, runId } = await completedRun();
      const { phaseTelemetry } =
        await new TelemetryNormalizationService(stack.telemetrySources).normalizeRun(
          runId,
          stack.clock.nowIso(),
        );
      const admission = phaseTelemetry.find((p) => p.phase === "ADMISSION");
      expect(admission?.startedAtQuality).toBe("EXACT");
      expect(admission?.finishedAtQuality).toBe("EXACT");
      expect(admission?.durationQuality).toBe("EXACT");
      expect(admission?.durationMs).toBeDefined();
    });

    it("records EXACT approval wait from request createdAt and decision timestamp", async () => {
      const { stack, runId } = await completedRun();
      const { runTelemetry } =
        await new TelemetryNormalizationService(stack.telemetrySources).normalizeRun(
          runId,
          stack.clock.nowIso(),
        );
      expect(runTelemetry.approvalWaitQuality).toBe("EXACT");
      expect(runTelemetry.approvalWaitMs).toBeDefined();
    });

    it("excludes UNKNOWN phase duration from latency sample count", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b"],
      });
      const records = [
        baseRun({
          runId: "a",
          runTelemetryId: "tel-a",
          phaseDurations: [
            {
              phase: "INGESTION",
              durationMs: 5000,
              unknown: false,
              measurementQuality: "UNKNOWN",
              sourceRecordRefs: [],
            },
          ],
        }),
        baseRun({
          runId: "b",
          runTelemetryId: "tel-b",
          phaseDurations: [
            {
              phase: "INGESTION",
              durationMs: 8000,
              unknown: false,
              measurementQuality: "EXACT",
              sourceRecordRefs: ["ingestion:verified"],
            },
          ],
        }),
      ];
      const latency = computeLatencyMetrics(records, fp);
      const ingestion = latency.find((m) => m.metricName === "ingestionLatency");
      expect(ingestion?.stats.count).toBe(1);
      expect(ingestion?.provenance.coverage.candidateCount).toBe(2);
      expect(ingestion?.provenance.coverage.eligibleCount).toBe(1);
      expect(ingestion?.provenance.measurementQuality).toBe("EXACT");
    });

    it("does not treat missing timing as zero latency", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a"],
      });
      const latency = computeLatencyMetrics(
        [
          baseRun({
            phaseDurations: [
              {
                phase: "PLANNING",
                unknown: true,
                measurementQuality: "UNKNOWN",
                sourceRecordRefs: [],
              },
            ],
          }),
        ],
        fp,
      );
      const planning = latency.find((m) => m.metricName === "planningLatency");
      expect(planning?.stats.count).toBe(0);
      expect(planning?.stats.minMs).toBeUndefined();
    });
  });

  describe("resource completeness", () => {
    it("labels reconstructed execution resources PARTIAL, not complete total usage", async () => {
      const { stack, runId } = await completedRun();
      const normalized = await new TelemetryNormalizationService(
        stack.telemetrySources,
      ).normalizeRun(runId, stack.clock.nowIso());
      const executionSummary = normalized.runTelemetry.resourceSummary.find(
        (s) => s.category === "EXECUTION",
      );
      expect(executionSummary?.measurementQuality).toBe("PARTIAL");
      expect(executionSummary?.usageCompleteness).toBe("PARTIAL");
      const attr = new ResourceAttributionService().aggregate(
        EXAMPLE_PROJECT_ID,
        "fp",
        [normalized.runTelemetry],
        normalized.phaseTelemetry,
      );
      const execution = attr.find((a) => a.category === "EXECUTION");
      expect(execution?.measurementQuality).toBe("PARTIAL");
      expect(execution?.usageCompleteness).toBe("PARTIAL");
      const planning = attr.find((a) => a.category === "PLANNING");
      expect(planning?.measurementQuality).toBe("EXACT");
      expect(planning?.usageCompleteness).toBe("COMPLETE");
    });
  });

  describe("SLO eligibility", () => {
    it("EXACT eligible metric can PASS", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) =>
        baseRun({ runId, runTelemetryId: `tel-${runId}` }),
      );
      const metrics = computeReliabilityMetrics(records, fp);
      const slo = defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!;
      const evaluation = new SLOEvaluationService().evaluate(
        slo,
        metrics,
        fp,
        "2026-08-17T00:00:00.000Z",
      );
      expect(metrics[0]?.provenance.measurementQuality).toBe("EXACT");
      expect(evaluation.status).toBe("PASS");
    });

    it("permitted RECONSTRUCTED metric can FAIL", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) =>
        baseRun({
          runId,
          runTelemetryId: `tel-${runId}`,
          terminalOutcome: "INCONCLUSIVE",
          terminalState: "FAILED",
        }),
      );
      const metrics = computeReliabilityMetrics(records, fp).map((m) =>
        withQuality(m, "RECONSTRUCTED"),
      );
      const slo = defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!;
      const evaluation = new SLOEvaluationService().evaluate(
        slo,
        metrics,
        fp,
        "2026-08-17T00:00:00.000Z",
      );
      expect(evaluation.status).toBe("FAIL");
      expect(evaluation.measurementQuality).toBe("RECONSTRUCTED");
    });

    it("PARTIAL metric yields INSUFFICIENT_DATA and cannot PASS or FAIL", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) =>
        baseRun({ runId, runTelemetryId: `tel-${runId}` }),
      );
      const metrics = computeReliabilityMetrics(records, fp).map((m) =>
        withQuality(m, "PARTIAL"),
      );
      const slo = defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!;
      const evaluation = new SLOEvaluationService().evaluate(
        slo,
        metrics,
        fp,
        "2026-08-17T00:00:00.000Z",
      );
      expect(evaluation.status).toBe("INSUFFICIENT_DATA");
      expect(evaluation.insufficientReason).toBe("INCOMPLETE_SOURCE_COVERAGE");
      expect(isSloEligibleQuality("PARTIAL").eligible).toBe(false);
    });

    it("UNKNOWN metric yields INSUFFICIENT_DATA", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) =>
        baseRun({ runId, runTelemetryId: `tel-${runId}` }),
      );
      const metrics = computeReliabilityMetrics(records, fp).map((m) =>
        withQuality(m, "UNKNOWN"),
      );
      const slo = defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!;
      const evaluation = new SLOEvaluationService().evaluate(
        slo,
        metrics,
        fp,
        "2026-08-17T00:00:00.000Z",
      );
      expect(evaluation.status).toBe("INSUFFICIENT_DATA");
      expect(evaluation.insufficientReason).toBe(
        "INSUFFICIENT_MEASUREMENT_QUALITY",
      );
    });
  });

  describe("health", () => {
    it("does not classify HEALTHY when a critical SLO cannot be measured", () => {
      const status = deriveHealthStatus({
        sloEvaluations: [
          { sloId: "critical", status: "INSUFFICIENT_DATA" },
          { sloId: "warning", status: "PASS" },
        ],
        sloDefinitions: [
          { sloId: "critical", severity: "CRITICAL", enabled: true },
          { sloId: "warning", severity: "WARNING", enabled: true },
        ],
        anomalies: [],
      });
      expect(status).toBe("INSUFFICIENT_DATA");
    });

    it("classifies CRITICAL on genuine critical SLO failure", () => {
      const status = deriveHealthStatus({
        sloEvaluations: [{ sloId: "critical", status: "FAIL" }],
        sloDefinitions: [{ sloId: "critical", severity: "CRITICAL", enabled: true }],
        anomalies: [],
      });
      expect(status).toBe("CRITICAL");
    });

    it("classifies HEALTHY when all sufficiently sampled enabled SLOs pass", () => {
      const status = deriveHealthStatus({
        sloEvaluations: [
          { sloId: "critical", status: "PASS" },
          { sloId: "warning", status: "PASS" },
        ],
        sloDefinitions: [
          { sloId: "critical", severity: "CRITICAL", enabled: true },
          { sloId: "warning", severity: "WARNING", enabled: true },
        ],
        anomalies: [],
      });
      expect(status).toBe("HEALTHY");
    });
  });

  describe("anomaly and optimization quality gates", () => {
    it("does not create an authoritative latency anomaly from low-quality measurements", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a"],
      });
      const records = [
        baseRun({
          approvalWaitMs: 120_000,
          approvalWaitQuality: "UNKNOWN",
        }),
      ];
      const latency = computeLatencyMetrics(records, fp);
      const anomalies = new AnomalyDetectionService(undefined, {
        approvalWaitP95Ms: 1,
      }).detect({
        projectId: EXAMPLE_PROJECT_ID,
        windowFingerprint: fp,
        reliabilityMetrics: computeReliabilityMetrics(records, fp),
        latencyMetrics: latency,
        runRecords: records,
        detectedAt: "2026-08-17T00:00:00.000Z",
      });
      expect(
        anomalies.some((a) => a.metricName === "approvalWaitLatency"),
      ).toBe(false);
    });

    it("creates an anomaly from sufficient exact approval-wait samples", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c", "d", "e"],
      });
      const records = ["a", "b", "c", "d", "e"].map((runId, i) =>
        baseRun({
          runId,
          runTelemetryId: `tel-${runId}`,
          approvalWaitMs: 120_000 + i,
          approvalWaitQuality: "EXACT",
        }),
      );
      const latency = computeLatencyMetrics(records, fp);
      const anomalies = new AnomalyDetectionService(undefined, {
        approvalWaitP95Ms: 1_000,
      }).detect({
        projectId: EXAMPLE_PROJECT_ID,
        windowFingerprint: fp,
        reliabilityMetrics: computeReliabilityMetrics(records, fp),
        latencyMetrics: latency,
        runRecords: records,
        detectedAt: "2026-08-17T00:00:00.000Z",
      });
      expect(
        anomalies.some((a) => a.metricName === "approvalWaitLatency"),
      ).toBe(true);
    });

    it("does not create REVIEW_* from a PARTIAL metric alone", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) =>
        baseRun({
          runId,
          runTelemetryId: `tel-${runId}`,
          terminalOutcome: "EXPIRED",
          terminalState: "EXPIRED",
        }),
      );
      const metrics = computeReliabilityMetrics(records, fp).map((m) =>
        withQuality(m, "PARTIAL"),
      );
      const candidates = new OptimizationCandidateService().generate({
        projectId: EXAMPLE_PROJECT_ID,
        anomalies: [],
        bottlenecks: [],
        reliabilityMetrics: metrics,
        createdAt: "2026-08-17T00:00:00.000Z",
      });
      expect(candidates).toHaveLength(0);
    });

    it("creates REVIEW_* from a sufficient EXACT metric and retains quality", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) =>
        baseRun({
          runId,
          runTelemetryId: `tel-${runId}`,
          terminalOutcome: "EXPIRED",
          terminalState: "EXPIRED",
        }),
      );
      const metrics = computeReliabilityMetrics(records, fp);
      const candidates = new OptimizationCandidateService().generate({
        projectId: EXAMPLE_PROJECT_ID,
        anomalies: [],
        bottlenecks: [],
        reliabilityMetrics: metrics,
        createdAt: "2026-08-17T00:00:00.000Z",
      });
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0]?.suggestedChangeClass.startsWith("REVIEW_")).toBe(
        true,
      );
      expect(candidates[0]?.supportingMeasurementQuality).toBe("EXACT");
      expect(candidates[0]?.supportingMetricRefs.length).toBeGreaterThan(0);
    });
  });

  describe("coverage and hashing", () => {
    it("exposes eligible vs candidate sample counts", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = [
        baseRun({
          runId: "a",
          runTelemetryId: "tel-a",
          approvalWaitMs: 1000,
          approvalWaitQuality: "EXACT",
        }),
        baseRun({
          runId: "b",
          runTelemetryId: "tel-b",
          approvalWaitMs: 2000,
          approvalWaitQuality: "UNKNOWN",
        }),
        baseRun({ runId: "c", runTelemetryId: "tel-c" }),
      ];
      const latency = computeLatencyMetrics(records, fp);
      const approval = latency.find((m) => m.metricName === "approvalWaitLatency");
      expect(approval?.provenance.coverage.candidateCount).toBe(3);
      expect(approval?.provenance.coverage.eligibleCount).toBe(1);
      expect(approval?.stats.count).toBe(1);
    });

    it("changes metric hash when quality changes even if the numeric value is identical", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a"],
      });
      const records = [baseRun({ runId: "a", runTelemetryId: "tel-a" })];
      const exact = computeReliabilityMetrics(records, fp)[0]!;
      const partial = withQuality(exact, "PARTIAL");
      expect(exact.rate).toBe(partial.rate);
      expect(exact.provenance.metricHash).not.toBe(partial.provenance.metricHash);
    });

    it("changes metric hash when coverage changes", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a"],
      });
      const one = computeLatencyMetrics(
        [
          baseRun({
            runId: "a",
            runTelemetryId: "tel-a",
            approvalWaitMs: 1000,
            approvalWaitQuality: "EXACT",
          }),
        ],
        fp,
      ).find((m) => m.metricName === "approvalWaitLatency")!;
      const two = computeLatencyMetrics(
        [
          baseRun({
            runId: "a",
            runTelemetryId: "tel-a",
            approvalWaitMs: 1000,
            approvalWaitQuality: "EXACT",
          }),
          baseRun({
            runId: "b",
            runTelemetryId: "tel-b",
            approvalWaitQuality: "UNKNOWN",
          }),
        ],
        fp,
      ).find((m) => m.metricName === "approvalWaitLatency")!;
      expect(one.stats.meanMs).toBe(two.stats.meanMs);
      expect(one.provenance.metricHash).not.toBe(two.provenance.metricHash);
    });
  });
});
