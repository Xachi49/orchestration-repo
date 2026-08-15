import {
  MAX_AUTOMATIC_ROLLBACKS,
  type RollbackPlan,
  parseRollbackPlan,
} from "../domain/execution/index.js";
import type { ExecutionPlan, ExecutionStep } from "../domain/plan/execution-plan.js";
import { ExecutionError } from "./errors.js";

/**
 * Resolves and gates automatic rollbacks. Max one autonomous rollback.
 * Rollback must be pre-authorized in the approved plan and executed through
 * the full bounded pipeline (compile → validate → reserve → markRunning →
 * SafeActuator) — never via invented commands or generic shell.
 */
export class RollbackService {
  private automaticRollbacks = 0;

  extractAuthorizedRollback(step: ExecutionStep): RollbackPlan | null {
    if (step.rollback.strategy !== "COMPENSATING_ACTION") {
      return null;
    }
    const compensating = step.rollback.compensatingStepIds;
    if (!compensating || compensating.length === 0) {
      return null;
    }
    return parseRollbackPlan({
      rollbackPlanId: `rollback_${step.stepId}`,
      sourceStepId: step.stepId,
      compensatingStepIds: compensating,
      strategy: "COMPENSATING_ACTION",
      ...(step.rollback.instructions !== undefined
        ? { instructions: step.rollback.instructions }
        : {}),
      authorizedInPlan: true as const,
    });
  }

  assertCanRollback(plan: ExecutionPlan, failedStepId: string): RollbackPlan {
    if (this.automaticRollbacks >= MAX_AUTOMATIC_ROLLBACKS) {
      throw new ExecutionError(
        "ROLLBACK_LIMIT_EXCEEDED",
        `Automatic rollback limit of ${MAX_AUTOMATIC_ROLLBACKS} exceeded`,
      );
    }
    const step = plan.steps.find((s) => s.stepId === failedStepId);
    if (!step) {
      throw new ExecutionError(
        "ROLLBACK_NOT_AUTHORIZED",
        `Unknown failed step ${failedStepId}`,
      );
    }
    const rollback = this.extractAuthorizedRollback(step);
    if (!rollback) {
      throw new ExecutionError(
        "ROLLBACK_NOT_AUTHORIZED",
        `No authorized compensating rollback for step ${failedStepId}`,
      );
    }
    for (const compensatingId of rollback.compensatingStepIds) {
      if (!plan.steps.some((s) => s.stepId === compensatingId)) {
        throw new ExecutionError(
          "ROLLBACK_NOT_AUTHORIZED",
          `Compensating step ${compensatingId} is not in the approved plan`,
        );
      }
      if (compensatingId === failedStepId) {
        throw new ExecutionError(
          "ROLLBACK_NOT_AUTHORIZED",
          "Compensating step cannot be the failed step itself",
        );
      }
    }
    return rollback;
  }

  /**
   * Steps that appear only as compensating targets (not in any workstream)
   * are excluded from the happy-path execution order and run only via rollback.
   */
  compensatingOnlyStepIds(plan: ExecutionPlan): Set<string> {
    const inWorkstreams = new Set(
      plan.workstreams.flatMap((ws) => ws.stepIds),
    );
    const compensating = new Set<string>();
    for (const step of plan.steps) {
      for (const id of step.rollback.compensatingStepIds ?? []) {
        if (!inWorkstreams.has(id)) {
          compensating.add(id);
        }
      }
    }
    return compensating;
  }

  recordAutomaticRollback(): void {
    this.automaticRollbacks += 1;
  }

  get automaticRollbackCount(): number {
    return this.automaticRollbacks;
  }
}
