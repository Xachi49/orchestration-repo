import type { RunRepository } from "../admission/run-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { AuthorizationRecord } from "../domain/authorization/index.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { ExecutionError } from "./errors.js";
import {
  capabilitySetFingerprint,
  uniqueCapabilitiesForPlanActions,
} from "./capability-fingerprint.js";
import { ExecutionTargetValidator } from "./target-validator.js";

export interface ExecutionPreflightServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  controlPlane: ControlPlaneService;
  locks: LockedRepositoryStore;
  authorizationRecords: AuthorizationRecordRepository;
  expectedCapabilityFingerprint: string;
  planHasher?: Sha256PlanHasher;
}

/**
 * Freshness recheck immediately before actuation.
 * Distinct from Phase 6 approval-time freshness — never silently reapproves.
 */
export class ExecutionPreflightService {
  private readonly planHasher: Sha256PlanHasher;
  private readonly targets = new ExecutionTargetValidator();

  constructor(private readonly deps: ExecutionPreflightServiceDeps) {
    this.planHasher = deps.planHasher ?? new Sha256PlanHasher();
  }

  async assertFresh(input: {
    runId: string;
    plan: StoredPlanRecord;
    authorizationRecord: AuthorizationRecord;
    workspaceRoot: string;
  }): Promise<void> {
    const run = await this.deps.runs.getById(input.runId);
    if (!run || (run.state !== "APPROVED" && run.state !== "EXECUTING")) {
      throw new ExecutionError(
        "EXECUTION_BINDING_STALE",
        `Run is not APPROVED/EXECUTING (state=${run?.state ?? "missing"})`,
      );
    }

    const liveRecord = await this.deps.authorizationRecords.getLatestByRun(
      input.runId,
    );
    if (
      !liveRecord ||
      liveRecord.authorizationRecordId !==
        input.authorizationRecord.authorizationRecordId ||
      liveRecord.planHash !== input.authorizationRecord.planHash ||
      liveRecord.decision !== "APPROVE"
    ) {
      throw new ExecutionError(
        "EXECUTION_BINDING_STALE",
        "Authorization binding changed since readiness",
      );
    }

    const livePlan = await this.deps.plans.getByRunId(input.runId);
    if (
      !livePlan ||
      livePlan.planHash !== input.plan.planHash ||
      this.planHasher.hash(livePlan.plan) !== input.plan.planHash
    ) {
      throw new ExecutionError(
        "EXECUTION_BINDING_STALE",
        "Plan hash changed since readiness",
      );
    }

    const lock = await this.deps.locks.getByRunId(input.runId);
    if (!lock || lock.status !== "VERIFIED") {
      throw new ExecutionError(
        "EXECUTION_REPOSITORY_STALE",
        "Repository lock is not VERIFIED at preflight",
      );
    }
    if (lock.commitSha !== input.plan.plan.repositoryCommitSha) {
      throw new ExecutionError(
        "EXECUTION_REPOSITORY_STALE",
        "Locked commit SHA drifted at preflight",
      );
    }

    let control;
    try {
      control = await this.deps.controlPlane.resolve(
        run.projectId,
        run.requestedEnvironment,
      );
    } catch {
      throw new ExecutionError(
        "EXECUTION_POLICY_CHANGED",
        "Control context unavailable at preflight",
      );
    }

    if (
      control.activePolicyBundle.policyHash !==
      input.authorizationRecord.policyBundleHash
    ) {
      throw new ExecutionError(
        "EXECUTION_POLICY_CHANGED",
        "Policy bundle hash changed at preflight",
      );
    }

    if (control.project.executionMode === "PLAN_ONLY") {
      throw new ExecutionError(
        "EXECUTION_MODE_DENIED",
        "PLAN_ONLY denies execution at preflight",
      );
    }

    for (const step of input.plan.plan.steps) {
      const caps = control.availableCapabilities.filter((c) =>
        c.allowedActions.includes(step.actionType),
      );
      if (caps.length === 0) {
        throw new ExecutionError(
          "EXECUTION_CAPABILITY_CHANGED",
          `Capability for ${step.actionType} unavailable at preflight`,
        );
      }

      if (control.project.executionMode === "PATCH_ONLY") {
        const allowedPatchOnly = new Set([
          "CREATE_LOCAL_PATCH",
          "RUN_TESTS",
          "CREATE_TASK",
          "PREPARE_PULL_REQUEST",
          "READ_FILE",
        ]);
        if (!allowedPatchOnly.has(step.actionType)) {
          throw new ExecutionError(
            "EXECUTION_MODE_DENIED",
            `PATCH_ONLY forbids action ${step.actionType}`,
          );
        }
      }
    }

    const uniqueCaps = uniqueCapabilitiesForPlanActions({
      stepActionTypes: input.plan.plan.steps.map((s) => s.actionType),
      availableCapabilities: control.availableCapabilities,
    });
    const liveFingerprint = capabilitySetFingerprint(uniqueCaps);
    if (liveFingerprint !== this.deps.expectedCapabilityFingerprint) {
      throw new ExecutionError(
        "EXECUTION_CAPABILITY_CHANGED",
        "Capability set fingerprint changed at preflight",
      );
    }

    for (const step of input.plan.plan.steps) {
      for (const target of step.targetIds) {
        if (target === "workspace") {
          continue;
        }
        if (
          step.actionType === "RUN_TESTS" ||
          step.actionType === "CREATE_TASK" ||
          step.actionType === "PREPARE_PULL_REQUEST"
        ) {
          continue;
        }
        try {
          this.targets.resolveContained(input.workspaceRoot, target);
        } catch (error) {
          if (error instanceof ExecutionError) {
            throw error;
          }
          throw new ExecutionError(
            "EXECUTION_TARGET_MISSING",
            `Target invalid at preflight: ${target}`,
          );
        }
      }
    }
  }
}
