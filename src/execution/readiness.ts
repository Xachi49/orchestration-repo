import { z } from "zod";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository, StoredPlanRecord } from "../planning/plan-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { AuthorizationRecord } from "../domain/authorization/index.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { isExpired } from "../authorization/identity.js";
import { ExecutionError } from "./errors.js";
import {
  capabilitySetFingerprint,
  uniqueCapabilitiesForPlanActions,
} from "./capability-fingerprint.js";

export const ExecutionReadinessCodeSchema = z.enum([
  "READY",
  "RUN_NOT_APPROVED",
  "AUTHORIZATION_RECORD_MISSING",
  "AUTHORIZATION_NOT_APPROVE",
  "AUTHORIZATION_BINDING_MISMATCH",
  "APPROVAL_REQUEST_INVALID",
  "PLAN_MISMATCH",
  "PLAN_SUPERSEDED",
  "PLAN_HASH_MISMATCH",
  "REPOSITORY_STALE",
  "REPOSITORY_INVALID",
  "POLICY_MISMATCH",
  "CAPABILITY_UNAVAILABLE",
  "CAPABILITY_AUTHORITY_CHANGED",
  "ENVIRONMENT_DENIED",
  "EXECUTION_MODE_DENIED",
  "CONTROL_CONTEXT_UNAVAILABLE",
  "OBJECTIVE_MISMATCH",
]);
export type ExecutionReadinessCode = z.infer<
  typeof ExecutionReadinessCodeSchema
>;

export type ExecutionReadinessResult =
  | {
      ready: true;
      code: "READY";
      plan: StoredPlanRecord;
      authorizationRecord: AuthorizationRecord;
      capabilitySetFingerprint: string;
    }
  | {
      ready: false;
      code: Exclude<ExecutionReadinessCode, "READY">;
      message: string;
    };

export interface ExecutionReadinessServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  locks: LockedRepositoryStore;
  authorizationRecords: AuthorizationRecordRepository;
  approvalRequests: ApprovalRequestRepository;
  clockNowIso: () => string;
  planHasher?: Sha256PlanHasher;
}

const EXECUTABLE_PLAN_STATUSES = new Set([
  "VALIDATED_PASS",
  "VALIDATED_APPROVAL_REQUIRED",
]);

/**
 * Gate before any actuator runs. Fail closed on any mismatch or drift.
 */
export class ExecutionReadinessService {
  private readonly planHasher: Sha256PlanHasher;

  constructor(private readonly deps: ExecutionReadinessServiceDeps) {
    this.planHasher = deps.planHasher ?? new Sha256PlanHasher();
  }

  async assess(runId: string): Promise<ExecutionReadinessResult> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      return {
        ready: false,
        code: "RUN_NOT_APPROVED",
        message: `Run not found: ${runId}`,
      };
    }
    if (run.state !== "APPROVED") {
      return {
        ready: false,
        code: "RUN_NOT_APPROVED",
        message: `Run ${runId} is in ${run.state}, expected APPROVED`,
      };
    }

    const authorizationRecord =
      await this.deps.authorizationRecords.getLatestByRun(runId);
    if (!authorizationRecord) {
      return {
        ready: false,
        code: "AUTHORIZATION_RECORD_MISSING",
        message: `No AuthorizationRecord for run ${runId}`,
      };
    }
    if (authorizationRecord.decision !== "APPROVE") {
      return {
        ready: false,
        code: "AUTHORIZATION_NOT_APPROVE",
        message: `AuthorizationRecord decision is ${authorizationRecord.decision}`,
      };
    }

    const approvalRequest = await this.deps.approvalRequests.getById(
      authorizationRecord.approvalRequestId,
    );
    if (!approvalRequest || approvalRequest.status !== "APPROVED") {
      return {
        ready: false,
        code: "APPROVAL_REQUEST_INVALID",
        message: "ApprovalRequest is missing or not APPROVED",
      };
    }
    if (isExpired(approvalRequest.expiresAt, this.deps.clockNowIso())) {
      return {
        ready: false,
        code: "APPROVAL_REQUEST_INVALID",
        message: "ApprovalRequest is expired",
      };
    }

    const plan = await this.deps.plans.getByRunId(runId);
    if (!plan) {
      return {
        ready: false,
        code: "PLAN_MISMATCH",
        message: `No plan for run ${runId}`,
      };
    }
    if (plan.status === "SUPERSEDED") {
      return {
        ready: false,
        code: "PLAN_SUPERSEDED",
        message: `Plan ${plan.planId} is SUPERSEDED`,
      };
    }
    if (!EXECUTABLE_PLAN_STATUSES.has(plan.status)) {
      return {
        ready: false,
        code: "PLAN_MISMATCH",
        message: `Plan status ${plan.status} is not executable`,
      };
    }

    const bindingOk =
      authorizationRecord.runId === runId &&
      authorizationRecord.projectId === run.projectId &&
      authorizationRecord.objectiveId === run.objectiveId &&
      authorizationRecord.objectiveVersion === run.objectiveVersion &&
      authorizationRecord.planId === plan.planId &&
      authorizationRecord.planVersion === plan.planVersion &&
      authorizationRecord.planHash === plan.planHash &&
      authorizationRecord.planHash === plan.plan.planHash &&
      authorizationRecord.repositoryFingerprint ===
        plan.plan.repositoryFingerprint &&
      authorizationRecord.policyBundleHash === plan.plan.policyBundleHash &&
      authorizationRecord.approvalRequestId ===
        approvalRequest.approvalRequestId &&
      authorizationRecord.validationDecisionId ===
        approvalRequest.validationDecisionId &&
      authorizationRecord.capabilitySetFingerprint ===
        approvalRequest.capabilitySetFingerprint;

    if (!bindingOk) {
      return {
        ready: false,
        code: "AUTHORIZATION_BINDING_MISMATCH",
        message:
          "AuthorizationRecord does not match exact approved plan binding",
      };
    }

    const recomputed = this.planHasher.hash(plan.plan);
    if (recomputed !== plan.planHash || recomputed !== plan.plan.planHash) {
      return {
        ready: false,
        code: "PLAN_HASH_MISMATCH",
        message: "Plan hash does not recompute correctly",
      };
    }

    const objective = await this.deps.objectives.getByRunBinding(runId);
    if (
      !objective ||
      objective.objectiveId !== authorizationRecord.objectiveId ||
      objective.objectiveVersion !== authorizationRecord.objectiveVersion
    ) {
      return {
        ready: false,
        code: "OBJECTIVE_MISMATCH",
        message: "Objective does not match authorization binding",
      };
    }

    let control;
    try {
      control = await this.deps.controlPlane.resolve(
        run.projectId,
        run.requestedEnvironment,
      );
    } catch {
      return {
        ready: false,
        code: "CONTROL_CONTEXT_UNAVAILABLE",
        message: "Control plane context unavailable",
      };
    }

    if (control.project.executionMode === "PLAN_ONLY") {
      return {
        ready: false,
        code: "EXECUTION_MODE_DENIED",
        message: "PLAN_ONLY projects cannot execute",
      };
    }

    if (
      !control.project.allowedEnvironments.includes(run.requestedEnvironment)
    ) {
      return {
        ready: false,
        code: "ENVIRONMENT_DENIED",
        message: `Environment ${run.requestedEnvironment} is not allowed`,
      };
    }

    if (
      control.activePolicyBundle.policyHash !== plan.plan.policyBundleHash ||
      control.activePolicyBundle.policyHash !==
        authorizationRecord.policyBundleHash
    ) {
      return {
        ready: false,
        code: "POLICY_MISMATCH",
        message: "Active policy bundle hash does not match the plan",
      };
    }

    const lock = await this.deps.locks.getByRunId(runId);
    if (!lock) {
      return {
        ready: false,
        code: "REPOSITORY_INVALID",
        message: "Locked repository is missing",
      };
    }
    if (lock.status === "STALE") {
      return {
        ready: false,
        code: "REPOSITORY_STALE",
        message: "Locked repository is STALE",
      };
    }
    if (lock.status !== "VERIFIED" && lock.status !== "LOCKED") {
      return {
        ready: false,
        code: "REPOSITORY_INVALID",
        message: `Locked repository status is ${lock.status}`,
      };
    }
    // Prefer VERIFIED; LOCKED alone fails closed for execution freshness.
    if (lock.status !== "VERIFIED") {
      return {
        ready: false,
        code: "REPOSITORY_INVALID",
        message: "Locked repository must be VERIFIED before execution",
      };
    }
    if (lock.commitSha !== plan.plan.repositoryCommitSha) {
      return {
        ready: false,
        code: "REPOSITORY_STALE",
        message: "Repository commit SHA drifted from the approved plan",
      };
    }

    const uniqueCaps = uniqueCapabilitiesForPlanActions({
      stepActionTypes: plan.plan.steps.map((s) => s.actionType),
      availableCapabilities: control.availableCapabilities,
    });
    for (const step of plan.plan.steps) {
      const caps = control.availableCapabilities.filter((c) =>
        c.allowedActions.includes(step.actionType),
      );
      if (caps.length === 0) {
        return {
          ready: false,
          code: "CAPABILITY_UNAVAILABLE",
          message: `No enabled capability permits action ${step.actionType}`,
        };
      }
    }

    const liveFingerprint = capabilitySetFingerprint(uniqueCaps);
    const authorizedFingerprint = authorizationRecord.capabilitySetFingerprint;
    if (liveFingerprint !== authorizedFingerprint) {
      return {
        ready: false,
        code: "CAPABILITY_AUTHORITY_CHANGED",
        message:
          "Live Control Plane capability authority does not match AuthorizationRecord.capabilitySetFingerprint",
      };
    }

    return {
      ready: true,
      code: "READY",
      plan,
      authorizationRecord,
      capabilitySetFingerprint: authorizedFingerprint,
    };
  }

  async requireReady(
    runId: string,
  ): Promise<Extract<ExecutionReadinessResult, { ready: true }>> {
    const result = await this.assess(runId);
    if (!result.ready) {
      if (result.code === "EXECUTION_MODE_DENIED") {
        throw new ExecutionError("EXECUTION_MODE_DENIED", result.message, {
          code: result.code,
        });
      }
      if (result.code === "CAPABILITY_AUTHORITY_CHANGED") {
        throw new ExecutionError(
          "EXECUTION_CAPABILITY_CHANGED",
          result.message,
          { code: result.code },
        );
      }
      throw new ExecutionError("EXECUTION_NOT_READY", result.message, {
        code: result.code,
      });
    }
    return result;
  }
}
