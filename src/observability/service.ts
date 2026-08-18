import type {
  ObservabilityResult,
  SystemHealthSnapshot,
  TelemetryQualityFinding,
} from "../domain/observability/index.js";
import type { BuildWindowRequest } from "./window.js";
import { buildMetricWindow, buildBaselineWindow } from "./window.js";
import { TelemetryNormalizationService } from "./normalization.js";
import { TelemetryIntegrityService, deriveHealthStatus } from "./integrity.js";
import {
  computeReliabilityMetrics,
  computeLatencyMetrics,
} from "./metrics-calculator.js";
import { ResourceAttributionService } from "./resource-attribution.js";
import {
  SLORegistry,
  SLOEvaluationService,
  defaultProjectSlos,
} from "./slo-services.js";
import {
  AnomalyDetectionService,
  BottleneckDetectionService,
  OptimizationCandidateService,
} from "./anomaly-services.js";
import { HealthSnapshotHasher } from "./hasher.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";
import type { TelemetrySources } from "./sources.js";
import {
  InMemoryRunTelemetryRepository,
  InMemoryPhaseTelemetryRepository,
  InMemorySystemHealthSnapshotRepository,
  InMemorySLOEvaluationRepository,
  InMemoryAnomalyFindingRepository,
  InMemoryOptimizationCandidateRepository,
  InMemoryObservabilityLedger,
} from "./repositories.js";
import { ObservabilityError } from "./errors.js";
import { IntelligenceAggregator } from "./intelligence.js";
import { RunTraceService, RunFunnelService } from "./trace-funnel.js";

export interface ObservabilityServiceDeps {
  sources: TelemetrySources;
  clock: { nowIso(): string };
  runTelemetry?: InMemoryRunTelemetryRepository;
  phaseTelemetry?: InMemoryPhaseTelemetryRepository;
  snapshots?: InMemorySystemHealthSnapshotRepository;
  sloEvaluations?: InMemorySLOEvaluationRepository;
  anomalies?: InMemoryAnomalyFindingRepository;
  optimizationCandidates?: InMemoryOptimizationCandidateRepository;
  ledger?: InMemoryObservabilityLedger;
  sloRegistry?: SLORegistry;
  identities?: SequenceObservabilityIdentityGenerator;
}

export class ObservabilityService {
  private readonly normalization: TelemetryNormalizationService;
  private readonly integrity = new TelemetryIntegrityService();
  private readonly resourceAttribution = new ResourceAttributionService();
  private readonly sloEvaluation = new SLOEvaluationService();
  private readonly anomalyDetection = new AnomalyDetectionService();
  private readonly bottleneckDetection = new BottleneckDetectionService();
  private readonly optimization = new OptimizationCandidateService();
  private readonly snapshotHasher = new HealthSnapshotHasher();
  private readonly intelligence = new IntelligenceAggregator();
  readonly trace: RunTraceService;
  readonly funnel: RunFunnelService;

  readonly runTelemetry: InMemoryRunTelemetryRepository;
  readonly phaseTelemetry: InMemoryPhaseTelemetryRepository;
  readonly snapshots: InMemorySystemHealthSnapshotRepository;
  readonly sloEvaluations: InMemorySLOEvaluationRepository;
  readonly anomalies: InMemoryAnomalyFindingRepository;
  readonly optimizationCandidates: InMemoryOptimizationCandidateRepository;
  readonly ledger: InMemoryObservabilityLedger;
  readonly sloRegistry: SLORegistry;
  private readonly identities: SequenceObservabilityIdentityGenerator;
  private readonly sources: TelemetrySources;
  private readonly clock: { nowIso(): string };

  constructor(deps: ObservabilityServiceDeps) {
    this.sources = deps.sources;
    this.clock = deps.clock;
    this.identities =
      deps.identities ?? new SequenceObservabilityIdentityGenerator();
    this.normalization = new TelemetryNormalizationService(
      deps.sources,
      this.identities,
    );
    this.runTelemetry =
      deps.runTelemetry ?? new InMemoryRunTelemetryRepository();
    this.phaseTelemetry =
      deps.phaseTelemetry ?? new InMemoryPhaseTelemetryRepository();
    this.snapshots =
      deps.snapshots ?? new InMemorySystemHealthSnapshotRepository();
    this.sloEvaluations =
      deps.sloEvaluations ?? new InMemorySLOEvaluationRepository();
    this.anomalies =
      deps.anomalies ?? new InMemoryAnomalyFindingRepository();
    this.optimizationCandidates =
      deps.optimizationCandidates ??
      new InMemoryOptimizationCandidateRepository();
    this.ledger = deps.ledger ?? new InMemoryObservabilityLedger();
    this.sloRegistry = deps.sloRegistry ?? new SLORegistry();
    this.trace = new RunTraceService(deps.sources);
    this.funnel = new RunFunnelService(deps.sources);

    if (this.sloRegistry.listByProject("").length === 0) {
      // lazily register when rebuild called with project
    }
  }

  private ensureProjectSlos(projectId: string): void {
    if (this.sloRegistry.listByProject(projectId).length === 0) {
      for (const slo of defaultProjectSlos(projectId)) {
        this.sloRegistry.register(slo);
      }
    }
  }

  async rebuild(
    projectId: string,
    windowRequest: BuildWindowRequest,
  ): Promise<ObservabilityResult> {
    this.ensureProjectSlos(projectId);
    const now = this.clock.nowIso();
    const window = await buildMetricWindow(
      this.sources.runs,
      this.sources.historicalRuns,
      { ...windowRequest, projectId },
    );

    const existing = await this.snapshots.getByWindowFingerprint(
      projectId,
      window.windowFingerprint,
    );

    const runRecords = [];
    const phaseRecords = [];
    const qualityFindings: TelemetryQualityFinding[] = [];
    for (const runId of window.includedRunIds) {
      const normalized = await this.normalization.normalizeRun(runId, now);
      await this.integrity.verifyAgainstSources(
        normalized.runTelemetry,
        this.sources,
      );
      const integrity = this.integrity.verifyRunTelemetry(
        normalized.runTelemetry,
      );
      if (!integrity.ok) {
        throw new ObservabilityError(
          "TELEMETRY_INTEGRITY_FAILED",
          integrity.reason,
        );
      }
      await this.runTelemetry.save(normalized.runTelemetry);
      for (const phase of normalized.phaseTelemetry) {
        await this.phaseTelemetry.save(phase);
      }
      runRecords.push(normalized.runTelemetry);
      phaseRecords.push(...normalized.phaseTelemetry);
      qualityFindings.push(...normalized.qualityFindings);
      await this.ledger.append({
        eventId: this.identities.next("obs-evt"),
        eventType: "TELEMETRY_NORMALIZED",
        projectId,
        runId,
        payload: { runTelemetryId: normalized.runTelemetry.runTelemetryId },
        createdAt: now,
      });
    }

    this.runTelemetry.indexForWindow(
      projectId,
      window.windowFingerprint,
      window.includedRunIds,
    );

    const reliabilityMetrics = computeReliabilityMetrics(
      runRecords,
      window.windowFingerprint,
      this.identities,
    );
    const latencyMetrics = computeLatencyMetrics(
      runRecords,
      window.windowFingerprint,
      this.identities,
    );
    const resourceMetrics = this.resourceAttribution.aggregate(
      projectId,
      window.windowFingerprint,
      runRecords,
      phaseRecords,
    );

    const baseline = await buildBaselineWindow(
      this.sources.runs,
      projectId,
      window.includedRunIds,
      30,
    );
    let baselineReliability: ReturnType<typeof computeReliabilityMetrics> = [];
    if (baseline) {
      const baselineRuns = [];
      for (const runId of baseline.runIds) {
        const cached = await this.runTelemetry.getByRun(runId);
        if (cached) baselineRuns.push(cached);
        else {
          const n = await this.normalization.normalizeRun(runId, now);
          baselineRuns.push(n.runTelemetry);
        }
      }
      baselineReliability = computeReliabilityMetrics(
        baselineRuns,
        baseline.fingerprint,
        this.identities,
      );
    }

    const sloDefs = this.sloRegistry.listActive(projectId);
    const evaluations = sloDefs.map((slo) =>
      this.sloEvaluation.evaluate(
        slo,
        reliabilityMetrics,
        window.windowFingerprint,
        now,
      ),
    );
    for (const evaluation of evaluations) {
      await this.sloEvaluations.save(evaluation);
      await this.ledger.append({
        eventId: this.identities.next("obs-evt"),
        eventType: "SLO_EVALUATED",
        projectId,
        payload: { evaluationId: evaluation.evaluationId },
        createdAt: now,
      });
    }

    const anomalyFindings = this.anomalyDetection.detect({
      projectId,
      windowFingerprint: window.windowFingerprint,
      reliabilityMetrics,
      latencyMetrics,
      runRecords,
      baselineMetrics: baselineReliability,
      detectedAt: now,
    });
    for (const finding of anomalyFindings) {
      await this.anomalies.save(finding);
      await this.ledger.append({
        eventId: this.identities.next("obs-evt"),
        eventType: "ANOMALY_DETECTED",
        projectId,
        payload: { anomalyId: finding.anomalyId },
        createdAt: now,
      });
    }

    const bottlenecks = this.bottleneckDetection.detect({
      projectId,
      windowFingerprint: window.windowFingerprint,
      reliabilityMetrics,
      latencyMetrics,
      runRecords,
      detectedAt: now,
    });
    for (const bottleneck of bottlenecks) {
      await this.ledger.append({
        eventId: this.identities.next("obs-evt"),
        eventType: "BOTTLENECK_DETECTED",
        projectId,
        payload: { bottleneckId: bottleneck.bottleneckId },
        createdAt: now,
      });
    }

    const candidates = this.optimization.generate({
      projectId,
      anomalies: anomalyFindings,
      bottlenecks,
      reliabilityMetrics,
      createdAt: now,
    });
    for (const candidate of candidates) {
      await this.optimizationCandidates.save(candidate);
      await this.ledger.append({
        eventId: this.identities.next("obs-evt"),
        eventType: "OPTIMIZATION_CANDIDATE_CREATED",
        projectId,
        payload: { optimizationCandidateId: candidate.optimizationCandidateId },
        createdAt: now,
      });
    }

    const healthStatus = deriveHealthStatus({
      sloEvaluations: evaluations,
      sloDefinitions: sloDefs,
      anomalies: anomalyFindings,
    });

    const snapshotPartial: Omit<SystemHealthSnapshot, "snapshotHash" | "generatedAt"> =
      {
        snapshotId: existing?.snapshotId ?? this.identities.next("health-snap"),
        projectId,
        windowFingerprint: window.windowFingerprint,
        healthStatus,
        reliabilityMetrics,
        latencyMetrics,
        resourceMetrics,
        sloEvaluationIds: evaluations.map((e) => e.evaluationId),
        sloEvaluations: evaluations,
        anomalyIds: anomalyFindings.map((a) => a.anomalyId),
        anomalies: anomalyFindings,
        bottleneckIds: bottlenecks.map((b) => b.bottleneckId),
        bottlenecks,
        optimizationCandidateIds: candidates.map(
          (c) => c.optimizationCandidateId,
        ),
        qualityFindings,
      };

    const snapshot: SystemHealthSnapshot = {
      ...snapshotPartial,
      generatedAt: now,
      snapshotHash: this.snapshotHasher.hash(snapshotPartial),
    };

    if (
      existing &&
      existing.snapshotHash === snapshot.snapshotHash &&
      existing.generatedAt
    ) {
      return {
        projectId,
        windowFingerprint: window.windowFingerprint,
        healthSnapshotId: existing.snapshotId,
        healthStatus: existing.healthStatus,
        metricRefs: [
          ...existing.reliabilityMetrics.map((m) => m.provenance.metricId),
          ...existing.latencyMetrics.map((m) => m.provenance.metricId),
        ],
        sloEvaluationIds: existing.sloEvaluationIds,
        anomalyIds: existing.anomalyIds,
        bottleneckIds: existing.bottleneckIds,
        optimizationCandidateIds: existing.optimizationCandidateIds,
        generatedAt: existing.generatedAt,
      };
    }

    await this.snapshots.save(snapshot);
    await this.ledger.append({
      eventId: this.identities.next("obs-evt"),
      eventType: "HEALTH_SNAPSHOT_CREATED",
      projectId,
      snapshotId: snapshot.snapshotId,
      payload: { healthStatus },
      createdAt: now,
    });

    return {
      projectId,
      windowFingerprint: window.windowFingerprint,
      healthSnapshotId: snapshot.snapshotId,
      healthStatus,
      metricRefs: [
        ...reliabilityMetrics.map((m) => m.provenance.metricId),
        ...latencyMetrics.map((m) => m.provenance.metricId),
      ],
      sloEvaluationIds: evaluations.map((e) => e.evaluationId),
      anomalyIds: anomalyFindings.map((a) => a.anomalyId),
      bottleneckIds: bottlenecks.map((b) => b.bottleneckId),
      optimizationCandidateIds: candidates.map(
        (c) => c.optimizationCandidateId,
      ),
      generatedAt: now,
    };
  }

  async getLatestHealth(projectId: string): Promise<SystemHealthSnapshot | null> {
    const snapshots = await this.snapshots.listByProject(projectId);
    return snapshots.at(-1) ?? null;
  }

  async reviewOptimizationCandidate(
    candidateId: string,
    status: "REVIEWED" | "ACCEPTED_FOR_FUTURE_CHANGE" | "REJECTED",
  ) {
    const candidate = await this.optimizationCandidates.getById(candidateId);
    if (!candidate) {
      throw new ObservabilityError(
        "OPTIMIZATION_CANDIDATE_NOT_FOUND",
        `Candidate not found: ${candidateId}`,
      );
    }
    const updated = await this.optimizationCandidates.updateStatus(
      candidateId,
      status,
    );
    await this.ledger.append({
      eventId: this.identities.next("obs-evt"),
      eventType: "OPTIMIZATION_CANDIDATE_REVIEWED",
      projectId: candidate.projectId,
      payload: { optimizationCandidateId: candidateId, status },
      createdAt: this.clock.nowIso(),
    });
    return updated;
  }

  getIntelligence(): IntelligenceAggregator {
    return this.intelligence;
  }
}
