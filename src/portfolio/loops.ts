import type { PortfolioRepository } from "./repositories.js";
import type { PortfolioWorkMaterializer } from "./work-materializer.js";
import { DISCOVERABLE_PORTFOLIO_STATES } from "./portfolio-state.js";

/**
 * Thin producer only: discovers Portfolios and materializes durable Phase 13
 * SchedulerWorkItems. Progression authority is claim/fence/dispatch.
 */
export class PortfolioProgressionLoop {
  constructor(
    private readonly deps: {
      portfolios: PortfolioRepository;
      materializer: PortfolioWorkMaterializer;
      listLimit?: number;
      isAccepting?: () => boolean;
      databaseReachable?: () => Promise<boolean>;
    },
  ) {}

  async tick(): Promise<void> {
    if (this.deps.isAccepting && !this.deps.isAccepting()) {
      return;
    }
    if (this.deps.databaseReachable && !(await this.deps.databaseReachable())) {
      return;
    }
    const batch = await this.deps.portfolios.listByStates(
      DISCOVERABLE_PORTFOLIO_STATES,
      this.deps.listLimit ?? 10,
    );
    await this.deps.materializer.discoverBatch(
      batch.map((p) => p.portfolioId),
    );
  }
}
