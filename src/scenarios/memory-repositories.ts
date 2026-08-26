import {
  parseDecisionProblem,
  type DecisionProblem,
} from "./decision-problem.js";
import {
  canTransitionDecisionProblem,
  type DecisionProblemState,
} from "./decision-state.js";
import {
  StrategicDecisionPackageSchema,
  type StrategicDecisionPackage,
} from "./decision-package.js";
import { ScenarioError } from "./errors.js";
import {
  ScenarioCalibrationRecordSchema,
  ScenarioPortfolioLineageSchema,
  type ScenarioCalibrationRecord,
  type ScenarioPortfolioLineage,
} from "./lineage.js";
import {
  ScenarioSetSchema,
  type ScenarioSet,
} from "./scenario.js";
import {
  ScenarioSimulationResultSchema,
  type ScenarioSimulationResult,
} from "./simulation-result.js";
import {
  StrategySelectionRecordSchema,
  StrategySelectionRequestSchema,
  type StrategySelectionRecord,
  type StrategySelectionRequest,
} from "./selection.js";
import type {
  DecisionPackageRepository,
  DecisionProblemRepository,
  ScenarioCalibrationRepository,
  ScenarioPortfolioLineageRepository,
  ScenarioSetRepository,
  SimulationResultRepository,
  SimulationUsageLedger,
  SimulationUsageLedgerRepository,
  StrategySelectionRecordRepository,
  StrategySelectionRequestRepository,
} from "./repositories.js";

export class InMemoryDecisionProblemRepository
  implements DecisionProblemRepository
{
  private readonly byId = new Map<string, DecisionProblem>();
  private readonly byIdem = new Map<string, string>();

  async create(problem: DecisionProblem): Promise<DecisionProblem> {
    const parsed = parseDecisionProblem(problem);
    if (this.byId.has(parsed.decisionProblemId)) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `Decision problem ${parsed.decisionProblemId} already exists`,
      );
    }
    this.byId.set(parsed.decisionProblemId, parsed);
    this.byIdem.set(parsed.idempotencyKey, parsed.decisionProblemId);
    return parsed;
  }

  async getById(decisionProblemId: string): Promise<DecisionProblem | null> {
    return this.byId.get(decisionProblemId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<DecisionProblem | null> {
    const id = this.byIdem.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async save(
    problem: DecisionProblem,
    expectedRevision: number,
  ): Promise<DecisionProblem> {
    const existing = this.byId.get(problem.decisionProblemId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `CAS conflict for decision problem ${problem.decisionProblemId}`,
      );
    }
    const next = parseDecisionProblem({
      ...problem,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.decisionProblemId, next);
    return next;
  }

  async transition(
    decisionProblemId: string,
    expected: DecisionProblemState,
    expectedRevision: number,
    next: DecisionProblemState,
    updatedAt: string,
    extras: Partial<
      Pick<
        DecisionProblem,
        | "scenarioSetVersion"
        | "scenarioSetHash"
        | "decisionPackageHash"
        | "truthSnapshotFingerprint"
        | "failureReasonCode"
      >
    > = {},
  ): Promise<DecisionProblem> {
    const existing = this.byId.get(decisionProblemId);
    if (!existing) {
      throw new ScenarioError(
        "DECISION_PROBLEM_NOT_FOUND",
        `Decision problem ${decisionProblemId} missing`,
      );
    }
    if (
      existing.status !== expected ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new ScenarioError(
        "DECISION_PROBLEM_STATE_CONFLICT",
        `Decision problem ${decisionProblemId} state/revision mismatch`,
      );
    }
    if (!canTransitionDecisionProblem(expected, next)) {
      throw new ScenarioError(
        "INVALID_DECISION_TRANSITION",
        `Illegal transition ${expected} → ${next}`,
      );
    }
    const updated = parseDecisionProblem({
      ...existing,
      ...extras,
      status: next,
      updatedAt,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(decisionProblemId, updated);
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly DecisionProblem[]> {
    return [...this.byId.values()].filter(
      (p) => p.primaryProjectId === projectId,
    );
  }

  async listByStates(
    states: readonly DecisionProblemState[],
    limit: number,
  ): Promise<readonly DecisionProblem[]> {
    const set = new Set(states);
    return [...this.byId.values()]
      .filter((p) => set.has(p.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }
}

export class InMemoryScenarioSetRepository implements ScenarioSetRepository {
  private readonly sets = new Map<string, ScenarioSet>();

  private key(decisionProblemId: string, version: number): string {
    return `${decisionProblemId}:${version}`;
  }

  async save(set: ScenarioSet): Promise<ScenarioSet> {
    const parsed = ScenarioSetSchema.parse(set);
    const k = this.key(parsed.decisionProblemId, parsed.scenarioSetVersion);
    if (this.sets.has(k)) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `Scenario set ${k} already immutable`,
      );
    }
    this.sets.set(k, parsed);
    return parsed;
  }

  async get(
    decisionProblemId: string,
    scenarioSetVersion: number,
  ): Promise<ScenarioSet | null> {
    return this.sets.get(this.key(decisionProblemId, scenarioSetVersion)) ?? null;
  }

  async getLatest(decisionProblemId: string): Promise<ScenarioSet | null> {
    const versions = [...this.sets.values()]
      .filter((s) => s.decisionProblemId === decisionProblemId)
      .sort((a, b) => b.scenarioSetVersion - a.scenarioSetVersion);
    return versions[0] ?? null;
  }
}

export class InMemorySimulationResultRepository
  implements SimulationResultRepository
{
  private readonly byRunId = new Map<string, ScenarioSimulationResult>();
  private readonly byFingerprint = new Map<string, ScenarioSimulationResult>();

  async save(result: ScenarioSimulationResult): Promise<ScenarioSimulationResult> {
    const parsed = ScenarioSimulationResultSchema.parse(result);
    const existingByFp = this.byFingerprint.get(parsed.inputFingerprint);
    if (existingByFp && existingByFp.simulationRunId !== parsed.simulationRunId) {
      throw new ScenarioError(
        "SIMULATION_IDENTITY_CONFLICT",
        `Input fingerprint ${parsed.inputFingerprint} bound to different run`,
      );
    }
    const existingByRun = this.byRunId.get(parsed.simulationRunId);
    if (existingByRun && existingByRun.inputFingerprint !== parsed.inputFingerprint) {
      throw new ScenarioError(
        "SIMULATION_IDENTITY_CONFLICT",
        `Simulation run ${parsed.simulationRunId} fingerprint mismatch`,
      );
    }
    this.byRunId.set(parsed.simulationRunId, parsed);
    this.byFingerprint.set(parsed.inputFingerprint, parsed);
    return parsed;
  }

  async getBySimulationRunId(
    simulationRunId: string,
  ): Promise<ScenarioSimulationResult | null> {
    return this.byRunId.get(simulationRunId) ?? null;
  }

  async getByInputFingerprint(
    inputFingerprint: string,
  ): Promise<ScenarioSimulationResult | null> {
    return this.byFingerprint.get(inputFingerprint) ?? null;
  }

  async listByScenarioSet(
    scenarioSetId: string,
    scenarioSetVersion: number,
  ): Promise<readonly ScenarioSimulationResult[]> {
    return [...this.byRunId.values()].filter(
      (r) =>
        r.scenarioSetId === scenarioSetId &&
        r.scenarioSetVersion === scenarioSetVersion,
    );
  }
}

export class InMemoryDecisionPackageRepository
  implements DecisionPackageRepository
{
  private readonly packages = new Map<string, StrategicDecisionPackage>();

  private key(decisionProblemId: string, version: number): string {
    return `${decisionProblemId}:${version}`;
  }

  async save(pkg: StrategicDecisionPackage): Promise<StrategicDecisionPackage> {
    const parsed = StrategicDecisionPackageSchema.parse(pkg);
    const k = this.key(
      parsed.decisionProblemId,
      parsed.decisionPackageVersion,
    );
    if (this.packages.has(k)) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `Decision package ${k} already immutable`,
      );
    }
    this.packages.set(k, parsed);
    return parsed;
  }

  async get(
    decisionProblemId: string,
    decisionPackageVersion: number,
  ): Promise<StrategicDecisionPackage | null> {
    return (
      this.packages.get(this.key(decisionProblemId, decisionPackageVersion)) ??
      null
    );
  }

  async getLatest(
    decisionProblemId: string,
  ): Promise<StrategicDecisionPackage | null> {
    const versions = [...this.packages.values()]
      .filter((p) => p.decisionProblemId === decisionProblemId)
      .sort((a, b) => b.decisionPackageVersion - a.decisionPackageVersion);
    return versions[0] ?? null;
  }
}

export class InMemoryStrategySelectionRequestRepository
  implements StrategySelectionRequestRepository
{
  private readonly byId = new Map<string, StrategySelectionRequest>();

  async save(
    request: StrategySelectionRequest,
  ): Promise<StrategySelectionRequest> {
    const parsed = StrategySelectionRequestSchema.parse(request);
    this.byId.set(parsed.selectionId, parsed);
    return parsed;
  }

  async getById(selectionId: string): Promise<StrategySelectionRequest | null> {
    return this.byId.get(selectionId) ?? null;
  }

  async getPending(
    decisionProblemId: string,
  ): Promise<StrategySelectionRequest | null> {
    return (
      [...this.byId.values()].find(
        (r) =>
          r.decisionProblemId === decisionProblemId && r.status === "PENDING",
      ) ?? null
    );
  }

  async saveCas(
    request: StrategySelectionRequest,
    expectedRevision: number,
  ): Promise<StrategySelectionRequest> {
    const existing = this.byId.get(request.selectionId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `Selection request CAS conflict for ${request.selectionId}`,
      );
    }
    const next = StrategySelectionRequestSchema.parse({
      ...request,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.selectionId, next);
    return next;
  }
}

export class InMemoryStrategySelectionRecordRepository
  implements StrategySelectionRecordRepository
{
  private readonly bySelectionId = new Map<string, StrategySelectionRecord>();
  private readonly byProblem = new Map<string, StrategySelectionRecord>();

  async save(
    record: StrategySelectionRecord,
  ): Promise<StrategySelectionRecord> {
    const parsed = StrategySelectionRecordSchema.parse(record);
    this.bySelectionId.set(parsed.selectionId, parsed);
    this.byProblem.set(parsed.decisionProblemId, parsed);
    return parsed;
  }

  async getBySelectionId(
    selectionId: string,
  ): Promise<StrategySelectionRecord | null> {
    return this.bySelectionId.get(selectionId) ?? null;
  }

  async getLatest(
    decisionProblemId: string,
  ): Promise<StrategySelectionRecord | null> {
    return this.byProblem.get(decisionProblemId) ?? null;
  }
}

export class InMemoryScenarioPortfolioLineageRepository
  implements ScenarioPortfolioLineageRepository
{
  private readonly byId = new Map<string, ScenarioPortfolioLineage>();

  async save(
    record: ScenarioPortfolioLineage,
  ): Promise<ScenarioPortfolioLineage> {
    const parsed = ScenarioPortfolioLineageSchema.parse(record);
    this.byId.set(parsed.lineageId, parsed);
    return parsed;
  }

  async getById(lineageId: string): Promise<ScenarioPortfolioLineage | null> {
    return this.byId.get(lineageId) ?? null;
  }

  async listByDecisionProblem(
    decisionProblemId: string,
  ): Promise<readonly ScenarioPortfolioLineage[]> {
    return [...this.byId.values()].filter(
      (r) => r.decisionProblemId === decisionProblemId,
    );
  }
}

export class InMemoryScenarioCalibrationRepository
  implements ScenarioCalibrationRepository
{
  private readonly byId = new Map<string, ScenarioCalibrationRecord>();

  async save(
    record: ScenarioCalibrationRecord,
  ): Promise<ScenarioCalibrationRecord> {
    const parsed = ScenarioCalibrationRecordSchema.parse(record);
    this.byId.set(parsed.calibrationId, parsed);
    return parsed;
  }

  async getById(
    calibrationId: string,
  ): Promise<ScenarioCalibrationRecord | null> {
    return this.byId.get(calibrationId) ?? null;
  }

  async listByDecisionProblem(
    decisionProblemId: string,
  ): Promise<readonly ScenarioCalibrationRecord[]> {
    return [...this.byId.values()].filter(
      (r) => r.decisionProblemId === decisionProblemId,
    );
  }
}

export class InMemorySimulationUsageLedgerRepository
  implements SimulationUsageLedgerRepository
{
  private readonly ledgers = new Map<string, SimulationUsageLedger>();

  async get(decisionProblemId: string): Promise<SimulationUsageLedger | null> {
    return this.ledgers.get(decisionProblemId) ?? null;
  }

  async create(ledger: SimulationUsageLedger): Promise<SimulationUsageLedger> {
    this.ledgers.set(ledger.decisionProblemId, ledger);
    return ledger;
  }

  async saveCas(
    ledger: SimulationUsageLedger,
    expectedRevision: number,
  ): Promise<SimulationUsageLedger> {
    const existing = this.ledgers.get(ledger.decisionProblemId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new ScenarioError(
        "SIMULATION_BUDGET_EXCEEDED",
        `Usage ledger CAS conflict for ${ledger.decisionProblemId}`,
      );
    }
    const next = { ...ledger, recordRevision: expectedRevision + 1 };
    this.ledgers.set(next.decisionProblemId, next);
    return next;
  }
}
