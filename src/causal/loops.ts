import type { CausalQuestionRepository } from "./repositories.js";
import type { CausalWorkMaterializer } from "./work-materializer.js";
import { DISCOVERABLE_CAUSAL_QUESTION_STATES } from "./causal-state.js";

/**
 * Thin producer only: discovers causal questions and materializes durable
 * Phase 13 SchedulerWorkItems. Does NOT estimate/promote/decide.
 */
export class CausalProgressionLoop {
  constructor(
    private readonly deps: {
      questions: CausalQuestionRepository;
      materializer: CausalWorkMaterializer;
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
    const batch = await this.deps.questions.listByStates(
      DISCOVERABLE_CAUSAL_QUESTION_STATES,
    );
    const limited = batch.slice(0, this.deps.listLimit ?? 10);
    await this.deps.materializer.discoverBatch(
      limited.map((q) => q.causalQuestionId),
    );
  }
}
