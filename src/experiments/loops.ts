import type { ExperimentRepository } from "./repositories.js";
import type { ExperimentWorkMaterializer } from "./work-materializer.js";
import { DISCOVERABLE_EXPERIMENT_STATES } from "./experiment-state.js";

/**
 * Thin producer only: discovers experiments and materializes durable
 * Phase 13 SchedulerWorkItems. Does NOT execute design/validate/authorize.
 */
export class ExperimentProgressionLoop {
  constructor(
    private readonly deps: {
      experiments: ExperimentRepository;
      materializer: ExperimentWorkMaterializer;
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
    const batch = await this.deps.experiments.listByStates(
      DISCOVERABLE_EXPERIMENT_STATES,
    );
    const limited = batch.slice(0, this.deps.listLimit ?? 10);
    await this.deps.materializer.discoverBatch(
      limited.map((e) => e.experimentId),
    );
  }
}
