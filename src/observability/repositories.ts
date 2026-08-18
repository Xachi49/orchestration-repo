import type {
  RunTelemetryRecord,
  PhaseTelemetryRecord,
  SystemHealthSnapshot,
  SLOEvaluation,
  AnomalyFinding,
  OptimizationCandidate,
} from "../domain/observability/index.js";
import type { ObservabilityLedgerEvent } from "../domain/observability/ledger.js";

export interface RunTelemetryRepository {
  save(record: RunTelemetryRecord): Promise<RunTelemetryRecord>;
  getByRun(runId: string): Promise<RunTelemetryRecord | null>;
  listByProject(projectId: string): Promise<readonly RunTelemetryRecord[]>;
  listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly RunTelemetryRecord[]>;
}

export interface PhaseTelemetryRepository {
  save(record: PhaseTelemetryRecord): Promise<PhaseTelemetryRecord>;
  listByRun(runId: string): Promise<readonly PhaseTelemetryRecord[]>;
  listByProject(projectId: string): Promise<readonly PhaseTelemetryRecord[]>;
}

export interface SystemHealthSnapshotRepository {
  save(snapshot: SystemHealthSnapshot): Promise<SystemHealthSnapshot>;
  getById(snapshotId: string): Promise<SystemHealthSnapshot | null>;
  getByWindowFingerprint(
    projectId: string,
    windowFingerprint: string,
  ): Promise<SystemHealthSnapshot | null>;
  listByProject(projectId: string): Promise<readonly SystemHealthSnapshot[]>;
}

export interface SLOEvaluationRepository {
  save(evaluation: SLOEvaluation): Promise<SLOEvaluation>;
  listByProject(projectId: string): Promise<readonly SLOEvaluation[]>;
  listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly SLOEvaluation[]>;
}

export interface AnomalyFindingRepository {
  save(finding: AnomalyFinding): Promise<AnomalyFinding>;
  getById(anomalyId: string): Promise<AnomalyFinding | null>;
  updateStatus(
    anomalyId: string,
    status: AnomalyFinding["status"],
  ): Promise<AnomalyFinding>;
  listByProject(projectId: string): Promise<readonly AnomalyFinding[]>;
  listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly AnomalyFinding[]>;
}

export interface OptimizationCandidateRepository {
  save(candidate: OptimizationCandidate): Promise<OptimizationCandidate>;
  getById(
    optimizationCandidateId: string,
  ): Promise<OptimizationCandidate | null>;
  updateStatus(
    optimizationCandidateId: string,
    status: OptimizationCandidate["status"],
  ): Promise<OptimizationCandidate>;
  listByProject(projectId: string): Promise<readonly OptimizationCandidate[]>;
}

export interface ObservabilityLedger {
  append(event: ObservabilityLedgerEvent): Promise<ObservabilityLedgerEvent>;
  listByProject(projectId: string): Promise<readonly ObservabilityLedgerEvent[]>;
}

export class InMemoryRunTelemetryRepository implements RunTelemetryRepository {
  private readonly byRunId = new Map<string, RunTelemetryRecord>();
  private readonly byProject = new Map<string, Set<string>>();
  private readonly byWindow = new Map<string, Set<string>>();

  async save(record: RunTelemetryRecord): Promise<RunTelemetryRecord> {
    const existing = this.byRunId.get(record.runId);
    if (existing && existing.telemetryHash === record.telemetryHash) {
      return existing;
    }
    this.byRunId.set(record.runId, record);
    const projectSet = this.byProject.get(record.projectId) ?? new Set();
    projectSet.add(record.runId);
    this.byProject.set(record.projectId, projectSet);
    return record;
  }

  async getByRun(runId: string): Promise<RunTelemetryRecord | null> {
    return this.byRunId.get(runId) ?? null;
  }

  async listByProject(projectId: string): Promise<readonly RunTelemetryRecord[]> {
    const ids = this.byProject.get(projectId);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byRunId.get(id)!)
      .filter(Boolean)
      .sort((a, b) => a.runId.localeCompare(b.runId));
  }

  async listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly RunTelemetryRecord[]> {
    const key = `${projectId}:${windowFingerprint}`;
    const ids = this.byWindow.get(key);
    if (!ids) return [];
    return [...ids]
      .map((id) => this.byRunId.get(id)!)
      .filter(Boolean);
  }

  indexForWindow(
    projectId: string,
    windowFingerprint: string,
    runIds: readonly string[],
  ): void {
    const key = `${projectId}:${windowFingerprint}`;
    this.byWindow.set(key, new Set(runIds));
  }
}

export class InMemoryPhaseTelemetryRepository
  implements PhaseTelemetryRepository
{
  private readonly byRun = new Map<string, PhaseTelemetryRecord[]>();
  private readonly byProject = new Map<string, Set<string>>();

  async save(record: PhaseTelemetryRecord): Promise<PhaseTelemetryRecord> {
    const runPhases = this.byRun.get(record.runId) ?? [];
    const idx = runPhases.findIndex(
      (p) => p.phaseTelemetryId === record.phaseTelemetryId,
    );
    if (idx >= 0) {
      runPhases[idx] = record;
    } else {
      runPhases.push(record);
    }
    this.byRun.set(record.runId, runPhases);
    const projectSet = this.byProject.get(record.projectId) ?? new Set();
    projectSet.add(record.runId);
    this.byProject.set(record.projectId, projectSet);
    return record;
  }

  async listByRun(runId: string): Promise<readonly PhaseTelemetryRecord[]> {
    return this.byRun.get(runId) ?? [];
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly PhaseTelemetryRecord[]> {
    const ids = this.byProject.get(projectId);
    if (!ids) return [];
    const result: PhaseTelemetryRecord[] = [];
    for (const runId of ids) {
      result.push(...(this.byRun.get(runId) ?? []));
    }
    return result;
  }
}

export class InMemorySystemHealthSnapshotRepository
  implements SystemHealthSnapshotRepository
{
  private readonly byId = new Map<string, SystemHealthSnapshot>();
  private readonly byWindow = new Map<string, SystemHealthSnapshot>();
  private readonly byProject = new Map<string, Set<string>>();

  async save(snapshot: SystemHealthSnapshot): Promise<SystemHealthSnapshot> {
    const windowKey = `${snapshot.projectId}:${snapshot.windowFingerprint}`;
    const existing = this.byWindow.get(windowKey);
    if (existing && existing.snapshotHash === snapshot.snapshotHash) {
      return existing;
    }
    this.byId.set(snapshot.snapshotId, snapshot);
    this.byWindow.set(windowKey, snapshot);
    const projectSet = this.byProject.get(snapshot.projectId) ?? new Set();
    projectSet.add(snapshot.snapshotId);
    this.byProject.set(snapshot.projectId, projectSet);
    return snapshot;
  }

  async getById(snapshotId: string): Promise<SystemHealthSnapshot | null> {
    return this.byId.get(snapshotId) ?? null;
  }

  async getByWindowFingerprint(
    projectId: string,
    windowFingerprint: string,
  ): Promise<SystemHealthSnapshot | null> {
    return this.byWindow.get(`${projectId}:${windowFingerprint}`) ?? null;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly SystemHealthSnapshot[]> {
    const ids = this.byProject.get(projectId);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)!).filter(Boolean);
  }
}

export class InMemorySLOEvaluationRepository implements SLOEvaluationRepository {
  private readonly byProject = new Map<string, SLOEvaluation[]>();

  async save(evaluation: SLOEvaluation): Promise<SLOEvaluation> {
    const list = this.byProject.get(evaluation.projectId) ?? [];
    const idx = list.findIndex((e) => e.evaluationId === evaluation.evaluationId);
    if (idx >= 0) list[idx] = evaluation;
    else list.push(evaluation);
    this.byProject.set(evaluation.projectId, list);
    return evaluation;
  }

  async listByProject(projectId: string): Promise<readonly SLOEvaluation[]> {
    return this.byProject.get(projectId) ?? [];
  }

  async listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly SLOEvaluation[]> {
    return (this.byProject.get(projectId) ?? []).filter(
      (e) => e.windowFingerprint === windowFingerprint,
    );
  }
}

export class InMemoryAnomalyFindingRepository
  implements AnomalyFindingRepository
{
  private readonly byId = new Map<string, AnomalyFinding>();
  private readonly byProject = new Map<string, Set<string>>();

  async save(finding: AnomalyFinding): Promise<AnomalyFinding> {
    this.byId.set(finding.anomalyId, finding);
    const set = this.byProject.get(finding.projectId) ?? new Set();
    set.add(finding.anomalyId);
    this.byProject.set(finding.projectId, set);
    return finding;
  }

  async getById(anomalyId: string): Promise<AnomalyFinding | null> {
    return this.byId.get(anomalyId) ?? null;
  }

  async updateStatus(
    anomalyId: string,
    status: AnomalyFinding["status"],
  ): Promise<AnomalyFinding> {
    const existing = this.byId.get(anomalyId);
    if (!existing) throw new Error(`Anomaly not found: ${anomalyId}`);
    const updated = { ...existing, status };
    this.byId.set(anomalyId, updated);
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly AnomalyFinding[]> {
    const ids = this.byProject.get(projectId);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)!).filter(Boolean);
  }

  async listByWindow(
    projectId: string,
    windowFingerprint: string,
  ): Promise<readonly AnomalyFinding[]> {
    return (await this.listByProject(projectId)).filter(
      (f) => f.windowFingerprint === windowFingerprint,
    );
  }
}

export class InMemoryOptimizationCandidateRepository
  implements OptimizationCandidateRepository
{
  private readonly byId = new Map<string, OptimizationCandidate>();
  private readonly byProject = new Map<string, Set<string>>();

  async save(candidate: OptimizationCandidate): Promise<OptimizationCandidate> {
    this.byId.set(candidate.optimizationCandidateId, candidate);
    const set = this.byProject.get(candidate.projectId) ?? new Set();
    set.add(candidate.optimizationCandidateId);
    this.byProject.set(candidate.projectId, set);
    return candidate;
  }

  async getById(
    optimizationCandidateId: string,
  ): Promise<OptimizationCandidate | null> {
    return this.byId.get(optimizationCandidateId) ?? null;
  }

  async updateStatus(
    optimizationCandidateId: string,
    status: OptimizationCandidate["status"],
  ): Promise<OptimizationCandidate> {
    const existing = this.byId.get(optimizationCandidateId);
    if (!existing) {
      throw new Error(`Optimization candidate not found: ${optimizationCandidateId}`);
    }
    const updated = { ...existing, status };
    this.byId.set(optimizationCandidateId, updated);
    return updated;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly OptimizationCandidate[]> {
    const ids = this.byProject.get(projectId);
    if (!ids) return [];
    return [...ids].map((id) => this.byId.get(id)!).filter(Boolean);
  }
}

export class InMemoryObservabilityLedger implements ObservabilityLedger {
  private readonly events: ObservabilityLedgerEvent[] = [];

  async append(
    event: ObservabilityLedgerEvent,
  ): Promise<ObservabilityLedgerEvent> {
    this.events.push(event);
    return event;
  }

  async listByProject(
    projectId: string,
  ): Promise<readonly ObservabilityLedgerEvent[]> {
    return this.events.filter((e) => e.projectId === projectId);
  }
}
