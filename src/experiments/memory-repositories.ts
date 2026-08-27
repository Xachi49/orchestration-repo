import {
  ExperimentAuthorizationRecordSchema,
  ExperimentAuthorizationRequestSchema,
  type ExperimentAuthorizationRecord,
  type ExperimentAuthorizationRequest,
} from "./authorization.js";
import { canTransitionExperiment } from "./experiment-state-schema.js";
import {
  parseGovernedExperiment,
  type GovernedExperiment,
} from "./experiment.js";
import {
  AssumptionEvidenceUpdateCandidateSchema,
  ExperimentCompletionRecordSchema,
  ExperimentEvidenceBundleSchema,
  ExperimentExecutionLineageSchema,
  ExperimentResultSchema,
  type AssumptionEvidenceUpdateCandidate,
  type ExperimentCompletionRecord,
  type ExperimentEvidenceBundle,
  type ExperimentExecutionLineage,
  type ExperimentResult,
} from "./evidence.js";
import { ExperimentError } from "./errors.js";
import { ExperimentPlanSchema, type ExperimentPlan } from "./plan.js";
import type {
  AssumptionEvidenceUpdateCandidateRepository,
  ExperimentAuthorizationRecordRepository,
  ExperimentAuthorizationRequestRepository,
  ExperimentCompletionRecordRepository,
  ExperimentEvidenceBundleRepository,
  ExperimentExecutionLineageRepository,
  ExperimentPlanRepository,
  ExperimentRepository,
  ExperimentResultRepository,
  ExperimentUsageLedger,
  ExperimentUsageLedgerRepository,
} from "./repositories.js";
import { hydrateExperimentUsageLedger } from "./repositories.js";

export class InMemoryExperimentRepository implements ExperimentRepository {
  private readonly byId = new Map<string, GovernedExperiment>();
  private readonly byIdem = new Map<string, string>();

  async create(experiment: GovernedExperiment): Promise<GovernedExperiment> {
    const parsed = parseGovernedExperiment(experiment);
    if (this.byId.has(parsed.experimentId)) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `Experiment ${parsed.experimentId} already exists`,
      );
    }
    this.byId.set(parsed.experimentId, parsed);
    this.byIdem.set(parsed.idempotencyKey, parsed.experimentId);
    return parsed;
  }

  async getById(experimentId: string): Promise<GovernedExperiment | null> {
    return this.byId.get(experimentId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<GovernedExperiment | null> {
    const id = this.byIdem.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async save(
    experiment: GovernedExperiment,
    expectedRevision: number,
  ): Promise<GovernedExperiment> {
    const existing = this.byId.get(experiment.experimentId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `CAS conflict for experiment ${experiment.experimentId}`,
      );
    }
    const next = parseGovernedExperiment({
      ...experiment,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.experimentId, next);
    return next;
  }

  async transition(
    experimentId: string,
    fromStatus: GovernedExperiment["status"],
    expectedRevision: number,
    toStatus: GovernedExperiment["status"],
    updatedAt: string,
    patch: Partial<GovernedExperiment> = {},
  ): Promise<GovernedExperiment> {
    const existing = this.byId.get(experimentId);
    if (!existing) {
      throw new ExperimentError(
        "EXPERIMENT_NOT_FOUND",
        `Experiment ${experimentId} missing`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new ExperimentError(
        "EXPERIMENT_STATE_CONFLICT",
        `Experiment ${experimentId} state/revision mismatch`,
      );
    }
    if (!canTransitionExperiment(fromStatus, toStatus)) {
      throw new ExperimentError(
        "INVALID_EXPERIMENT_TRANSITION",
        `Illegal transition ${fromStatus} → ${toStatus}`,
      );
    }
    const safePatch = { ...patch };
    delete safePatch.experimentId;
    delete safePatch.status;
    delete safePatch.recordRevision;
    delete safePatch.updatedAt;
    const updated = parseGovernedExperiment({
      ...existing,
      ...safePatch,
      status: toStatus,
      updatedAt,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(experimentId, updated);
    return updated;
  }

  async listByStates(
    states: readonly GovernedExperiment["status"][],
  ): Promise<readonly GovernedExperiment[]> {
    const set = new Set(states);
    return [...this.byId.values()]
      .filter((e) => set.has(e.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  }
}

export class InMemoryExperimentPlanRepository
  implements ExperimentPlanRepository
{
  private readonly plans = new Map<string, ExperimentPlan>();

  private key(experimentId: string, experimentPlanHash: string): string {
    return `${experimentId}:${experimentPlanHash}`;
  }

  async save(plan: ExperimentPlan): Promise<ExperimentPlan> {
    const parsed = ExperimentPlanSchema.parse(plan);
    const k = this.key(parsed.experimentId, parsed.experimentPlanHash);
    if (this.plans.has(k)) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `Experiment plan ${k} already immutable`,
      );
    }
    this.plans.set(k, parsed);
    return parsed;
  }

  async getLatest(experimentId: string): Promise<ExperimentPlan | null> {
    const versions = [...this.plans.values()]
      .filter((p) => p.experimentId === experimentId)
      .sort((a, b) => b.experimentPlanVersion - a.experimentPlanVersion);
    return versions[0] ?? null;
  }

  async getByHash(
    experimentId: string,
    experimentPlanHash: string,
  ): Promise<ExperimentPlan | null> {
    return this.plans.get(this.key(experimentId, experimentPlanHash)) ?? null;
  }
}

export class InMemoryExperimentAuthorizationRequestRepository
  implements ExperimentAuthorizationRequestRepository
{
  private readonly byId = new Map<string, ExperimentAuthorizationRequest>();

  async save(
    request: ExperimentAuthorizationRequest,
  ): Promise<ExperimentAuthorizationRequest> {
    const parsed = ExperimentAuthorizationRequestSchema.parse(request);
    this.byId.set(parsed.authorizationId, parsed);
    return parsed;
  }

  async getById(
    authorizationId: string,
  ): Promise<ExperimentAuthorizationRequest | null> {
    return this.byId.get(authorizationId) ?? null;
  }

  async getPending(
    experimentId: string,
  ): Promise<ExperimentAuthorizationRequest | null> {
    return (
      [...this.byId.values()].find(
        (r) => r.experimentId === experimentId && r.status === "PENDING",
      ) ?? null
    );
  }

  async saveCas(
    request: ExperimentAuthorizationRequest,
    expectedRevision: number,
  ): Promise<ExperimentAuthorizationRequest> {
    const existing = this.byId.get(request.authorizationId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `Authorization request CAS conflict for ${request.authorizationId}`,
      );
    }
    const next = ExperimentAuthorizationRequestSchema.parse({
      ...request,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.authorizationId, next);
    return next;
  }
}

export class InMemoryExperimentAuthorizationRecordRepository
  implements ExperimentAuthorizationRecordRepository
{
  private readonly byRecordId = new Map<string, ExperimentAuthorizationRecord>();
  private readonly byExperiment = new Map<string, ExperimentAuthorizationRecord>();

  async save(
    record: ExperimentAuthorizationRecord,
  ): Promise<ExperimentAuthorizationRecord> {
    const parsed = ExperimentAuthorizationRecordSchema.parse(record);
    this.byRecordId.set(parsed.authorizationRecordId, parsed);
    this.byExperiment.set(parsed.experimentId, parsed);
    return parsed;
  }

  async getLatest(
    experimentId: string,
  ): Promise<ExperimentAuthorizationRecord | null> {
    return this.byExperiment.get(experimentId) ?? null;
  }
}

export class InMemoryExperimentResultRepository
  implements ExperimentResultRepository
{
  private readonly byId = new Map<string, ExperimentResult>();

  async save(result: ExperimentResult): Promise<ExperimentResult> {
    const parsed = ExperimentResultSchema.parse(result);
    this.byId.set(parsed.experimentResultId, parsed);
    return parsed;
  }

  async getById(experimentResultId: string): Promise<ExperimentResult | null> {
    return this.byId.get(experimentResultId) ?? null;
  }

  async listByExperiment(
    experimentId: string,
  ): Promise<readonly ExperimentResult[]> {
    return [...this.byId.values()].filter(
      (r) => r.experimentId === experimentId,
    );
  }
}

export class InMemoryExperimentEvidenceBundleRepository
  implements ExperimentEvidenceBundleRepository
{
  private readonly byId = new Map<string, ExperimentEvidenceBundle>();
  private readonly byExperiment = new Map<string, ExperimentEvidenceBundle>();

  async save(bundle: ExperimentEvidenceBundle): Promise<ExperimentEvidenceBundle> {
    const parsed = ExperimentEvidenceBundleSchema.parse(bundle);
    this.byId.set(parsed.evidenceBundleId, parsed);
    this.byExperiment.set(parsed.experimentId, parsed);
    return parsed;
  }

  async getById(
    evidenceBundleId: string,
  ): Promise<ExperimentEvidenceBundle | null> {
    return this.byId.get(evidenceBundleId) ?? null;
  }

  async getByExperiment(
    experimentId: string,
  ): Promise<ExperimentEvidenceBundle | null> {
    return this.byExperiment.get(experimentId) ?? null;
  }
}

export class InMemoryAssumptionEvidenceUpdateCandidateRepository
  implements AssumptionEvidenceUpdateCandidateRepository
{
  private readonly byId = new Map<string, AssumptionEvidenceUpdateCandidate>();

  async save(
    candidate: AssumptionEvidenceUpdateCandidate,
  ): Promise<AssumptionEvidenceUpdateCandidate> {
    const parsed = AssumptionEvidenceUpdateCandidateSchema.parse(candidate);
    this.byId.set(parsed.candidateId, parsed);
    return parsed;
  }

  async listByExperiment(
    experimentId: string,
  ): Promise<readonly AssumptionEvidenceUpdateCandidate[]> {
    return [...this.byId.values()].filter(
      (c) => c.experimentId === experimentId,
    );
  }
}

export class InMemoryExperimentCompletionRecordRepository
  implements ExperimentCompletionRecordRepository
{
  private readonly byExperiment = new Map<string, ExperimentCompletionRecord>();

  async save(
    record: ExperimentCompletionRecord,
  ): Promise<ExperimentCompletionRecord> {
    const parsed = ExperimentCompletionRecordSchema.parse(record);
    this.byExperiment.set(parsed.experimentId, parsed);
    return parsed;
  }

  async getByExperiment(
    experimentId: string,
  ): Promise<ExperimentCompletionRecord | null> {
    return this.byExperiment.get(experimentId) ?? null;
  }
}

export class InMemoryExperimentExecutionLineageRepository
  implements ExperimentExecutionLineageRepository
{
  private readonly byId = new Map<string, ExperimentExecutionLineage>();
  private readonly byCompiledRunId = new Map<string, ExperimentExecutionLineage>();

  async save(
    record: ExperimentExecutionLineage,
  ): Promise<ExperimentExecutionLineage> {
    const parsed = ExperimentExecutionLineageSchema.parse(record);
    this.byId.set(parsed.lineageId, parsed);
    if (parsed.compiledRunId) {
      this.byCompiledRunId.set(parsed.compiledRunId, parsed);
    }
    return parsed;
  }

  async getById(lineageId: string): Promise<ExperimentExecutionLineage | null> {
    return this.byId.get(lineageId) ?? null;
  }

  async getByCompiledRunId(
    compiledRunId: string,
  ): Promise<ExperimentExecutionLineage | null> {
    return this.byCompiledRunId.get(compiledRunId) ?? null;
  }

  async listByExperiment(
    experimentId: string,
  ): Promise<readonly ExperimentExecutionLineage[]> {
    return [...this.byId.values()].filter(
      (r) => r.experimentId === experimentId,
    );
  }
}

export class InMemoryExperimentUsageLedgerRepository
  implements ExperimentUsageLedgerRepository
{
  private readonly ledgers = new Map<string, ExperimentUsageLedger>();

  async get(experimentId: string): Promise<ExperimentUsageLedger | null> {
    const existing = this.ledgers.get(experimentId);
    if (!existing) return null;
    return hydrateExperimentUsageLedger({
      payload: existing,
      recordRevision: existing.recordRevision,
    });
  }

  async create(ledger: ExperimentUsageLedger): Promise<ExperimentUsageLedger> {
    const normalized = hydrateExperimentUsageLedger({
      payload: ledger,
      recordRevision: ledger.recordRevision,
    });
    this.ledgers.set(normalized.experimentId, normalized);
    return normalized;
  }

  async saveCas(
    ledger: ExperimentUsageLedger,
    expectedRevision: number,
  ): Promise<ExperimentUsageLedger> {
    const existing = this.ledgers.get(ledger.experimentId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ExperimentError(
        "EXPERIMENT_CAS_CONFLICT",
        `Usage ledger CAS conflict for ${ledger.experimentId}`,
      );
    }
    const next = { ...ledger, recordRevision: expectedRevision + 1 };
    this.ledgers.set(next.experimentId, next);
    return next;
  }
}
