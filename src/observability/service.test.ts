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
import { RunTelemetryHasher } from "./hasher.js";
import {
  computeReliabilityMetrics,
  computeLatencyMetrics,
} from "./metrics-calculator.js";
import { ResourceAttributionService } from "./resource-attribution.js";
import {
  FailureClassificationService,
  FailureAttributionService,
} from "./failure-services.js";
import { SLOEvaluationService, SLORegistry, defaultProjectSlos } from "./slo-services.js";
import { AnomalyDetectionService } from "./anomaly-services.js";
import { TelemetryIntegrityService, deriveHealthStatus } from "./integrity.js";
import { windowFingerprint } from "./hasher.js";
import { assertNoSensitiveTelemetryPayload } from "./intelligence.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { EXAMPLE_POLICY_BUNDLE } from "../control-plane/fixtures.js";

async function completedRun(): Promise<{
  stack: ReturnType<typeof createLocalObservabilityStack>;
  runId: string;
}> {
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
  const verified = await stack.verification.verify(runId);
  expect(verified.outcome).toBe("VERIFIED_SUCCESS");
  await stack.memory.learn(runId);
  return { stack, runId };
}

describe("Phase 10 Observability", () => {
  describe("telemetry normalization", () => {
    it("normalizes terminal run with deterministic hash", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const now = stack.clock.nowIso();
      const first = await normalizer.normalizeRun(runId, now);
      const second = await normalizer.normalizeRun(runId, now);
      expect(first.runTelemetry.runTelemetryId).toBe(`run-tel:${runId}`);
      expect(first.runTelemetry.telemetryHash).toBe(
        second.runTelemetry.telemetryHash,
      );
      expect(first.runTelemetry.terminalOutcome).toBe("VERIFIED_SUCCESS");
      expect(first.runTelemetry.learningProcessed).toBe(true);
      expect(first.phaseTelemetry.length).toBe(8);
    });

    it("leaves missing optional timestamps absent", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const { runTelemetry } = await normalizer.normalizeRun(
        runId,
        stack.clock.nowIso(),
      );
      const learningPhase = runTelemetry.phaseDurations.find(
        (p) => p.phase === "LEARNING",
      );
      expect(learningPhase?.unknown === true || learningPhase?.durationMs !== undefined).toBe(
        true,
      );
    });

    it("fails integrity when source run state mismatches", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const { runTelemetry } = await normalizer.normalizeRun(
        runId,
        stack.clock.nowIso(),
      );
      const tampered = {
        ...runTelemetry,
        terminalState: "FAILED" as const,
      };
      const integrity = new TelemetryIntegrityService();
      await expect(
        integrity.verifyAgainstSources(tampered, stack.telemetrySources),
      ).rejects.toMatchObject({ code: "TELEMETRY_INTEGRITY_FAILED" });
    });
  });

  describe("metrics", () => {
    it("exposes numerator and denominator for reliability metrics", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const { runTelemetry } = await normalizer.normalizeRun(
        runId,
        stack.clock.nowIso(),
      );
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: [runId],
        lastN: 1,
      });
      const metrics = computeReliabilityMetrics([runTelemetry], fp);
      const verified = metrics.find((m) => m.metricName === "verifiedSuccessRate");
      expect(verified?.numerator).toBe(1);
      expect(verified?.denominator).toBe(1);
      expect(verified?.rate).toBe(1);
      expect(verified?.provenance.metricHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("returns insufficient sample for empty window", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: [],
        lastN: 10,
      });
      const metrics = computeReliabilityMetrics([], fp);
      const verified = metrics.find((m) => m.metricName === "verifiedSuccessRate");
      expect(verified?.insufficientSample).toBe(true);
      expect(verified?.rate).toBeUndefined();
    });

    it("computes deterministic p95 when sample sufficient", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["r1"],
        lastN: 1,
      });
      const records = Array.from({ length: 10 }, (_, i) => ({
        runTelemetryId: `tel-${i}`,
        runId: `run-${i}`,
        projectId: EXAMPLE_PROJECT_ID,
        objectiveId: "obj",
        terminalState: "COMPLETED" as const,
        terminalOutcome: "VERIFIED_SUCCESS" as const,
        approvalWaitMs: (i + 1) * 1000,
        approvalWaitQuality: "EXACT" as const,
        totalDurationQuality: "UNKNOWN" as const,
        phaseDurations: [],
        planningRevisionCount: 0,
        validationAttemptCount: 1,
        executionAttemptCount: 1,
        rollbackCount: 0,
        containmentOccurred: false,
        verificationAttemptCount: 1,
        learningProcessed: false,
        resourceSummary: [],
        trustClass: "AUTHORITATIVE_DERIVED" as const,
        sourceRecordRefs: [],
        createdAt: "2026-08-17T00:00:00.000Z",
        telemetryHash: "abc",
      }));
      const latency = computeLatencyMetrics(records, fp);
      const approval = latency.find((m) => m.metricName === "approvalWaitLatency");
      expect(approval?.stats.count).toBe(10);
      expect(approval?.stats.p95Ms).toBeDefined();
    });
  });

  describe("resource attribution", () => {
    it("keeps planning and execution resources separate", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const normalized = await normalizer.normalizeRun(
        runId,
        stack.clock.nowIso(),
      );
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: [runId],
      });
      const attr = new ResourceAttributionService().aggregate(
        EXAMPLE_PROJECT_ID,
        fp,
        [normalized.runTelemetry],
        normalized.phaseTelemetry,
      );
      const planning = attr.find((a) => a.category === "PLANNING");
      const execution = attr.find((a) => a.category === "EXECUTION");
      expect(planning).toBeDefined();
      expect(execution).toBeDefined();
      expect(planning!.totalTokens).toBeGreaterThanOrEqual(0);
      expect(execution!.executionMinutes).toBeGreaterThanOrEqual(0);
    });
  });

  describe("SLO evaluation", () => {
    it("returns INSUFFICIENT_DATA below minimum sample", () => {
      const registry = new SLORegistry();
      const slo = defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!;
      registry.register(slo);
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["r1"],
        lastN: 1,
      });
      const metrics = computeReliabilityMetrics(
        [],
        fp,
      );
      const evaluation = new SLOEvaluationService().evaluate(
        slo,
        metrics,
        fp,
        "2026-08-17T00:00:00.000Z",
      );
      expect(evaluation.status).toBe("INSUFFICIENT_DATA");
    });

    it("SLORegistry is separate from PolicyRegistry", async () => {
      const sloRegistry = new SLORegistry();
      const policyRegistry = new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], {
        clock: { nowIso: () => "2026-08-17T00:00:00.000Z" },
      });
      sloRegistry.register(defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!);
      expect(sloRegistry.listByProject(EXAMPLE_PROJECT_ID).length).toBe(1);
      expect(
        await policyRegistry.getBundleById(EXAMPLE_POLICY_BUNDLE.policyBundleId),
      ).toBeTruthy();
    });
  });

  describe("anomaly detection", () => {
    it("detects repeated error pattern across runs", () => {
      const fp = windowFingerprint({
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        includedRunIds: ["a", "b", "c"],
      });
      const records = ["a", "b", "c"].map((runId) => ({
        runTelemetryId: `tel-${runId}`,
        runId,
        projectId: EXAMPLE_PROJECT_ID,
        objectiveId: "obj",
        terminalState: "FAILED" as const,
        terminalOutcome: "UNKNOWN" as const,
        failureStage: "EXECUTION" as const,
        phaseDurations: [],
        planningRevisionCount: 0,
        validationAttemptCount: 1,
        executionAttemptCount: 1,
        rollbackCount: 0,
        containmentOccurred: false,
        verificationAttemptCount: 0,
        learningProcessed: false,
        resourceSummary: [],
        trustClass: "AUTHORITATIVE_DERIVED" as const,
        sourceRecordRefs: [],
        createdAt: "2026-08-17T00:00:00.000Z",
        telemetryHash: runId,
      }));
      const reliability = computeReliabilityMetrics(records, fp);
      const anomalies = new AnomalyDetectionService(undefined, {
        repeatedErrorMinRuns: 3,
      }).detect({
        projectId: EXAMPLE_PROJECT_ID,
        windowFingerprint: fp,
        reliabilityMetrics: reliability,
        latencyMetrics: [],
        runRecords: records,
        detectedAt: "2026-08-17T00:00:00.000Z",
      });
      expect(anomalies.some((a) => a.classification === "REPEATED_ERROR")).toBe(
        true,
      );
    });
  });

  describe("ObservabilityService rebuild", () => {
    it("produces health snapshot for completed run", async () => {
      const { stack } = await completedRun();
      const result = await stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 10,
      });
      expect(result.healthSnapshotId).toBeTruthy();
      expect(["HEALTHY", "DEGRADED", "CRITICAL", "INSUFFICIENT_DATA"]).toContain(
        result.healthStatus,
      );
      const snapshot = await stack.observability.getLatestHealth(
        EXAMPLE_PROJECT_ID,
      );
      expect(snapshot?.reliabilityMetrics.length).toBeGreaterThan(0);
    });

    it("reuses snapshot fingerprint when sources unchanged", async () => {
      const { stack } = await completedRun();
      const first = await stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 10,
      });
      const second = await stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 10,
      });
      expect(first.windowFingerprint).toBe(second.windowFingerprint);
      expect(first.healthSnapshotId).toBe(second.healthSnapshotId);
    });
  });

  describe("run trace and funnel", () => {
    it("produces causal trace with exact IDs", async () => {
      const { stack, runId } = await completedRun();
      const trace = await stack.observability.trace.trace(runId);
      expect(trace.runId).toBe(runId);
      expect(trace.stages.some((s) => s.phase === "PLANNING" && s.reached)).toBe(
        true,
      );
      expect(trace.stages.some((s) => s.phase === "VERIFICATION" && s.reached)).toBe(
        true,
      );
      expect(trace.traceHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it("reports funnel stage counts", async () => {
      const { stack, runId } = await completedRun();
      await stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 10,
      });
      const snapshot = await stack.observability.getLatestHealth(
        EXAMPLE_PROJECT_ID,
      );
      const funnel = await stack.observability.funnel.report(
        EXAMPLE_PROJECT_ID,
        snapshot!.windowFingerprint,
        [runId],
      );
      expect(funnel.stageCounts.ADMITTED).toBeGreaterThanOrEqual(1);
      expect(funnel.stageCounts.COMPLETED).toBeGreaterThanOrEqual(1);
    });
  });

  describe("health status", () => {
    it("returns CRITICAL when critical SLO fails", () => {
      const status = deriveHealthStatus({
        sloEvaluations: [{ sloId: "s1", status: "FAIL" }],
        sloDefinitions: [{ sloId: "s1", severity: "CRITICAL" }],
        anomalies: [],
      });
      expect(status).toBe("CRITICAL");
    });

    it("returns INSUFFICIENT_DATA when no evaluated SLOs", () => {
      const status = deriveHealthStatus({
        sloEvaluations: [{ sloId: "s1", status: "INSUFFICIENT_DATA" }],
        sloDefinitions: [{ sloId: "s1", severity: "WARNING" }],
        anomalies: [],
      });
      expect(status).toBe("INSUFFICIENT_DATA");
    });
  });

  describe("authority separation", () => {
    it("optimization rebuild does not mutate capability registry", async () => {
      const { stack } = await completedRun();
      const capabilityBefore = (await stack.capabilities.list()).length;

      await stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 10,
      });

      expect((await stack.capabilities.list()).length).toBe(capabilityBefore);

      const candidates =
        await stack.observability.optimizationCandidates.listByProject(
          EXAMPLE_PROJECT_ID,
        );
      for (const candidate of candidates) {
        expect(candidate.suggestedChangeClass.startsWith("REVIEW_")).toBe(true);
      }
    });

    it("standalone registries remain independent from SLO registry", async () => {
      const policyRegistry = new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], {
        clock: { nowIso: () => "2026-08-17T00:00:00.000Z" },
      });
      const capabilityRegistry = new InMemoryCapabilityRegistry([]);
      const budgetRegistry = new InMemoryResourceBudgetRegistry([]);
      const sloRegistry = new SLORegistry();
      sloRegistry.register(defaultProjectSlos(EXAMPLE_PROJECT_ID)[0]!);
      expect(
        await policyRegistry.getBundleById(EXAMPLE_POLICY_BUNDLE.policyBundleId),
      ).toBeTruthy();
      expect((await capabilityRegistry.list()).length).toBe(0);
      expect((await budgetRegistry.list()).length).toBe(0);
      expect(sloRegistry.listByProject(EXAMPLE_PROJECT_ID).length).toBe(1);
    });
  });

  describe("data minimization", () => {
    it("does not copy nonce or unbounded payloads into telemetry", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const { runTelemetry } = await normalizer.normalizeRun(
        runId,
        stack.clock.nowIso(),
      );
      const serialized = JSON.stringify(runTelemetry);
      expect(serialized).not.toContain("decisionNonce");
      expect(serialized.length).toBeLessThan(50_000);
      assertNoSensitiveTelemetryPayload(runTelemetry);
    });
  });

  describe("failure classification", () => {
    it("preserves original error code category mapping", () => {
      const classifier = new FailureClassificationService();
      expect(classifier.classify("VALIDATION_RESOURCE_EXCEEDED")).toBe(
        "VALIDATION",
      );
      expect(classifier.classify("EXECUTION_STEP_FAILED")).toBe("EXECUTION");
    });
  });

  describe("precedent effectiveness", () => {
    it("includes correlation disclaimer and does not mutate precedent trust", async () => {
      const { stack, runId } = await completedRun();
      const before = await stack.promotedPrecedents.listByProject(
        EXAMPLE_PROJECT_ID,
      );
      const observations = await stack.observability
        .getIntelligence()
        .precedent.observe(stack.telemetrySources, EXAMPLE_PROJECT_ID);
      const after = await stack.promotedPrecedents.listByProject(
        EXAMPLE_PROJECT_ID,
      );
      expect(after.length).toBe(before.length);
      for (const obs of observations) {
        expect(obs.correlationDisclaimer).toContain("CORRELATION");
      }
      void runId;
    });
  });

  describe("project isolation", () => {
    it("scopes metrics to project runs only", async () => {
      const { stack, runId } = await completedRun();
      const result = await stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 10,
      });
      const telemetry = await stack.observability.runTelemetry.getByRun(runId);
      expect(telemetry?.projectId).toBe(EXAMPLE_PROJECT_ID);
      expect(result.projectId).toBe(EXAMPLE_PROJECT_ID);
    });
  });

  describe("hasher determinism", () => {
    it("recomputes run telemetry hash deterministically", async () => {
      const { stack, runId } = await completedRun();
      const normalizer = new TelemetryNormalizationService(stack.telemetrySources);
      const { runTelemetry } = await normalizer.normalizeRun(
        runId,
        stack.clock.nowIso(),
      );
      const hasher = new RunTelemetryHasher();
      const { telemetryHash, createdAt, ...partial } = runTelemetry;
      void telemetryHash;
      void createdAt;
      const recomputed = hasher.hash(partial);
      expect(recomputed).toBe(runTelemetry.telemetryHash);
    });
  });
});
