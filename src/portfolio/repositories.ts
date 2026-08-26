import type { Portfolio } from "./portfolio.js";
import type { PortfolioState } from "./portfolio-state.js";
import type { PortfolioPlan } from "./plan.js";
import type {
  PortfolioBudgetLedger,
  PortfolioBudgetReservation,
} from "./budget.js";
import type {
  PortfolioAuthorizationRecord,
  PortfolioAuthorizationRequest,
  PortfolioCompletionRecord,
  PortfolioProgramLineage,
  PortfolioRebalanceProposal,
} from "./lineage.js";

export interface PortfolioRepository {
  create(portfolio: Portfolio): Promise<Portfolio>;
  getById(portfolioId: string): Promise<Portfolio | null>;
  getByIdempotencyKey(key: string): Promise<Portfolio | null>;
  save(portfolio: Portfolio, expectedRevision: number): Promise<Portfolio>;
  transition(
    portfolioId: string,
    expected: PortfolioState,
    expectedRevision: number,
    next: PortfolioState,
    updatedAt: string,
    extras?: Partial<
      Pick<
        Portfolio,
        | "portfolioPlanVersion"
        | "portfolioPlanHash"
        | "failureReasonCode"
        | "failureClass"
        | "paused"
      >
    >,
  ): Promise<Portfolio>;
  listByProject(projectId: string): Promise<readonly Portfolio[]>;
  listByStates(
    states: readonly PortfolioState[],
    limit: number,
  ): Promise<readonly Portfolio[]>;
}

export interface PortfolioPlanRepository {
  save(plan: PortfolioPlan): Promise<PortfolioPlan>;
  get(
    portfolioId: string,
    portfolioPlanVersion: number,
  ): Promise<PortfolioPlan | null>;
  getLatest(portfolioId: string): Promise<PortfolioPlan | null>;
}

export interface PortfolioBudgetLedgerRepository {
  create(ledger: PortfolioBudgetLedger): Promise<PortfolioBudgetLedger>;
  get(portfolioId: string): Promise<PortfolioBudgetLedger | null>;
  saveCas(
    ledger: PortfolioBudgetLedger,
    expectedRevision: number,
  ): Promise<PortfolioBudgetLedger>;
}

export interface PortfolioBudgetReservationRepository {
  save(
    reservation: PortfolioBudgetReservation,
  ): Promise<PortfolioBudgetReservation>;
  getById(
    reservationId: string,
  ): Promise<PortfolioBudgetReservation | null>;
  listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioBudgetReservation[]>;
}

export interface PortfolioProgramLineageRepository {
  save(record: PortfolioProgramLineage): Promise<PortfolioProgramLineage>;
  getById(lineageId: string): Promise<PortfolioProgramLineage | null>;
  listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioProgramLineage[]>;
  listByPlan(
    portfolioId: string,
    portfolioPlanVersion: number,
  ): Promise<readonly PortfolioProgramLineage[]>;
}

export interface PortfolioAuthorizationRequestRepository {
  save(
    request: PortfolioAuthorizationRequest,
  ): Promise<PortfolioAuthorizationRequest>;
  getById(
    authorizationId: string,
  ): Promise<PortfolioAuthorizationRequest | null>;
  getPending(
    portfolioId: string,
  ): Promise<PortfolioAuthorizationRequest | null>;
  saveCas(
    request: PortfolioAuthorizationRequest,
    expectedRevision: number,
  ): Promise<PortfolioAuthorizationRequest>;
}

export interface PortfolioAuthorizationRecordRepository {
  save(
    record: PortfolioAuthorizationRecord,
  ): Promise<PortfolioAuthorizationRecord>;
  getByAuthorizationId(
    authorizationId: string,
  ): Promise<PortfolioAuthorizationRecord | null>;
  getLatest(
    portfolioId: string,
  ): Promise<PortfolioAuthorizationRecord | null>;
}

export interface PortfolioCompletionRepository {
  save(
    record: PortfolioCompletionRecord,
  ): Promise<PortfolioCompletionRecord>;
  getByPortfolioId(
    portfolioId: string,
  ): Promise<PortfolioCompletionRecord | null>;
}

export interface PortfolioRebalanceRepository {
  save(
    proposal: PortfolioRebalanceProposal,
  ): Promise<PortfolioRebalanceProposal>;
  listByPortfolio(
    portfolioId: string,
  ): Promise<readonly PortfolioRebalanceProposal[]>;
}
