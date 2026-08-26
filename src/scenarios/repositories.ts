import type { DecisionProblem } from "./decision-problem.js";
import type { DecisionProblemState } from "./decision-state.js";
import type { StrategicDecisionPackage } from "./decision-package.js";
import type {
  ScenarioCalibrationRecord,
  ScenarioPortfolioLineage,
} from "./lineage.js";
import type { ScenarioSet } from "./scenario.js";
import type { ScenarioSimulationResult } from "./simulation-result.js";
import type {
  StrategySelectionRecord,
  StrategySelectionRequest,
} from "./selection.js";

export interface DecisionProblemRepository {
  create(problem: DecisionProblem): Promise<DecisionProblem>;
  getById(decisionProblemId: string): Promise<DecisionProblem | null>;
  getByIdempotencyKey(key: string): Promise<DecisionProblem | null>;
  save(
    problem: DecisionProblem,
    expectedRevision: number,
  ): Promise<DecisionProblem>;
  transition(
    decisionProblemId: string,
    expected: DecisionProblemState,
    expectedRevision: number,
    next: DecisionProblemState,
    updatedAt: string,
    extras?: Partial<
      Pick<
        DecisionProblem,
        | "scenarioSetVersion"
        | "scenarioSetHash"
        | "decisionPackageHash"
        | "truthSnapshotFingerprint"
        | "failureReasonCode"
      >
    >,
  ): Promise<DecisionProblem>;
  listByProject(projectId: string): Promise<readonly DecisionProblem[]>;
  listByStates(
    states: readonly DecisionProblemState[],
    limit: number,
  ): Promise<readonly DecisionProblem[]>;
}

export interface ScenarioSetRepository {
  save(set: ScenarioSet): Promise<ScenarioSet>;
  get(
    decisionProblemId: string,
    scenarioSetVersion: number,
  ): Promise<ScenarioSet | null>;
  getLatest(decisionProblemId: string): Promise<ScenarioSet | null>;
}

export interface SimulationResultRepository {
  save(result: ScenarioSimulationResult): Promise<ScenarioSimulationResult>;
  getBySimulationRunId(
    simulationRunId: string,
  ): Promise<ScenarioSimulationResult | null>;
  getByInputFingerprint(
    inputFingerprint: string,
  ): Promise<ScenarioSimulationResult | null>;
  listByScenarioSet(
    scenarioSetId: string,
    scenarioSetVersion: number,
  ): Promise<readonly ScenarioSimulationResult[]>;
}

export interface DecisionPackageRepository {
  save(pkg: StrategicDecisionPackage): Promise<StrategicDecisionPackage>;
  get(
    decisionProblemId: string,
    decisionPackageVersion: number,
  ): Promise<StrategicDecisionPackage | null>;
  getLatest(
    decisionProblemId: string,
  ): Promise<StrategicDecisionPackage | null>;
}

export interface StrategySelectionRequestRepository {
  save(request: StrategySelectionRequest): Promise<StrategySelectionRequest>;
  getById(selectionId: string): Promise<StrategySelectionRequest | null>;
  getPending(
    decisionProblemId: string,
  ): Promise<StrategySelectionRequest | null>;
  saveCas(
    request: StrategySelectionRequest,
    expectedRevision: number,
  ): Promise<StrategySelectionRequest>;
}

export interface StrategySelectionRecordRepository {
  save(record: StrategySelectionRecord): Promise<StrategySelectionRecord>;
  getBySelectionId(
    selectionId: string,
  ): Promise<StrategySelectionRecord | null>;
  getLatest(
    decisionProblemId: string,
  ): Promise<StrategySelectionRecord | null>;
}

export interface ScenarioPortfolioLineageRepository {
  save(record: ScenarioPortfolioLineage): Promise<ScenarioPortfolioLineage>;
  getById(lineageId: string): Promise<ScenarioPortfolioLineage | null>;
  listByDecisionProblem(
    decisionProblemId: string,
  ): Promise<readonly ScenarioPortfolioLineage[]>;
}

export interface ScenarioCalibrationRepository {
  save(record: ScenarioCalibrationRecord): Promise<ScenarioCalibrationRecord>;
  getById(calibrationId: string): Promise<ScenarioCalibrationRecord | null>;
  listByDecisionProblem(
    decisionProblemId: string,
  ): Promise<readonly ScenarioCalibrationRecord[]>;
}

export const SimulationUsageLedgerSchema = {
  // Type-only reference; concrete schema lives in memory-repositories usage.
} as const;

export interface SimulationUsageLedger {
  decisionProblemId: string;
  scenarioCount: number;
  simRuns: number;
  modelCalls: number;
  sensitivityEvals: number;
  recordRevision: number;
  updatedAt: string;
}

export interface SimulationUsageLedgerRepository {
  get(decisionProblemId: string): Promise<SimulationUsageLedger | null>;
  create(ledger: SimulationUsageLedger): Promise<SimulationUsageLedger>;
  saveCas(
    ledger: SimulationUsageLedger,
    expectedRevision: number,
  ): Promise<SimulationUsageLedger>;
}
