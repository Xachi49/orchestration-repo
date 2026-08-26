import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import {
  parseDecisionProblem,
  type DecisionProblem,
} from "../../../scenarios/decision-problem.js";
import {
  canTransitionDecisionProblem,
  type DecisionProblemState,
} from "../../../scenarios/decision-state.js";
import {
  StrategicDecisionPackageSchema,
  type StrategicDecisionPackage,
} from "../../../scenarios/decision-package.js";
import { ScenarioError } from "../../../scenarios/errors.js";
import {
  ScenarioCalibrationRecordSchema,
  ScenarioPortfolioLineageSchema,
  type ScenarioCalibrationRecord,
  type ScenarioPortfolioLineage,
} from "../../../scenarios/lineage.js";
import {
  ScenarioSetSchema,
  type ScenarioSet,
} from "../../../scenarios/scenario.js";
import {
  ScenarioSimulationResultSchema,
  type ScenarioSimulationResult,
} from "../../../scenarios/simulation-result.js";
import {
  StrategySelectionRecordSchema,
  StrategySelectionRequestSchema,
  type StrategySelectionRecord,
  type StrategySelectionRequest,
} from "../../../scenarios/selection.js";
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
} from "../../../scenarios/repositories.js";

export class PostgresDecisionProblemRepository
  implements DecisionProblemRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async create(problem: DecisionProblem): Promise<DecisionProblem> {
    const parsed = parseDecisionProblem(problem);
    try {
      await this.db.query(
        `INSERT INTO strategic_decision_problems (
           decision_problem_id, primary_project_id, decision_problem_version,
           status, idempotency_key, content_fingerprint, payload,
           record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz)`,
        [
          parsed.decisionProblemId,
          parsed.primaryProjectId,
          parsed.decisionProblemVersion,
          parsed.status,
          parsed.idempotencyKey,
          parsed.contentFingerprint,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
          parsed.updatedAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(decisionProblemId: string): Promise<DecisionProblem | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM strategic_decision_problems
       WHERE decision_problem_id = $1`,
      [decisionProblemId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseDecisionProblem({
      ...hydrateRecord(
        (i) => parseDecisionProblem(i),
        row.payload,
        "strategic_decision_problems",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async getByIdempotencyKey(key: string): Promise<DecisionProblem | null> {
    const result = await this.db.query<{ decision_problem_id: string }>(
      `SELECT decision_problem_id FROM strategic_decision_problems
       WHERE idempotency_key = $1`,
      [key],
    );
    const id = result.rows[0]?.decision_problem_id;
    return id ? this.getById(id) : null;
  }

  async save(
    problem: DecisionProblem,
    expectedRevision: number,
  ): Promise<DecisionProblem> {
    const parsed = parseDecisionProblem({
      ...problem,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE strategic_decision_problems
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz, content_fingerprint = $6
       WHERE decision_problem_id = $1 AND record_revision = $7`,
      [
        parsed.decisionProblemId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        parsed.contentFingerprint,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `CAS conflict for decision problem ${parsed.decisionProblemId}`,
      );
    }
    return parsed;
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
    const existing = await this.getById(decisionProblemId);
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
    return this.save(
      {
        ...existing,
        ...extras,
        status: next,
        updatedAt,
      },
      expectedRevision,
    );
  }

  async listByProject(projectId: string): Promise<readonly DecisionProblem[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM strategic_decision_problems
       WHERE primary_project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((row) =>
      parseDecisionProblem({
        ...hydrateRecord(
          (i) => parseDecisionProblem(i),
          row.payload,
          "strategic_decision_problems",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async listByStates(
    states: readonly DecisionProblemState[],
    limit: number,
  ): Promise<readonly DecisionProblem[]> {
    if (states.length === 0 || limit <= 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM strategic_decision_problems
       WHERE status = ANY($1::text[])
       ORDER BY updated_at ASC, decision_problem_id ASC
       LIMIT $2`,
      [[...states], limit],
    );
    return result.rows.map((row) =>
      parseDecisionProblem({
        ...hydrateRecord(
          (i) => parseDecisionProblem(i),
          row.payload,
          "strategic_decision_problems",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresScenarioSetRepository implements ScenarioSetRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(set: ScenarioSet): Promise<ScenarioSet> {
    const parsed = ScenarioSetSchema.parse(set);
    try {
      await this.db.query(
        `INSERT INTO scenario_sets (
           decision_problem_id, scenario_set_version, scenario_set_hash,
           payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
        [
          parsed.decisionProblemId,
          parsed.scenarioSetVersion,
          parsed.scenarioSetHash,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async get(
    decisionProblemId: string,
    scenarioSetVersion: number,
  ): Promise<ScenarioSet | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_sets
       WHERE decision_problem_id = $1 AND scenario_set_version = $2`,
      [decisionProblemId, scenarioSetVersion],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ScenarioSetSchema.parse(i),
          row.payload,
          "scenario_sets",
        )
      : null;
  }

  async getLatest(decisionProblemId: string): Promise<ScenarioSet | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_sets
       WHERE decision_problem_id = $1
       ORDER BY scenario_set_version DESC LIMIT 1`,
      [decisionProblemId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ScenarioSetSchema.parse(i),
          row.payload,
          "scenario_sets",
        )
      : null;
  }
}

export class PostgresSimulationResultRepository
  implements SimulationResultRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(result: ScenarioSimulationResult): Promise<ScenarioSimulationResult> {
    const parsed = ScenarioSimulationResultSchema.parse(result);
    try {
      await this.db.query(
        `INSERT INTO scenario_simulation_results (
           simulation_run_id, decision_problem_id, scenario_set_id,
           scenario_set_version, input_fingerprint, payload, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)`,
        [
          parsed.simulationRunId,
          parsed.decisionProblemId,
          parsed.scenarioSetId,
          parsed.scenarioSetVersion,
          parsed.inputFingerprint,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getBySimulationRunId(
    simulationRunId: string,
  ): Promise<ScenarioSimulationResult | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_simulation_results
       WHERE simulation_run_id = $1`,
      [simulationRunId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ScenarioSimulationResultSchema.parse(i),
          row.payload,
          "scenario_simulation_results",
        )
      : null;
  }

  async getByInputFingerprint(
    inputFingerprint: string,
  ): Promise<ScenarioSimulationResult | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_simulation_results
       WHERE input_fingerprint = $1`,
      [inputFingerprint],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ScenarioSimulationResultSchema.parse(i),
          row.payload,
          "scenario_simulation_results",
        )
      : null;
  }

  async listByScenarioSet(
    scenarioSetId: string,
    scenarioSetVersion: number,
  ): Promise<readonly ScenarioSimulationResult[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_simulation_results
       WHERE scenario_set_id = $1 AND scenario_set_version = $2`,
      [scenarioSetId, scenarioSetVersion],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ScenarioSimulationResultSchema.parse(i),
        row.payload,
        "scenario_simulation_results",
      ),
    );
  }
}

export class PostgresDecisionPackageRepository
  implements DecisionPackageRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(pkg: StrategicDecisionPackage): Promise<StrategicDecisionPackage> {
    const parsed = StrategicDecisionPackageSchema.parse(pkg);
    try {
      await this.db.query(
        `INSERT INTO strategic_decision_packages (
           decision_problem_id, decision_package_version,
           decision_package_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
        [
          parsed.decisionProblemId,
          parsed.decisionPackageVersion,
          parsed.decisionPackageHash,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async get(
    decisionProblemId: string,
    decisionPackageVersion: number,
  ): Promise<StrategicDecisionPackage | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM strategic_decision_packages
       WHERE decision_problem_id = $1 AND decision_package_version = $2`,
      [decisionProblemId, decisionPackageVersion],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => StrategicDecisionPackageSchema.parse(i),
          row.payload,
          "strategic_decision_packages",
        )
      : null;
  }

  async getLatest(
    decisionProblemId: string,
  ): Promise<StrategicDecisionPackage | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM strategic_decision_packages
       WHERE decision_problem_id = $1
       ORDER BY decision_package_version DESC LIMIT 1`,
      [decisionProblemId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => StrategicDecisionPackageSchema.parse(i),
          row.payload,
          "strategic_decision_packages",
        )
      : null;
  }
}

export class PostgresStrategySelectionRequestRepository
  implements StrategySelectionRequestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    request: StrategySelectionRequest,
  ): Promise<StrategySelectionRequest> {
    const parsed = StrategySelectionRequestSchema.parse(request);
    await this.db.query(
      `INSERT INTO strategy_selection_requests (
         selection_id, decision_problem_id, status, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (selection_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.selectionId,
        parsed.decisionProblemId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(selectionId: string): Promise<StrategySelectionRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM strategy_selection_requests WHERE selection_id = $1`,
      [selectionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => StrategySelectionRequestSchema.parse(i),
          row.payload,
          "strategy_selection_requests",
        )
      : null;
  }

  async getPending(
    decisionProblemId: string,
  ): Promise<StrategySelectionRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM strategy_selection_requests
       WHERE decision_problem_id = $1 AND status = 'PENDING'
       ORDER BY updated_at DESC LIMIT 1`,
      [decisionProblemId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => StrategySelectionRequestSchema.parse(i),
          row.payload,
          "strategy_selection_requests",
        )
      : null;
  }

  async saveCas(
    request: StrategySelectionRequest,
    expectedRevision: number,
  ): Promise<StrategySelectionRequest> {
    const parsed = StrategySelectionRequestSchema.parse({
      ...request,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE strategy_selection_requests
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz
       WHERE selection_id = $1 AND record_revision = $6`,
      [
        parsed.selectionId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ScenarioError(
        "DECISION_PROBLEM_CAS_CONFLICT",
        `Selection request CAS conflict for ${parsed.selectionId}`,
      );
    }
    return parsed;
  }
}

export class PostgresStrategySelectionRecordRepository
  implements StrategySelectionRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: StrategySelectionRecord,
  ): Promise<StrategySelectionRecord> {
    const parsed = StrategySelectionRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO strategy_selection_records (
         selection_record_id, selection_id, decision_problem_id,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (selection_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.selectionRecordId,
        parsed.selectionId,
        parsed.decisionProblemId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getBySelectionId(
    selectionId: string,
  ): Promise<StrategySelectionRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM strategy_selection_records WHERE selection_id = $1`,
      [selectionId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => StrategySelectionRecordSchema.parse(i),
          row.payload,
          "strategy_selection_records",
        )
      : null;
  }

  async getLatest(
    decisionProblemId: string,
  ): Promise<StrategySelectionRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM strategy_selection_records
       WHERE decision_problem_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [decisionProblemId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => StrategySelectionRecordSchema.parse(i),
          row.payload,
          "strategy_selection_records",
        )
      : null;
  }
}

export class PostgresScenarioPortfolioLineageRepository
  implements ScenarioPortfolioLineageRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ScenarioPortfolioLineage,
  ): Promise<ScenarioPortfolioLineage> {
    const parsed = ScenarioPortfolioLineageSchema.parse(record);
    await this.db.query(
      `INSERT INTO scenario_portfolio_lineage (
         lineage_id, decision_problem_id, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz)
       ON CONFLICT (lineage_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.lineageId,
        parsed.decisionProblemId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(lineageId: string): Promise<ScenarioPortfolioLineage | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_portfolio_lineage WHERE lineage_id = $1`,
      [lineageId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ScenarioPortfolioLineageSchema.parse(i),
          row.payload,
          "scenario_portfolio_lineage",
        )
      : null;
  }

  async listByDecisionProblem(
    decisionProblemId: string,
  ): Promise<readonly ScenarioPortfolioLineage[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_portfolio_lineage
       WHERE decision_problem_id = $1`,
      [decisionProblemId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ScenarioPortfolioLineageSchema.parse(i),
        row.payload,
        "scenario_portfolio_lineage",
      ),
    );
  }
}

export class PostgresScenarioCalibrationRepository
  implements ScenarioCalibrationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ScenarioCalibrationRecord,
  ): Promise<ScenarioCalibrationRecord> {
    const parsed = ScenarioCalibrationRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO scenario_calibration_records (
         calibration_id, decision_problem_id, scenario_id,
         payload, observed_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (calibration_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.calibrationId,
        parsed.decisionProblemId,
        parsed.scenarioId,
        JSON.stringify(parsed),
        parsed.observedAt,
      ],
    );
    return parsed;
  }

  async getById(
    calibrationId: string,
  ): Promise<ScenarioCalibrationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_calibration_records WHERE calibration_id = $1`,
      [calibrationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ScenarioCalibrationRecordSchema.parse(i),
          row.payload,
          "scenario_calibration_records",
        )
      : null;
  }

  async listByDecisionProblem(
    decisionProblemId: string,
  ): Promise<readonly ScenarioCalibrationRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM scenario_calibration_records
       WHERE decision_problem_id = $1 ORDER BY observed_at DESC`,
      [decisionProblemId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ScenarioCalibrationRecordSchema.parse(i),
        row.payload,
        "scenario_calibration_records",
      ),
    );
  }
}

export class PostgresSimulationUsageLedgerRepository
  implements SimulationUsageLedgerRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async get(decisionProblemId: string): Promise<SimulationUsageLedger | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM simulation_usage_ledgers
       WHERE decision_problem_id = $1`,
      [decisionProblemId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      ...(row.payload as SimulationUsageLedger),
      recordRevision: Number(row.record_revision),
    };
  }

  async create(ledger: SimulationUsageLedger): Promise<SimulationUsageLedger> {
    await this.db.query(
      `INSERT INTO simulation_usage_ledgers (
         decision_problem_id, payload, record_revision, updated_at
       ) VALUES ($1,$2::jsonb,$3,$4::timestamptz)`,
      [
        ledger.decisionProblemId,
        JSON.stringify(ledger),
        ledger.recordRevision,
        ledger.updatedAt,
      ],
    );
    return ledger;
  }

  async saveCas(
    ledger: SimulationUsageLedger,
    expectedRevision: number,
  ): Promise<SimulationUsageLedger> {
    const next = { ...ledger, recordRevision: expectedRevision + 1 };
    const result = await this.db.query(
      `UPDATE simulation_usage_ledgers
       SET payload = $2::jsonb, record_revision = $3, updated_at = $4::timestamptz
       WHERE decision_problem_id = $1 AND record_revision = $5`,
      [
        next.decisionProblemId,
        JSON.stringify(next),
        next.recordRevision,
        next.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ScenarioError(
        "SIMULATION_BUDGET_EXCEEDED",
        `Usage ledger CAS conflict for ${next.decisionProblemId}`,
      );
    }
    return next;
  }
}
