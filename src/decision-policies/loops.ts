import type { DecisionPolicyCandidateRepository } from "./repositories.js";
import type { DecisionPolicyWorkMaterializer } from "./work-materializer.js";
import { DISCOVERABLE_DECISION_POLICY_STATES } from "./policy-state.js";

/**
 * Thin producer only: discovers decision policies and materializes durable
 * Phase 13 SchedulerWorkItems. Does NOT approve/activate/recommend.
 */
export class DecisionPolicyProgressionLoop {
  constructor(
    private readonly deps: {
      policies: DecisionPolicyCandidateRepository;
      materializer: DecisionPolicyWorkMaterializer;
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
    const batch = await this.deps.policies.listByStates(
      DISCOVERABLE_DECISION_POLICY_STATES,
    );
    const limited = batch.slice(0, this.deps.listLimit ?? 10);
    await this.deps.materializer.discoverBatch(
      limited.map((p) => p.decisionPolicyId),
    );
  }
}
