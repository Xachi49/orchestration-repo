import {
  parseObjective,
  type Objective,
} from "../../domain/objective/objective.js";
import type { ObjectiveRepository } from "../../admission/objective-repository.js";

function key(objectiveId: string, objectiveVersion: number): string {
  return `${objectiveId}::${objectiveVersion}`;
}

export class InMemoryObjectiveRepository implements ObjectiveRepository {
  private readonly byIdentity = new Map<string, Objective>();
  private readonly byRun = new Map<string, string>();

  async save(objective: Objective): Promise<Objective> {
    const parsed = parseObjective(objective);
    this.byIdentity.set(
      key(parsed.objectiveId, parsed.objectiveVersion),
      Object.freeze(parsed),
    );
    return parsed;
  }

  async getById(
    objectiveId: string,
    objectiveVersion: number,
  ): Promise<Objective | null> {
    return this.byIdentity.get(key(objectiveId, objectiveVersion)) ?? null;
  }

  async getByRunBinding(runId: string): Promise<Objective | null> {
    const identity = this.byRun.get(runId);
    if (!identity) {
      return null;
    }
    return this.byIdentity.get(identity) ?? null;
  }

  async bindRun(
    runId: string,
    objectiveId: string,
    objectiveVersion: number,
  ): Promise<void> {
    this.byRun.set(runId, key(objectiveId, objectiveVersion));
  }
}
