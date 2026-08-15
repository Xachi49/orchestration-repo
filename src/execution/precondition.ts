import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { CompiledExecutionStep } from "./dry-run.js";
import type { StepExecutionResult } from "../domain/execution/index.js";
import { ExecutionError } from "./errors.js";
import type { ExecutionResourceLedger } from "./resource-ledger.js";
import { ExecutionTargetValidator } from "./target-validator.js";

export interface ExecutionPreconditionServiceDeps {
  resourceLedger: ExecutionResourceLedger;
}

/**
 * Per-step gate before actuation.
 */
export class ExecutionPreconditionService {
  private readonly targets = new ExecutionTargetValidator();

  constructor(private readonly deps: ExecutionPreconditionServiceDeps) {}

  assertBeforeStep(input: {
    plan: ExecutionPlan;
    step: CompiledExecutionStep;
    completedByStepId: ReadonlyMap<string, StepExecutionResult>;
    workspaceRoot: string;
    capabilityStillEnabled: boolean;
    repositoryCommitSha: string;
    expectedCommitSha: string;
  }): void {
    for (const depId of input.step.dependsOn) {
      const dep = input.completedByStepId.get(depId);
      if (!dep || dep.status !== "SUCCEEDED") {
        throw new ExecutionError(
          "EXECUTION_PRECONDITION_FAILED",
          `Dependency ${depId} has not succeeded`,
          { stepId: input.step.stepId, dependencyId: depId },
        );
      }
    }

    if (!input.capabilityStillEnabled) {
      throw new ExecutionError(
        "EXECUTION_CAPABILITY_CHANGED",
        `Capability ${input.step.capabilityId} is no longer enabled`,
        { stepId: input.step.stepId },
      );
    }

    if (input.repositoryCommitSha !== input.expectedCommitSha) {
      throw new ExecutionError(
        "EXECUTION_REPOSITORY_STALE",
        "Repository SHA changed before step execution",
        { stepId: input.step.stepId },
      );
    }

    if (input.step.actionType === "CREATE_LOCAL_PATCH") {
      this.targets.validateTargets(
        input.workspaceRoot,
        input.step.validatedTargets,
      );
    }

    this.deps.resourceLedger.assertWithinBudget();
  }
}
