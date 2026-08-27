import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentPlan } from "./plan.js";
import type {
  ExperimentAuthorizationRequest,
  ExperimentAuthorizationRecord,
} from "./authorization.js";
import type {
  ExperimentResult,
  ExperimentEvidenceBundle,
  AssumptionEvidenceUpdateCandidate,
  ExperimentCompletionRecord,
  ExperimentExecutionLineage,
} from "./evidence.js";

export interface ExperimentUsageLedger {
  experimentId: string;
  designCalls: number;
  modelCalls: number;
  sampleCount: number;
  /** Reserved against maximumActions for Phase 2 objective admission. */
  reservedActions: number;
  /** Settled objective admissions (ADMITTED / DUPLICATE_REUSED). */
  committedActions: number;
  recordRevision: number;
  updatedAt: string;
}

/**
 * Canonical hydration for durable usage ledgers.
 * Preserves persisted reserved/committed values; defaults only when absent
 * (legacy rows written before those fields existed).
 */
export function hydrateExperimentUsageLedger(input: {
  payload: unknown;
  recordRevision: number;
}): ExperimentUsageLedger {
  const payload = (input.payload ?? {}) as Partial<ExperimentUsageLedger>;
  return {
    experimentId: String(payload.experimentId ?? ""),
    designCalls: payload.designCalls ?? 0,
    modelCalls: payload.modelCalls ?? 0,
    sampleCount: payload.sampleCount ?? 0,
    reservedActions: payload.reservedActions ?? 0,
    committedActions: payload.committedActions ?? 0,
    recordRevision: input.recordRevision,
    updatedAt: payload.updatedAt ?? new Date(0).toISOString(),
  };
}

export interface ExperimentRepository {
  create(experiment: GovernedExperiment): Promise<GovernedExperiment>;
  getById(experimentId: string): Promise<GovernedExperiment | null>;
  getByIdempotencyKey(key: string): Promise<GovernedExperiment | null>;
  save(
    experiment: GovernedExperiment,
    expectedRevision: number,
  ): Promise<GovernedExperiment>;
  transition(
    experimentId: string,
    fromStatus: GovernedExperiment["status"],
    expectedRevision: number,
    toStatus: GovernedExperiment["status"],
    updatedAt: string,
    patch?: Partial<GovernedExperiment>,
  ): Promise<GovernedExperiment>;
  listByStates(
    states: readonly GovernedExperiment["status"][],
  ): Promise<readonly GovernedExperiment[]>;
}

export interface ExperimentPlanRepository {
  save(plan: ExperimentPlan): Promise<ExperimentPlan>;
  getLatest(experimentId: string): Promise<ExperimentPlan | null>;
  getByHash(
    experimentId: string,
    experimentPlanHash: string,
  ): Promise<ExperimentPlan | null>;
}

export interface ExperimentAuthorizationRequestRepository {
  save(
    request: ExperimentAuthorizationRequest,
  ): Promise<ExperimentAuthorizationRequest>;
  getById(
    authorizationId: string,
  ): Promise<ExperimentAuthorizationRequest | null>;
  getPending(
    experimentId: string,
  ): Promise<ExperimentAuthorizationRequest | null>;
  saveCas(
    request: ExperimentAuthorizationRequest,
    expectedRevision: number,
  ): Promise<ExperimentAuthorizationRequest>;
}

export interface ExperimentAuthorizationRecordRepository {
  save(
    record: ExperimentAuthorizationRecord,
  ): Promise<ExperimentAuthorizationRecord>;
  getLatest(
    experimentId: string,
  ): Promise<ExperimentAuthorizationRecord | null>;
}

export interface ExperimentResultRepository {
  save(result: ExperimentResult): Promise<ExperimentResult>;
  getById(experimentResultId: string): Promise<ExperimentResult | null>;
  listByExperiment(
    experimentId: string,
  ): Promise<readonly ExperimentResult[]>;
}

export interface ExperimentEvidenceBundleRepository {
  save(bundle: ExperimentEvidenceBundle): Promise<ExperimentEvidenceBundle>;
  getById(evidenceBundleId: string): Promise<ExperimentEvidenceBundle | null>;
  getByExperiment(
    experimentId: string,
  ): Promise<ExperimentEvidenceBundle | null>;
}

export interface AssumptionEvidenceUpdateCandidateRepository {
  save(
    candidate: AssumptionEvidenceUpdateCandidate,
  ): Promise<AssumptionEvidenceUpdateCandidate>;
  listByExperiment(
    experimentId: string,
  ): Promise<readonly AssumptionEvidenceUpdateCandidate[]>;
}

export interface ExperimentCompletionRecordRepository {
  save(
    record: ExperimentCompletionRecord,
  ): Promise<ExperimentCompletionRecord>;
  getByExperiment(
    experimentId: string,
  ): Promise<ExperimentCompletionRecord | null>;
}

export interface ExperimentExecutionLineageRepository {
  save(
    record: ExperimentExecutionLineage,
  ): Promise<ExperimentExecutionLineage>;
  getById(lineageId: string): Promise<ExperimentExecutionLineage | null>;
  getByCompiledRunId(
    compiledRunId: string,
  ): Promise<ExperimentExecutionLineage | null>;
  listByExperiment(
    experimentId: string,
  ): Promise<readonly ExperimentExecutionLineage[]>;
}

export interface ExperimentUsageLedgerRepository {
  get(experimentId: string): Promise<ExperimentUsageLedger | null>;
  saveCas(
    ledger: ExperimentUsageLedger,
    expectedRevision: number,
  ): Promise<ExperimentUsageLedger>;
  create(ledger: ExperimentUsageLedger): Promise<ExperimentUsageLedger>;
}
