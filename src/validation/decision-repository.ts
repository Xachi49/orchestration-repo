import {
  parseValidationDecision,
  type ValidationDecision,
} from "../domain/validation/index.js";
import type { PlanVersion } from "../domain/plan/execution-plan.js";

export interface ValidationDecisionRepository {
  save(decision: ValidationDecision): Promise<ValidationDecision>;
  getById(validationDecisionId: string): Promise<ValidationDecision | null>;
  getLatestByRunId(runId: string): Promise<ValidationDecision | null>;
  getByPlan(
    runId: string,
    planId: string,
    planVersion: PlanVersion,
  ): Promise<ValidationDecision | null>;
  listByRunId(runId: string): Promise<readonly ValidationDecision[]>;
  exists(validationDecisionId: string): Promise<boolean>;
}

/**
 * In-memory validation decision store.
 *
 * Decisions are append-only history: a REVISE decision on plan v1 and the final
 * decision on v2 both remain addressable, so the adjudication trail for a run
 * can be replayed. Not a production database.
 */
export class InMemoryValidationDecisionRepository
  implements ValidationDecisionRepository
{
  private readonly byId = new Map<string, ValidationDecision>();
  private readonly orderByRun = new Map<string, string[]>();

  async save(decision: ValidationDecision): Promise<ValidationDecision> {
    const parsed = parseValidationDecision(decision);
    if (this.byId.has(parsed.validationDecisionId)) {
      throw new Error(
        `Validation decision already exists: ${parsed.validationDecisionId}`,
      );
    }
    this.byId.set(parsed.validationDecisionId, parsed);
    const order = this.orderByRun.get(parsed.runId) ?? [];
    order.push(parsed.validationDecisionId);
    this.orderByRun.set(parsed.runId, order);
    return parsed;
  }

  async getById(
    validationDecisionId: string,
  ): Promise<ValidationDecision | null> {
    return this.byId.get(validationDecisionId) ?? null;
  }

  async getLatestByRunId(runId: string): Promise<ValidationDecision | null> {
    const order = this.orderByRun.get(runId);
    const latestId = order?.[order.length - 1];
    if (!latestId) {
      return null;
    }
    return this.byId.get(latestId) ?? null;
  }

  async getByPlan(
    runId: string,
    planId: string,
    planVersion: PlanVersion,
  ): Promise<ValidationDecision | null> {
    const decisions = await this.listByRunId(runId);
    const matches = decisions.filter(
      (decision) =>
        decision.planId === planId && decision.planVersion === planVersion,
    );
    return matches[matches.length - 1] ?? null;
  }

  async listByRunId(runId: string): Promise<readonly ValidationDecision[]> {
    const order = this.orderByRun.get(runId) ?? [];
    return order
      .map((id) => this.byId.get(id))
      .filter((decision): decision is ValidationDecision => Boolean(decision));
  }

  async exists(validationDecisionId: string): Promise<boolean> {
    return this.byId.has(validationDecisionId);
  }
}
