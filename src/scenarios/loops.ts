import type { DecisionProblemRepository } from "./repositories.js";
import type { ScenarioWorkMaterializer } from "./work-materializer.js";
import { DISCOVERABLE_DECISION_PROBLEM_STATES } from "./decision-state.js";

/**
 * Thin producer only: discovers decision problems and materializes durable
 * Phase 13 SchedulerWorkItems. Does NOT execute simulate/validate/select.
 */
export class ScenarioProgressionLoop {
  constructor(
    private readonly deps: {
      decisionProblems: DecisionProblemRepository;
      materializer: ScenarioWorkMaterializer;
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
    const batch = await this.deps.decisionProblems.listByStates(
      DISCOVERABLE_DECISION_PROBLEM_STATES,
      this.deps.listLimit ?? 10,
    );
    await this.deps.materializer.discoverBatch(
      batch.map((p) => p.decisionProblemId),
    );
  }
}
