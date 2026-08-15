import { z } from "zod";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository, StoredPlanRecord } from "../planning/plan-repository.js";
import { ValidationError } from "./errors.js";

export const ValidationReadinessCodeSchema = z.enum([
  "READY",
  "RUN_NOT_VALIDATING",
  "PLAN_NOT_FOUND",
  "PLAN_NOT_VALIDATABLE",
  "PLAN_RUN_MISMATCH",
  "OBJECTIVE_MISMATCH",
  "CONTROL_CONTEXT_UNAVAILABLE",
]);
export type ValidationReadinessCode = z.infer<
  typeof ValidationReadinessCodeSchema
>;

export type ValidationReadinessResult =
  | { ready: true; code: "READY"; plan: StoredPlanRecord }
  | {
      ready: false;
      code: Exclude<ValidationReadinessCode, "READY">;
      message: string;
    };

export interface ValidationReadinessServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
}

/**
 * Deterministic entry gate for validation. Never invokes a model.
 *
 * Scope is deliberately narrow: it establishes that there is something
 * validatable and that configuration authority is resolvable. Repository
 * drift, policy rotation, and hash mismatches are *not* readiness failures —
 * they are findings, so they produce an auditable BLOCK decision instead of an
 * exception that leaves no record.
 *
 * Eligible run state: VALIDATING (Phase 4 leaves the run there, and Phase 5
 * keeps it there).
 */
export class ValidationReadinessService {
  constructor(private readonly deps: ValidationReadinessServiceDeps) {}

  async assess(runId: string): Promise<ValidationReadinessResult> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      return {
        ready: false,
        code: "RUN_NOT_VALIDATING",
        message: `Run not found: ${runId}`,
      };
    }
    if (run.state !== "VALIDATING") {
      return {
        ready: false,
        code: "RUN_NOT_VALIDATING",
        message: `Run ${runId} is in ${run.state}, expected VALIDATING`,
      };
    }

    const plan = await this.deps.plans.getByRunId(runId);
    if (!plan) {
      return {
        ready: false,
        code: "PLAN_NOT_FOUND",
        message: `No plan for run ${runId}`,
      };
    }
    if (plan.runId !== runId) {
      return {
        ready: false,
        code: "PLAN_RUN_MISMATCH",
        message: "Latest plan is not bound to this run",
      };
    }
    if (
      plan.status !== "READY_FOR_VALIDATION" &&
      plan.status !== "UNDER_VALIDATION"
    ) {
      return {
        ready: false,
        code: "PLAN_NOT_VALIDATABLE",
        message: `Plan ${plan.planId} status is ${plan.status}`,
      };
    }

    const objective = await this.deps.objectives.getByRunBinding(runId);
    if (!objective) {
      return {
        ready: false,
        code: "OBJECTIVE_MISMATCH",
        message: `No objective bound to run ${runId}`,
      };
    }
    if (
      objective.objectiveId !== run.objectiveId ||
      objective.objectiveVersion !== run.objectiveVersion ||
      objective.projectId !== run.projectId
    ) {
      return {
        ready: false,
        code: "OBJECTIVE_MISMATCH",
        message: "Bound objective does not match run identity",
      };
    }

    try {
      await this.deps.controlPlane.resolve(
        run.projectId,
        run.requestedEnvironment,
      );
    } catch (error) {
      return {
        ready: false,
        code: "CONTROL_CONTEXT_UNAVAILABLE",
        message:
          error instanceof Error
            ? error.message
            : "Control plane resolution failed",
      };
    }

    return { ready: true, code: "READY", plan };
  }

  async assertReady(runId: string): Promise<StoredPlanRecord> {
    const result = await this.assess(runId);
    if (result.ready) {
      return result.plan;
    }
    const code =
      result.code === "PLAN_NOT_FOUND"
        ? "PLAN_NOT_FOUND"
        : result.code === "PLAN_NOT_VALIDATABLE" ||
            result.code === "PLAN_RUN_MISMATCH"
          ? "PLAN_NOT_VALIDATABLE"
          : "VALIDATION_NOT_READY";
    throw new ValidationError(code, result.message, {
      readinessCode: result.code,
      runId,
    });
  }
}
