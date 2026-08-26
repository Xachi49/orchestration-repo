import type { Portfolio } from "./portfolio.js";
import { parsePortfolio } from "./portfolio.js";
import type { PortfolioPlan } from "./plan.js";
import { PortfolioPlanSchema } from "./plan.js";
import type {
  PortfolioBudgetLedger,
  PortfolioBudgetReservation,
} from "./budget.js";
import {
  PortfolioBudgetLedgerSchema,
  PortfolioBudgetReservationSchema,
} from "./budget.js";
import type {
  PortfolioAuthorizationRecord,
  PortfolioAuthorizationRequest,
  PortfolioCompletionRecord,
  PortfolioProgramLineage,
  PortfolioRebalanceProposal,
} from "./lineage.js";
import {
  PortfolioAuthorizationRecordSchema,
  PortfolioAuthorizationRequestSchema,
  PortfolioCompletionRecordSchema,
  PortfolioProgramLineageSchema,
  PortfolioRebalanceProposalSchema,
} from "./lineage.js";
import { PortfolioError } from "./errors.js";
import {
  canTransitionPortfolio,
  type PortfolioState,
} from "./portfolio-state.js";
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
} from "./repositories.js";

export class InMemoryPortfolioRepository implements PortfolioRepository {
  private readonly byId = new Map<string, Portfolio>();
  private readonly byIdem = new Map<string, string>();

  async create(portfolio: Portfolio): Promise<Portfolio> {
    const parsed = parsePortfolio(portfolio);
    if (this.byId.has(parsed.portfolioId)) {
      throw new PortfolioError(
        "PORTFOLIO_CAS_CONFLICT",
        `Portfolio ${parsed.portfolioId} already exists`,
      );
    }
    this.byId.set(parsed.portfolioId, parsed);
    this.byIdem.set(parsed.idempotencyKey, parsed.portfolioId);
    return parsed;
  }

  async getById(portfolioId: string): Promise<Portfolio | null> {
    return this.byId.get(portfolioId) ?? null;
  }

  async getByIdempotencyKey(key: string): Promise<Portfolio | null> {
    const id = this.byIdem.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async save(portfolio: Portfolio, expectedRevision: number): Promise<Portfolio> {
    const existing = this.byId.get(portfolio.portfolioId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new PortfolioError(
        "PORTFOLIO_CAS_CONFLICT",
        `CAS conflict for portfolio ${portfolio.portfolioId}`,
      );
    }
    const next = parsePortfolio({
      ...portfolio,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.portfolioId, next);
    return next;
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
    const existing = this.byId.get(portfolioId);
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
    const updated = parsePortfolio({
      ...existing,
      ...extras,
      status: next,
      updatedAt,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(portfolioId, updated);
    return updated;
  }

  async listByProject(projectId: string): Promise<readonly Portfolio[]> {
    return [...this.byId.values()].filter(
      (p) => p.primaryProjectId === projectId,
    );
  }

  async listByStates(
    states: readonly PortfolioState[],
    limit: number,
  ): Promise<readonly Portfolio[]> {
    const set = new Set(states);
    return [...this.byId.values()]
      .filter((p) => set.has(p.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit);
  }
}

export class InMemoryPortfolioPlanRepository implements PortfolioPlanRepository {
  private readonly plans = new Map<string, PortfolioPlan>();

  private key(portfolioId: string, version: number): string {
    return `${portfolioId}:${version}`;
  }

  async save(plan: PortfolioPlan): Promise<PortfolioPlan> {
    const parsed = PortfolioPlanSchema.parse(plan);
    const k = this.key(parsed.portfolioId, parsed.portfolioPlanVersion);
    if (this.plans.has(k)) {
      throw new PortfolioError(
        "PORTFOLIO_CAS_CONFLICT",
        `Plan ${k} already immutable`,
      );
    }
    this.plans.set(k, parsed);
    return parsed;
  }

  async get(
    portfolioId: string,
    portfolioPlanVersion: number,
  ): Promise<PortfolioPlan | null> {
    return (
      this.plans.get(this.key(portfolioId, portfolioPlanVersion)) ?? null
    );
  }

  async getLatest(portfolioId: string): Promise<PortfolioPlan | null> {
    const versions = [...this.plans.values()]
      .filter((p) => p.portfolioId === portfolioId)
      .sort((a, b) => b.portfolioPlanVersion - a.portfolioPlanVersion);
    return versions[0] ?? null;
  }
}

export class InMemoryPortfolioBudgetLedgerRepository
  implements PortfolioBudgetLedgerRepository
{
  private readonly ledgers = new Map<string, PortfolioBudgetLedger>();

  async create(ledger: PortfolioBudgetLedger): Promise<PortfolioBudgetLedger> {
    const parsed = PortfolioBudgetLedgerSchema.parse(ledger);
    this.ledgers.set(parsed.portfolioId, parsed);
    return parsed;
  }

  async get(portfolioId: string): Promise<PortfolioBudgetLedger | null> {
    return this.ledgers.get(portfolioId) ?? null;
  }

  async saveCas(
    ledger: PortfolioBudgetLedger,
    expectedRevision: number,
  ): Promise<PortfolioBudgetLedger> {
    const existing = this.ledgers.get(ledger.portfolioId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new PortfolioError(
        "PORTFOLIO_BUDGET_OVER_ALLOCATION",
        `Budget CAS conflict for ${ledger.portfolioId}`,
      );
    }
    const next = PortfolioBudgetLedgerSchema.parse({
      ...ledger,
      recordRevision: expectedRevision + 1,
    });
    this.ledgers.set(next.portfolioId, next);
    return next;
  }
}

export class InMemoryPortfolioBudgetReservationRepository
  implements PortfolioBudgetReservationRepository
{
  private readonly byId = new Map<string, PortfolioBudgetReservation>();

  async save(
    reservation: PortfolioBudgetReservation,
  ): Promise<PortfolioBudgetReservation> {
    const parsed = PortfolioBudgetReservationSchema.parse(reservation);
    this.byId.set(parsed.reservationId, parsed);
    return parsed;
  }

  async getById(
    reservationId: string,
  ): Promise<PortfolioBudgetReservation | null> {
    return this.byId.get(reservationId) ?? null;
  }

  async listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioBudgetReservation[]> {
    return [...this.byId.values()].filter(
      (r) => r.portfolioId === portfolioId,
    );
  }
}

export class InMemoryPortfolioProgramLineageRepository
  implements PortfolioProgramLineageRepository
{
  private readonly byId = new Map<string, PortfolioProgramLineage>();

  async save(record: PortfolioProgramLineage): Promise<PortfolioProgramLineage> {
    const parsed = PortfolioProgramLineageSchema.parse(record);
    this.byId.set(parsed.lineageId, parsed);
    return parsed;
  }

  async getById(lineageId: string): Promise<PortfolioProgramLineage | null> {
    return this.byId.get(lineageId) ?? null;
  }

  async listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioProgramLineage[]> {
    return [...this.byId.values()].filter(
      (r) => r.portfolioId === portfolioId,
    );
  }

  async listByPlan(
    portfolioId: string,
    portfolioPlanVersion: number,
  ): Promise<readonly PortfolioProgramLineage[]> {
    return [...this.byId.values()].filter(
      (r) =>
        r.portfolioId === portfolioId &&
        r.portfolioPlanVersion === portfolioPlanVersion,
    );
  }
}

export class InMemoryPortfolioAuthorizationRequestRepository
  implements PortfolioAuthorizationRequestRepository
{
  private readonly byId = new Map<string, PortfolioAuthorizationRequest>();

  async save(
    request: PortfolioAuthorizationRequest,
  ): Promise<PortfolioAuthorizationRequest> {
    const parsed = PortfolioAuthorizationRequestSchema.parse(request);
    this.byId.set(parsed.authorizationId, parsed);
    return parsed;
  }

  async getById(
    authorizationId: string,
  ): Promise<PortfolioAuthorizationRequest | null> {
    return this.byId.get(authorizationId) ?? null;
  }

  async getPending(
    portfolioId: string,
  ): Promise<PortfolioAuthorizationRequest | null> {
    return (
      [...this.byId.values()].find(
        (r) => r.portfolioId === portfolioId && r.status === "PENDING",
      ) ?? null
    );
  }

  async saveCas(
    request: PortfolioAuthorizationRequest,
    expectedRevision: number,
  ): Promise<PortfolioAuthorizationRequest> {
    const existing = this.byId.get(request.authorizationId);
    if (!existing || existing.recordRevision !== expectedRevision) {
      throw new PortfolioError(
        "PORTFOLIO_CAS_CONFLICT",
        `Authorization request CAS conflict for ${request.authorizationId}`,
      );
    }
    const next = PortfolioAuthorizationRequestSchema.parse({
      ...request,
      recordRevision: expectedRevision + 1,
    });
    this.byId.set(next.authorizationId, next);
    return next;
  }
}

export class InMemoryPortfolioAuthorizationRecordRepository
  implements PortfolioAuthorizationRecordRepository
{
  private readonly byAuthId = new Map<string, PortfolioAuthorizationRecord>();
  private readonly byPortfolio = new Map<string, PortfolioAuthorizationRecord>();

  async save(
    record: PortfolioAuthorizationRecord,
  ): Promise<PortfolioAuthorizationRecord> {
    const parsed = PortfolioAuthorizationRecordSchema.parse(record);
    this.byAuthId.set(parsed.authorizationId, parsed);
    this.byPortfolio.set(parsed.portfolioId, parsed);
    return parsed;
  }

  async getByAuthorizationId(
    authorizationId: string,
  ): Promise<PortfolioAuthorizationRecord | null> {
    return this.byAuthId.get(authorizationId) ?? null;
  }

  async getLatest(
    portfolioId: string,
  ): Promise<PortfolioAuthorizationRecord | null> {
    return this.byPortfolio.get(portfolioId) ?? null;
  }
}

export class InMemoryPortfolioCompletionRepository
  implements PortfolioCompletionRepository
{
  private readonly byPortfolio = new Map<string, PortfolioCompletionRecord>();

  async save(
    record: PortfolioCompletionRecord,
  ): Promise<PortfolioCompletionRecord> {
    const parsed = PortfolioCompletionRecordSchema.parse(record);
    if (this.byPortfolio.has(parsed.portfolioId)) {
      return this.byPortfolio.get(parsed.portfolioId)!;
    }
    this.byPortfolio.set(parsed.portfolioId, parsed);
    return parsed;
  }

  async getByPortfolioId(
    portfolioId: string,
  ): Promise<PortfolioCompletionRecord | null> {
    return this.byPortfolio.get(portfolioId) ?? null;
  }
}

export class InMemoryPortfolioRebalanceRepository
  implements PortfolioRebalanceRepository
{
  private readonly byId = new Map<string, PortfolioRebalanceProposal>();

  async save(
    proposal: PortfolioRebalanceProposal,
  ): Promise<PortfolioRebalanceProposal> {
    const parsed = PortfolioRebalanceProposalSchema.parse(proposal);
    this.byId.set(parsed.rebalanceId, parsed);
    return parsed;
  }

  async listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioRebalanceProposal[]> {
    return [...this.byId.values()]
      .filter((p) => p.portfolioId === portfolioId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}
