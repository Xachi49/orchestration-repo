import type { ProgramRepository } from "./repositories.js";
import type { ProgramWorkMaterializer } from "./work-materializer.js";
import { DISCOVERABLE_PROGRAM_STATES } from "./program-state.js";

/**
 * Thin producer only: discovers Programs and materializes durable Phase 13
 * SchedulerWorkItems. Progression authority is claim/fence/dispatch.
 */
export class ProgramProgressionLoop {
  constructor(
    private readonly deps: {
      programs: ProgramRepository;
      materializer: ProgramWorkMaterializer;
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
    const batch = await this.deps.programs.listByStates(
      DISCOVERABLE_PROGRAM_STATES,
      this.deps.listLimit ?? 10,
    );
    await this.deps.materializer.discoverBatch(
      batch.map((p) => p.programId),
    );
  }
}
