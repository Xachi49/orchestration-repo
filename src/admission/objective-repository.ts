import type { Objective } from "../domain/objective/objective.js";

/**
 * Durable objective persistence for later planning.
 * Phase 2 admission writes; Phase 4 planning reads.
 */
export interface ObjectiveRepository {
  save(objective: Objective): Promise<Objective>;
  getById(
    objectiveId: string,
    objectiveVersion: number,
  ): Promise<Objective | null>;
  getByRunBinding(runId: string): Promise<Objective | null>;
  bindRun(
    runId: string,
    objectiveId: string,
    objectiveVersion: number,
  ): Promise<void>;
}
