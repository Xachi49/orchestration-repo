/**
 * Plan-compilation gate: recovery steps must be actuatable before hash acceptance.
 * READY != ACTUATABLE
 */

import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import { PlanningError } from "./errors.js";
import {
  validateRecoveryStepsTargetGrammar,
} from "../revenue-recovery/target-grammar.js";

export function assertRecoveryTargetsActuatable(
  steps: readonly {
    stepId: string;
    actionType: string;
    targetIds: readonly string[];
  }[],
  context: { runId?: string; phase?: string } = {},
): void {
  const result = validateRecoveryStepsTargetGrammar(steps);
  if (!result.ok) {
    throw new PlanningError(
      "RECOVERY_TARGET_INVALID",
      result.message,
      {
        code: result.code,
        ...result.details,
        ...(context.runId !== undefined ? { runId: context.runId } : {}),
        ...(context.phase !== undefined ? { phase: context.phase } : {}),
      },
    );
  }
}

export function assertExecutionPlanRecoveryTargets(
  plan: ExecutionPlan,
  context: { runId?: string } = {},
): void {
  assertRecoveryTargetsActuatable(plan.steps, {
    ...context,
    phase: "PLAN_COMPILATION",
  });
}
