import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import {
  parseProgram,
  type Program,
} from "../../../programs/program.js";
import {
  parseProgramPlan,
  type ProgramPlan,
} from "../../../programs/program-plan.js";
import {
  ProgramBudgetLedgerSchema,
  ProgramBudgetReservationSchema,
  type ProgramBudgetLedger,
  type ProgramBudgetReservation,
} from "../../../programs/budget.js";
import {
  ProgramCompletionRecordSchema,
  ProgramLineageRecordSchema,
  ProgramMaterializationApprovalSchema,
  type ProgramCompletionRecord,
  type ProgramLineageRecord,
  type ProgramMaterializationApproval,
} from "../../../programs/lineage.js";
import { ProgramError } from "../../../programs/errors.js";
import {
  canTransitionProgram,
  type ProgramState,
} from "../../../programs/program-state.js";
import type {
  ProgramBudgetLedgerRepository,
  ProgramBudgetReservationRepository,
  ProgramCompletionRepository,
  ProgramLineageRepository,
  ProgramMaterializationApprovalRepository,
  ProgramPlanRepository,
  ProgramRepository,
} from "../../../programs/repositories.js";

export class PostgresProgramRepository implements ProgramRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async create(program: Program): Promise<Program> {
    const parsed = parseProgram(program);
    try {
      await this.db.query(
        `INSERT INTO programs (
           program_id, project_id, program_version, status, idempotency_key,
           content_fingerprint, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz)`,
        [
          parsed.programId,
          parsed.projectId,
          parsed.programVersion,
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

  async getById(programId: string): Promise<Program | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(`SELECT payload, record_revision FROM programs WHERE program_id = $1`, [
      programId,
    ]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parseProgram({
      ...hydrateRecord((i) => parseProgram(i), row.payload, "programs"),
      recordRevision: Number(row.record_revision),
    });
  }

  async getByIdempotencyKey(key: string): Promise<Program | null> {
    const result = await this.db.query<{ program_id: string }>(
      `SELECT program_id FROM programs WHERE idempotency_key = $1`,
      [key],
    );
    const id = result.rows[0]?.program_id;
    return id ? this.getById(id) : null;
  }

  async save(program: Program, expectedRevision: number): Promise<Program> {
    const parsed = parseProgram({
      ...program,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE programs
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz, content_fingerprint = $6
       WHERE program_id = $1 AND record_revision = $7`,
      [
        parsed.programId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        parsed.contentFingerprint,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ProgramError(
        "PROGRAM_CAS_CONFLICT",
        `CAS conflict for program ${parsed.programId}`,
      );
    }
    return parsed;
  }

  async transition(
    programId: string,
    expected: ProgramState,
    expectedRevision: number,
    next: ProgramState,
    updatedAt: string,
    extras: Partial<
      Pick<
        Program,
        | "programPlanVersion"
        | "programPlanHash"
        | "decompositionRevisionCount"
        | "failureReasonCode"
        | "paused"
      >
    > = {},
  ): Promise<Program> {
    const existing = await this.getById(programId);
    if (!existing) {
      throw new ProgramError("PROGRAM_NOT_FOUND", `Program ${programId} missing`);
    }
    if (
      existing.status !== expected ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new ProgramError(
        "PROGRAM_STATE_CONFLICT",
        `Program ${programId} state/revision mismatch`,
      );
    }
    if (!canTransitionProgram(expected, next)) {
      throw new ProgramError(
        "INVALID_PROGRAM_TRANSITION",
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

  async listByProject(projectId: string): Promise<readonly Program[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM programs
       WHERE project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((row) =>
      parseProgram({
        ...hydrateRecord((i) => parseProgram(i), row.payload, "programs"),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async listByStates(
    states: readonly ProgramState[],
    limit: number,
  ): Promise<readonly Program[]> {
    if (states.length === 0 || limit <= 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM programs
       WHERE status = ANY($1::text[])
       ORDER BY updated_at ASC, program_id ASC
       LIMIT $2`,
      [[...states], limit],
    );
    return result.rows.map((row) =>
      parseProgram({
        ...hydrateRecord((i) => parseProgram(i), row.payload, "programs"),
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresProgramPlanRepository implements ProgramPlanRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(plan: ProgramPlan): Promise<ProgramPlan> {
    const parsed = parseProgramPlan(plan);
    try {
      await this.db.query(
        `INSERT INTO program_plans (
           program_id, program_plan_version, program_plan_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
        [
          parsed.programId,
          parsed.programPlanVersion,
          parsed.programPlanHash,
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
    programId: string,
    programPlanVersion: number,
  ): Promise<ProgramPlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_plans
       WHERE program_id = $1 AND program_plan_version = $2`,
      [programId, programPlanVersion],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord((i) => parseProgramPlan(i), row.payload, "program_plans")
      : null;
  }

  async getLatest(programId: string): Promise<ProgramPlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_plans
       WHERE program_id = $1
       ORDER BY program_plan_version DESC LIMIT 1`,
      [programId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord((i) => parseProgramPlan(i), row.payload, "program_plans")
      : null;
  }
}

export class PostgresProgramBudgetLedgerRepository
  implements ProgramBudgetLedgerRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async create(ledger: ProgramBudgetLedger): Promise<ProgramBudgetLedger> {
    const parsed = ProgramBudgetLedgerSchema.parse(ledger);
    await this.db.query(
      `INSERT INTO program_budget_ledgers (program_id, payload, record_revision, updated_at)
       VALUES ($1,$2::jsonb,$3,$4::timestamptz)`,
      [
        parsed.programId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async get(programId: string): Promise<ProgramBudgetLedger | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM program_budget_ledgers WHERE program_id = $1`,
      [programId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return ProgramBudgetLedgerSchema.parse({
      ...hydrateRecord(
        (i) => ProgramBudgetLedgerSchema.parse(i),
        row.payload,
        "program_budget_ledgers",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async saveCas(
    ledger: ProgramBudgetLedger,
    expectedRevision: number,
  ): Promise<ProgramBudgetLedger> {
    const parsed = ProgramBudgetLedgerSchema.parse({
      ...ledger,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE program_budget_ledgers
       SET payload = $2::jsonb, record_revision = $3, updated_at = $4::timestamptz
       WHERE program_id = $1 AND record_revision = $5`,
      [
        parsed.programId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new ProgramError(
        "PROGRAM_BUDGET_OVER_ALLOCATION",
        `Budget CAS conflict for ${parsed.programId}`,
      );
    }
    return parsed;
  }
}

export class PostgresProgramBudgetReservationRepository
  implements ProgramBudgetReservationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    reservation: ProgramBudgetReservation,
  ): Promise<ProgramBudgetReservation> {
    const parsed = ProgramBudgetReservationSchema.parse(reservation);
    await this.db.query(
      `INSERT INTO program_budget_reservations (
         reservation_id, program_id, node_id, payload, record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (reservation_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.reservationId,
        parsed.programId,
        parsed.nodeId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(
    reservationId: string,
  ): Promise<ProgramBudgetReservation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_budget_reservations WHERE reservation_id = $1`,
      [reservationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ProgramBudgetReservationSchema.parse(i),
          row.payload,
          "program_budget_reservations",
        )
      : null;
  }

  async listByProgram(
    programId: string,
  ): Promise<readonly ProgramBudgetReservation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_budget_reservations WHERE program_id = $1`,
      [programId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ProgramBudgetReservationSchema.parse(i),
        row.payload,
        "program_budget_reservations",
      ),
    );
  }
}

export class PostgresProgramLineageRepository
  implements ProgramLineageRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(record: ProgramLineageRecord): Promise<ProgramLineageRecord> {
    const parsed = ProgramLineageRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO program_lineage (
         lineage_id, program_id, program_plan_version, node_id, child_run_id,
         payload, record_revision, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz)
       ON CONFLICT (lineage_id) DO UPDATE
       SET child_run_id = EXCLUDED.child_run_id,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.lineageId,
        parsed.programId,
        parsed.programPlanVersion,
        parsed.nodeId,
        parsed.childRunId ?? null,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(lineageId: string): Promise<ProgramLineageRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_lineage WHERE lineage_id = $1`,
      [lineageId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ProgramLineageRecordSchema.parse(i),
          row.payload,
          "program_lineage",
        )
      : null;
  }

  async listByProgram(
    programId: string,
  ): Promise<readonly ProgramLineageRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_lineage WHERE program_id = $1`,
      [programId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ProgramLineageRecordSchema.parse(i),
        row.payload,
        "program_lineage",
      ),
    );
  }

  async listByPlan(
    programId: string,
    programPlanVersion: number,
  ): Promise<readonly ProgramLineageRecord[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_lineage
       WHERE program_id = $1 AND program_plan_version = $2`,
      [programId, programPlanVersion],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => ProgramLineageRecordSchema.parse(i),
        row.payload,
        "program_lineage",
      ),
    );
  }
}

export class PostgresProgramMaterializationApprovalRepository
  implements ProgramMaterializationApprovalRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    approval: ProgramMaterializationApproval,
  ): Promise<ProgramMaterializationApproval> {
    const parsed = ProgramMaterializationApprovalSchema.parse(approval);
    await this.db.query(
      `INSERT INTO program_materialization_approvals (
         approval_id, program_id, status, payload, record_revision, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (approval_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision`,
      [
        parsed.approvalId,
        parsed.programId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(
    approvalId: string,
  ): Promise<ProgramMaterializationApproval | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_materialization_approvals WHERE approval_id = $1`,
      [approvalId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ProgramMaterializationApprovalSchema.parse(i),
          row.payload,
          "program_materialization_approvals",
        )
      : null;
  }

  async getPendingByProgram(
    programId: string,
  ): Promise<ProgramMaterializationApproval | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_materialization_approvals
       WHERE program_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC LIMIT 1`,
      [programId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ProgramMaterializationApprovalSchema.parse(i),
          row.payload,
          "program_materialization_approvals",
        )
      : null;
  }
}

export class PostgresProgramCompletionRepository
  implements ProgramCompletionRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: ProgramCompletionRecord,
  ): Promise<ProgramCompletionRecord> {
    const parsed = ProgramCompletionRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO program_completion_records (
         program_completion_record_id, program_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (program_id) DO NOTHING`,
      [
        parsed.programCompletionRecordId,
        parsed.programId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return (await this.getByProgram(parsed.programId)) ?? parsed;
  }

  async getByProgram(
    programId: string,
  ): Promise<ProgramCompletionRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM program_completion_records WHERE program_id = $1`,
      [programId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => ProgramCompletionRecordSchema.parse(i),
          row.payload,
          "program_completion_records",
        )
      : null;
  }
}
