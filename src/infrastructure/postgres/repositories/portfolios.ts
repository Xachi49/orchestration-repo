import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import {
  parsePortfolio,
  type Portfolio,
} from "../../../portfolio/portfolio.js";
import {
  PortfolioPlanSchema,
  type PortfolioPlan,
} from "../../../portfolio/plan.js";
import {
  PortfolioBudgetLedgerSchema,
  PortfolioBudgetReservationSchema,
  type PortfolioBudgetLedger,
  type PortfolioBudgetReservation,
} from "../../../portfolio/budget.js";
import {
  PortfolioAuthorizationRecordSchema,
  PortfolioAuthorizationRequestSchema,
  PortfolioCompletionRecordSchema,
  PortfolioProgramLineageSchema,
  PortfolioRebalanceProposalSchema,
  type PortfolioAuthorizationRecord,
  type PortfolioAuthorizationRequest,
  type PortfolioCompletionRecord,
  type PortfolioProgramLineage,
  type PortfolioRebalanceProposal,
} from "../../../portfolio/lineage.js";
import { PortfolioError } from "../../../portfolio/errors.js";
import {
  canTransitionPortfolio,
  type PortfolioState,
} from "../../../portfolio/portfolio-state.js";
import type {
  PortfolioAuthorizationRecordRepository,
  PortfolioAuthorizationRequestRepository,
  PortfolioBudgetLedgerRepository,
  PortfolioBudgetReservationRepository,
  PortfolioCompletionRepository,
  PortfolioPlanRepository,
  PortfolioProgramLineageRepository,
  PortfolioRebalanceRepository,
  PortfolioRepository,
} from "../../../portfolio/repositories.js";

export class PostgresPortfolioRepository implements PortfolioRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async create(portfolio: Portfolio): Promise<Portfolio> {
    const parsed = parsePortfolio(portfolio);
    try {
      await this.db.query(
        `INSERT INTO portfolios (
           portfolio_id, primary_project_id, portfolio_version, status,
           idempotency_key, content_fingerprint, payload, record_revision,
           created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::timestamptz,$10::timestamptz)`,
        [
          parsed.portfolioId,
          parsed.primaryProjectId,
          parsed.portfolioVersion,
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

  async getById(portfolioId: string): Promise<Portfolio | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM portfolios WHERE portfolio_id = $1`,
      [portfolioId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return parsePortfolio({
      ...hydrateRecord((i) => parsePortfolio(i), row.payload, "portfolios"),
      recordRevision: Number(row.record_revision),
    });
  }

  async getByIdempotencyKey(key: string): Promise<Portfolio | null> {
    const result = await this.db.query<{ portfolio_id: string }>(
      `SELECT portfolio_id FROM portfolios WHERE idempotency_key = $1`,
      [key],
    );
    const id = result.rows[0]?.portfolio_id;
    return id ? this.getById(id) : null;
  }

  async save(portfolio: Portfolio, expectedRevision: number): Promise<Portfolio> {
    const parsed = parsePortfolio({
      ...portfolio,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE portfolios
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz, content_fingerprint = $6
       WHERE portfolio_id = $1 AND record_revision = $7`,
      [
        parsed.portfolioId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        parsed.contentFingerprint,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new PortfolioError(
        "PORTFOLIO_CAS_CONFLICT",
        `CAS conflict for portfolio ${parsed.portfolioId}`,
      );
    }
    return parsed;
  }

  async transition(
    portfolioId: string,
    expected: PortfolioState,
    expectedRevision: number,
    next: PortfolioState,
    updatedAt: string,
    extras: Partial<
      Pick<
        Portfolio,
        | "portfolioPlanVersion"
        | "portfolioPlanHash"
        | "failureReasonCode"
        | "failureClass"
        | "paused"
      >
    > = {},
  ): Promise<Portfolio> {
    const existing = await this.getById(portfolioId);
    if (!existing) {
      throw new PortfolioError(
        "PORTFOLIO_NOT_FOUND",
        `Portfolio ${portfolioId} missing`,
      );
    }
    if (
      existing.status !== expected ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new PortfolioError(
        "PORTFOLIO_STATE_CONFLICT",
        `Portfolio ${portfolioId} state/revision mismatch`,
      );
    }
    if (!canTransitionPortfolio(expected, next)) {
      throw new PortfolioError(
        "INVALID_PORTFOLIO_TRANSITION",
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

  async listByProject(projectId: string): Promise<readonly Portfolio[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM portfolios
       WHERE primary_project_id = $1 ORDER BY created_at ASC`,
      [projectId],
    );
    return result.rows.map((row) =>
      parsePortfolio({
        ...hydrateRecord((i) => parsePortfolio(i), row.payload, "portfolios"),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async listByStates(
    states: readonly PortfolioState[],
    limit: number,
  ): Promise<readonly Portfolio[]> {
    if (states.length === 0 || limit <= 0) {
      return [];
    }
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM portfolios
       WHERE status = ANY($1::text[])
       ORDER BY updated_at ASC, portfolio_id ASC
       LIMIT $2`,
      [[...states], limit],
    );
    return result.rows.map((row) =>
      parsePortfolio({
        ...hydrateRecord((i) => parsePortfolio(i), row.payload, "portfolios"),
        recordRevision: Number(row.record_revision),
      }),
    );
  }
}

export class PostgresPortfolioPlanRepository implements PortfolioPlanRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(plan: PortfolioPlan): Promise<PortfolioPlan> {
    const parsed = PortfolioPlanSchema.parse(plan);
    try {
      await this.db.query(
        `INSERT INTO portfolio_plans (
           portfolio_id, portfolio_plan_version, portfolio_plan_hash,
           payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)`,
        [
          parsed.portfolioId,
          parsed.portfolioPlanVersion,
          parsed.portfolioPlanHash,
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
    portfolioId: string,
    portfolioPlanVersion: number,
  ): Promise<PortfolioPlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_plans
       WHERE portfolio_id = $1 AND portfolio_plan_version = $2`,
      [portfolioId, portfolioPlanVersion],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioPlanSchema.parse(i),
          row.payload,
          "portfolio_plans",
        )
      : null;
  }

  async getLatest(portfolioId: string): Promise<PortfolioPlan | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_plans
       WHERE portfolio_id = $1
       ORDER BY portfolio_plan_version DESC LIMIT 1`,
      [portfolioId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioPlanSchema.parse(i),
          row.payload,
          "portfolio_plans",
        )
      : null;
  }
}

export class PostgresPortfolioBudgetLedgerRepository
  implements PortfolioBudgetLedgerRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async create(ledger: PortfolioBudgetLedger): Promise<PortfolioBudgetLedger> {
    const parsed = PortfolioBudgetLedgerSchema.parse(ledger);
    await this.db.query(
      `INSERT INTO portfolio_budget_ledgers (portfolio_id, payload, record_revision, updated_at)
       VALUES ($1,$2::jsonb,$3,$4::timestamptz)`,
      [
        parsed.portfolioId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async get(portfolioId: string): Promise<PortfolioBudgetLedger | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM portfolio_budget_ledgers WHERE portfolio_id = $1`,
      [portfolioId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return PortfolioBudgetLedgerSchema.parse({
      ...hydrateRecord(
        (i) => PortfolioBudgetLedgerSchema.parse(i),
        row.payload,
        "portfolio_budget_ledgers",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async saveCas(
    ledger: PortfolioBudgetLedger,
    expectedRevision: number,
  ): Promise<PortfolioBudgetLedger> {
    const parsed = PortfolioBudgetLedgerSchema.parse({
      ...ledger,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE portfolio_budget_ledgers
       SET payload = $2::jsonb, record_revision = $3, updated_at = $4::timestamptz
       WHERE portfolio_id = $1 AND record_revision = $5`,
      [
        parsed.portfolioId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new PortfolioError(
        "PORTFOLIO_BUDGET_OVER_ALLOCATION",
        `Budget CAS conflict for ${parsed.portfolioId}`,
      );
    }
    return parsed;
  }
}

export class PostgresPortfolioBudgetReservationRepository
  implements PortfolioBudgetReservationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    reservation: PortfolioBudgetReservation,
  ): Promise<PortfolioBudgetReservation> {
    const parsed = PortfolioBudgetReservationSchema.parse(reservation);
    await this.db.query(
      `INSERT INTO portfolio_budget_reservations (
         reservation_id, portfolio_id, proposal_id, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (reservation_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.reservationId,
        parsed.portfolioId,
        parsed.proposalId,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(
    reservationId: string,
  ): Promise<PortfolioBudgetReservation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_budget_reservations WHERE reservation_id = $1`,
      [reservationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioBudgetReservationSchema.parse(i),
          row.payload,
          "portfolio_budget_reservations",
        )
      : null;
  }

  async listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioBudgetReservation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_budget_reservations WHERE portfolio_id = $1`,
      [portfolioId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => PortfolioBudgetReservationSchema.parse(i),
        row.payload,
        "portfolio_budget_reservations",
      ),
    );
  }
}

export class PostgresPortfolioProgramLineageRepository
  implements PortfolioProgramLineageRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(record: PortfolioProgramLineage): Promise<PortfolioProgramLineage> {
    const parsed = PortfolioProgramLineageSchema.parse(record);
    await this.db.query(
      `INSERT INTO portfolio_program_lineage (
         lineage_id, portfolio_id, portfolio_plan_version, proposal_id,
         program_id, payload, record_revision, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz)
       ON CONFLICT (lineage_id) DO UPDATE
       SET program_id = EXCLUDED.program_id,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.lineageId,
        parsed.portfolioId,
        parsed.portfolioPlanVersion,
        parsed.proposalId,
        parsed.programId ?? null,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.updatedAt,
      ],
    );
    return parsed;
  }

  async getById(lineageId: string): Promise<PortfolioProgramLineage | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_program_lineage WHERE lineage_id = $1`,
      [lineageId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioProgramLineageSchema.parse(i),
          row.payload,
          "portfolio_program_lineage",
        )
      : null;
  }

  async listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioProgramLineage[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_program_lineage WHERE portfolio_id = $1`,
      [portfolioId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => PortfolioProgramLineageSchema.parse(i),
        row.payload,
        "portfolio_program_lineage",
      ),
    );
  }

  async listByPlan(
    portfolioId: string,
    portfolioPlanVersion: number,
  ): Promise<readonly PortfolioProgramLineage[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_program_lineage
       WHERE portfolio_id = $1 AND portfolio_plan_version = $2`,
      [portfolioId, portfolioPlanVersion],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => PortfolioProgramLineageSchema.parse(i),
        row.payload,
        "portfolio_program_lineage",
      ),
    );
  }
}

export class PostgresPortfolioAuthorizationRequestRepository
  implements PortfolioAuthorizationRequestRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    request: PortfolioAuthorizationRequest,
  ): Promise<PortfolioAuthorizationRequest> {
    const parsed = PortfolioAuthorizationRequestSchema.parse(request);
    await this.db.query(
      `INSERT INTO portfolio_authorization_requests (
         authorization_id, portfolio_id, status, payload,
         record_revision, updated_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6::timestamptz)
       ON CONFLICT (authorization_id) DO UPDATE
       SET status = EXCLUDED.status,
           payload = EXCLUDED.payload,
           record_revision = EXCLUDED.record_revision,
           updated_at = EXCLUDED.updated_at`,
      [
        parsed.authorizationId,
        parsed.portfolioId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getById(
    authorizationId: string,
  ): Promise<PortfolioAuthorizationRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_authorization_requests WHERE authorization_id = $1`,
      [authorizationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioAuthorizationRequestSchema.parse(i),
          row.payload,
          "portfolio_authorization_requests",
        )
      : null;
  }

  async getPending(
    portfolioId: string,
  ): Promise<PortfolioAuthorizationRequest | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_authorization_requests
       WHERE portfolio_id = $1 AND status = 'PENDING'
       ORDER BY updated_at DESC LIMIT 1`,
      [portfolioId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioAuthorizationRequestSchema.parse(i),
          row.payload,
          "portfolio_authorization_requests",
        )
      : null;
  }

  async saveCas(
    request: PortfolioAuthorizationRequest,
    expectedRevision: number,
  ): Promise<PortfolioAuthorizationRequest> {
    const parsed = PortfolioAuthorizationRequestSchema.parse({
      ...request,
      recordRevision: expectedRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE portfolio_authorization_requests
       SET status = $2, payload = $3::jsonb, record_revision = $4,
           updated_at = $5::timestamptz
       WHERE authorization_id = $1 AND record_revision = $6`,
      [
        parsed.authorizationId,
        parsed.status,
        JSON.stringify(parsed),
        parsed.recordRevision,
        parsed.decidedAt ?? parsed.createdAt,
        expectedRevision,
      ],
    );
    if (result.rowCount !== 1) {
      throw new PortfolioError(
        "PORTFOLIO_CAS_CONFLICT",
        `Authorization request CAS conflict for ${parsed.authorizationId}`,
      );
    }
    return parsed;
  }
}

export class PostgresPortfolioAuthorizationRecordRepository
  implements PortfolioAuthorizationRecordRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: PortfolioAuthorizationRecord,
  ): Promise<PortfolioAuthorizationRecord> {
    const parsed = PortfolioAuthorizationRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO portfolio_authorization_records (
         authorization_record_id, authorization_id, portfolio_id,
         payload, created_at
       ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
       ON CONFLICT (authorization_record_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.authorizationRecordId,
        parsed.authorizationId,
        parsed.portfolioId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async getByAuthorizationId(
    authorizationId: string,
  ): Promise<PortfolioAuthorizationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_authorization_records WHERE authorization_id = $1`,
      [authorizationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioAuthorizationRecordSchema.parse(i),
          row.payload,
          "portfolio_authorization_records",
        )
      : null;
  }

  async getLatest(
    portfolioId: string,
  ): Promise<PortfolioAuthorizationRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_authorization_records
       WHERE portfolio_id = $1
       ORDER BY created_at DESC LIMIT 1`,
      [portfolioId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioAuthorizationRecordSchema.parse(i),
          row.payload,
          "portfolio_authorization_records",
        )
      : null;
  }
}

export class PostgresPortfolioCompletionRepository
  implements PortfolioCompletionRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    record: PortfolioCompletionRecord,
  ): Promise<PortfolioCompletionRecord> {
    const parsed = PortfolioCompletionRecordSchema.parse(record);
    await this.db.query(
      `INSERT INTO portfolio_completion_records (
         portfolio_completion_record_id, portfolio_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (portfolio_id) DO NOTHING`,
      [
        parsed.portfolioCompletionRecordId,
        parsed.portfolioId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return (await this.getByPortfolioId(parsed.portfolioId)) ?? parsed;
  }

  async getByPortfolioId(
    portfolioId: string,
  ): Promise<PortfolioCompletionRecord | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_completion_records WHERE portfolio_id = $1`,
      [portfolioId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => PortfolioCompletionRecordSchema.parse(i),
          row.payload,
          "portfolio_completion_records",
        )
      : null;
  }
}

export class PostgresPortfolioRebalanceRepository
  implements PortfolioRebalanceRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    proposal: PortfolioRebalanceProposal,
  ): Promise<PortfolioRebalanceProposal> {
    const parsed = PortfolioRebalanceProposalSchema.parse(proposal);
    await this.db.query(
      `INSERT INTO portfolio_rebalance_records (
         rebalance_id, portfolio_id, payload, created_at
       ) VALUES ($1,$2,$3::jsonb,$4::timestamptz)
       ON CONFLICT (rebalance_id) DO UPDATE
       SET payload = EXCLUDED.payload`,
      [
        parsed.rebalanceId,
        parsed.portfolioId,
        JSON.stringify(parsed),
        parsed.createdAt,
      ],
    );
    return parsed;
  }

  async listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioRebalanceProposal[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM portfolio_rebalance_records
       WHERE portfolio_id = $1 ORDER BY created_at ASC`,
      [portfolioId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => PortfolioRebalanceProposalSchema.parse(i),
        row.payload,
        "portfolio_rebalance_records",
      ),
    );
  }
}
