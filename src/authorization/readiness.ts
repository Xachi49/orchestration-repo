import { z } from "zod";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository, StoredPlanRecord } from "../planning/plan-repository.js";
import type { ValidationDecisionRepository } from "../validation/decision-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
import type { ValidationDecision } from "../domain/validation/index.js";
import { AuthorizationError } from "./errors.js";

export const AuthorizationReadinessCodeSchema = z.enum([
  "READY",
  "RUN_NOT_VALIDATING",
  "DECISION_NOT_TERMINAL",
  "PLAN_MISMATCH",
  "DECISION_MISMATCH",
  "PLAN_SUPERSEDED",
  "REPOSITORY_STALE",
  "REPOSITORY_INVALID",
  "POLICY_MISMATCH",
  "OBJECTIVE_MISMATCH",
  "PLAN_NOT_FOUND",
  "DECISION_NOT_FOUND",
  "CONTROL_CONTEXT_UNAVAILABLE",
]);
export type AuthorizationReadinessCode = z.infer<
  typeof AuthorizationReadinessCodeSchema
>;

export type AuthorizationReadinessResult =
  | {
      ready: true;
      code: "READY";
      plan: StoredPlanRecord;
      decision: ValidationDecision;
    }
  | {
      ready: false;
      code: Exclude<AuthorizationReadinessCode, "READY">;
      message: string;
    };

const TERMINAL_DECISIONS = new Set([
  "PASS",
  "BLOCK",
  "HUMAN_APPROVAL_REQUIRED",
]);

const TERMINAL_PLAN_STATUSES = new Set([
  "VALIDATED_PASS",
  "VALIDATED_BLOCK",
  "VALIDATED_APPROVAL_REQUIRED",
]);

export interface AuthorizationReadinessServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  decisions: ValidationDecisionRepository;
  locks: LockedRepositoryStore;
}

/**
 * Gate before human authorization routing. Fail closed on any drift or mismatch.
 */
export class AuthorizationReadinessService {
  constructor(private readonly deps: AuthorizationReadinessServiceDeps) {}

  async assess(runId: string): Promise<AuthorizationReadinessResult> {
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
    if (plan.status === "SUPERSEDED") {
      return {
        ready: false,
        code: "PLAN_SUPERSEDED",
        message: `Latest plan ${plan.planId} is SUPERSEDED`,
      };
    }
    if (!TERMINAL_PLAN_STATUSES.has(plan.status)) {
      return {
        ready: false,
        code: "PLAN_MISMATCH",
        message: `Plan ${plan.planId} status is ${plan.status}, expected terminal validated status`,
      };
    }

    const decision = await this.deps.decisions.getLatestByRunId(runId);
    if (!decision) {
      return {
        ready: false,
        code: "DECISION_NOT_FOUND",
        message: `No validation decision for run ${runId}`,
      };
    }
    if (!TERMINAL_DECISIONS.has(decision.decision)) {
      return {
        ready: false,
        code: "DECISION_NOT_TERMINAL",
        message: `Validation decision ${decision.decision} is not terminal for authorization`,
      };
    }

    const planBoundDecision = await this.deps.decisions.getByPlan(
      runId,
      plan.planId,
      plan.planVersion,
    );
    if (
      !planBoundDecision ||
      planBoundDecision.validationDecisionId !== decision.validationDecisionId
    ) {
      return {
        ready: false,
        code: "DECISION_MISMATCH",
        message: "Latest validation decision does not bind to the latest plan",
      };
    }

    if (
      decision.planId !== plan.planId ||
      decision.planVersion !== plan.planVersion ||
      decision.planHash !== plan.planHash ||
      decision.planHash !== plan.plan.planHash
    ) {
      return {
        ready: false,
        code: "PLAN_MISMATCH",
        message: "Validation decision does not match final plan identity",
      };
    }

    const allPlans = await this.deps.plans.listByRunId(runId);
    const newer = allPlans.some(
      (candidate) =>
        candidate.planVersion > plan.planVersion &&
        candidate.status !== "SUPERSEDED",
    );
    if (newer) {
      return {
        ready: false,
        code: "PLAN_SUPERSEDED",
        message: "A newer plan version supersedes the candidate",
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
      objective.projectId !== run.projectId ||
      objective.objectiveId !== plan.plan.objectiveId ||
      objective.objectiveVersion !== plan.plan.objectiveVersion
    ) {
      return {
        ready: false,
        code: "OBJECTIVE_MISMATCH",
        message: "Objective identity does not match run/plan",
      };
    }

    let resolved;
    try {
      resolved = await this.deps.controlPlane.resolve(
        run.projectId,
        run.requestedEnvironment,
      );
    } catch {
      return {
        ready: false,
        code: "CONTROL_CONTEXT_UNAVAILABLE",
        message: "Control Plane context unavailable",
      };
    }

    if (
      resolved.activePolicyBundle.policyHash !== decision.policyBundleHash ||
      resolved.activePolicyBundle.policyHash !== plan.plan.policyBundleHash ||
      resolved.activePolicyBundle.policyBundleId !== plan.plan.policyBundleId
    ) {
      return {
        ready: false,
        code: "POLICY_MISMATCH",
        message: "Active policy bundle hash does not match plan/decision",
      };
    }

    const lock = await this.deps.locks.getByRunId(runId);
    if (!lock) {
      return {
        ready: false,
        code: "REPOSITORY_INVALID",
        message: "No locked repository state for authorization",
      };
    }
    if (lock.status === "STALE") {
      return {
        ready: false,
        code: "REPOSITORY_STALE",
        message: "Live locked repository state is STALE",
      };
    }
    if (lock.status === "INVALID") {
      return {
        ready: false,
        code: "REPOSITORY_INVALID",
        message: "Live locked repository state is INVALID",
      };
    }
    if (
      lock.commitSha !== plan.plan.repositoryCommitSha ||
      decision.repositoryFingerprint !== plan.plan.repositoryFingerprint
    ) {
      return {
        ready: false,
        code: "PLAN_MISMATCH",
        message: "Repository lock/fingerprint does not match plan",
      };
    }

    return { ready: true, code: "READY", plan, decision };
  }

  async requireReady(runId: string): Promise<{
    plan: StoredPlanRecord;
    decision: ValidationDecision;
  }> {
    const result = await this.assess(runId);
    if (!result.ready) {
      throw new AuthorizationError(
        "AUTHORIZATION_NOT_READY",
        result.message,
        { code: result.code, runId },
      );
    }
    return { plan: result.plan, decision: result.decision };
  }
}
