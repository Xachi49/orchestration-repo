/**
 * Narrow same-run repair for APPROVED plans that are structurally unexecutable
 * before actuation (Revenue Recovery target binding).
 *
 * APPROVED PLAN != MUTABLE PLAN — v1 is superseded, never rewritten.
 * AUTHORIZATION FOR PLAN V1 != AUTHORIZATION FOR PLAN V2
 * PLAN V2 != AUTO-APPROVED
 */

import { randomUUID } from "node:crypto";
import type { ClockPort } from "../infrastructure/clock.js";
import type { RunRepository } from "../admission/run-repository.js";
import { commitRunTransition } from "../admission/run-transition.js";
import type { EventStore } from "../admission/event-store.js";
import type { PlanRepository, StoredPlanRecord } from "./plan-repository.js";
import type { PlanIdentityGenerator } from "./plan-compiler.js";
import { SequencePlanIdentityGenerator } from "./plan-compiler.js";
import {
  parseExecutionPlan,
  type ExecutionPlan,
  type ExecutionPlanForHash,
} from "../domain/plan/execution-plan.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import type { ExecutionAttemptRepository } from "../execution/attempt-repository.js";
import type {
  ExecutionCoordinator,
  ExecutionFenceKey,
} from "../execution/coordinator.js";
import { isRecoveryPhase7ActionType } from "../execution/action-schemas.js";
import {
  validateRecoveryStepsTargetGrammar,
} from "../revenue-recovery/target-grammar.js";
import type { RevenueRecoveryTargetBinder } from "../revenue-recovery/target-binder.js";
import {
  isRecoveryTargetBinderError,
} from "../revenue-recovery/target-binder.js";
import type { RecoveryAttemptRepository } from "../revenue-recovery/repositories.js";
import { assertExecutionPlanRecoveryTargets } from "./recovery-plan-gate.js";

export const APPROVED_PLAN_REPAIR_EVENT = "APPROVED_PLAN_REPAIRED";
export const UNEXECUTABLE_APPROVED_PLAN_REPAIR =
  "UNEXECUTABLE_APPROVED_PLAN_REPAIR";

export const APPROVED_PLAN_REPAIR_REASONS = [
  "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
] as const;

export type ApprovedPlanRepairReason =
  (typeof APPROVED_PLAN_REPAIR_REASONS)[number];

export const ALLOWED_STRUCTURAL_FAILURE_CODES = [
  "EXECUTION_ARGUMENT_INVALID",
] as const;

export type ApprovedPlanRepairErrorCode =
  | "REPAIR_NOT_ELIGIBLE"
  | "REPAIR_IN_PROGRESS"
  | "REPAIR_REASON_DENIED"
  | "REPAIR_BINDING_FAILED"
  | "REPAIR_SEMANTIC_CHANGE_DENIED"
  | "REPAIR_CONFLICT"
  | "RUN_NOT_FOUND";

export class ApprovedPlanRepairError extends Error {
  readonly code: ApprovedPlanRepairErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ApprovedPlanRepairErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "ApprovedPlanRepairError";
    this.code = code;
    this.details = details;
  }
}

export function isApprovedPlanRepairError(
  error: unknown,
): error is ApprovedPlanRepairError {
  return error instanceof ApprovedPlanRepairError;
}

export type ApprovedPlanRepairResult =
  | {
      outcome: "REPAIRED";
      runId: string;
      sourcePlanId: string;
      sourcePlanVersion: number;
      sourcePlanHash: string;
      repairedPlanId: string;
      repairedPlanVersion: number;
      repairedPlanHash: string;
      runState: "VALIDATING";
      reason: ApprovedPlanRepairReason;
    }
  | {
      outcome: "ALREADY_REPAIRED";
      runId: string;
      sourcePlanId: string;
      repairedPlanId: string;
      repairedPlanVersion: number;
      repairedPlanHash: string;
      runState: "VALIDATING" | "BLOCKED" | "REVISING" | string;
    };

export type ApprovedPlanRepairFence = {
  runId: string;
  sourcePlanId: string;
  status: "IN_PROGRESS" | "REPAIRED";
  repairedPlanId?: string;
  repairedPlanVersion?: number;
  repairedPlanHash?: string;
  ownerToken: string;
  updatedAt: string;
};

export interface ApprovedPlanRepairCoordinator {
  begin(
    runId: string,
    sourcePlanId: string,
    nowIso: string,
  ): Promise<
    | { outcome: "STARTED"; ownerToken: string }
    | {
        outcome: "ALREADY_REPAIRED";
        fence: ApprovedPlanRepairFence;
      }
    | { outcome: "IN_PROGRESS"; fence: ApprovedPlanRepairFence }
  >;
  complete(
    runId: string,
    ownerToken: string,
    nowIso: string,
    meta: {
      repairedPlanId: string;
      repairedPlanVersion: number;
      repairedPlanHash: string;
    },
  ): Promise<ApprovedPlanRepairFence>;
  fail(runId: string, ownerToken: string): Promise<void>;
  get(runId: string): Promise<ApprovedPlanRepairFence | null>;
}

export class InMemoryApprovedPlanRepairCoordinator
  implements ApprovedPlanRepairCoordinator
{
  private readonly byRun = new Map<string, ApprovedPlanRepairFence>();
  private seq = 0;

  async get(runId: string): Promise<ApprovedPlanRepairFence | null> {
    return this.byRun.get(runId) ?? null;
  }

  async begin(
    runId: string,
    sourcePlanId: string,
    nowIso: string,
  ): Promise<
    | { outcome: "STARTED"; ownerToken: string }
    | { outcome: "ALREADY_REPAIRED"; fence: ApprovedPlanRepairFence }
    | { outcome: "IN_PROGRESS"; fence: ApprovedPlanRepairFence }
  > {
    const existing = this.byRun.get(runId);
    if (existing?.status === "REPAIRED") {
      return { outcome: "ALREADY_REPAIRED", fence: existing };
    }
    if (existing?.status === "IN_PROGRESS") {
      return { outcome: "IN_PROGRESS", fence: existing };
    }
    this.seq += 1;
    const ownerToken = `repair_owner_${this.seq}`;
    this.byRun.set(runId, {
      runId,
      sourcePlanId,
      status: "IN_PROGRESS",
      ownerToken,
      updatedAt: nowIso,
    });
    return { outcome: "STARTED", ownerToken };
  }

  async complete(
    runId: string,
    ownerToken: string,
    nowIso: string,
    meta: {
      repairedPlanId: string;
      repairedPlanVersion: number;
      repairedPlanHash: string;
    },
  ): Promise<ApprovedPlanRepairFence> {
    const current = this.byRun.get(runId);
    if (!current || current.ownerToken !== ownerToken) {
      throw new ApprovedPlanRepairError(
        "REPAIR_CONFLICT",
        "Repair ownership mismatch",
        { runId },
      );
    }
    const fence: ApprovedPlanRepairFence = {
      runId,
      sourcePlanId: current.sourcePlanId,
      status: "REPAIRED",
      repairedPlanId: meta.repairedPlanId,
      repairedPlanVersion: meta.repairedPlanVersion,
      repairedPlanHash: meta.repairedPlanHash,
      ownerToken,
      updatedAt: nowIso,
    };
    this.byRun.set(runId, fence);
    return fence;
  }

  async fail(runId: string, ownerToken: string): Promise<void> {
    const current = this.byRun.get(runId);
    if (current?.ownerToken === ownerToken && current.status === "IN_PROGRESS") {
      this.byRun.delete(runId);
    }
  }
}

export interface ApprovedPlanRepairServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  authorizationRecords: AuthorizationRecordRepository;
  approvalRequests: ApprovalRequestRepository;
  executionAttempts: ExecutionAttemptRepository;
  executionCoordinator: ExecutionCoordinator;
  recoveryAttempts?: RecoveryAttemptRepository;
  recoveryTargetBinder: RevenueRecoveryTargetBinder;
  coordinator: ApprovedPlanRepairCoordinator;
  clock: ClockPort;
  events?: EventStore;
  identities?: PlanIdentityGenerator;
  planHasher?: Sha256PlanHasher;
  /** Optional durable serialization (e.g. Postgres advisory lock). */
  withLock?: <T>(runId: string, fn: () => Promise<T>) => Promise<T>;
}

export class ApprovedPlanRepairService {
  private readonly identities: PlanIdentityGenerator;
  private readonly hasher: Sha256PlanHasher;

  constructor(private readonly deps: ApprovedPlanRepairServiceDeps) {
    this.identities = deps.identities ?? new SequencePlanIdentityGenerator();
    this.hasher = deps.planHasher ?? new Sha256PlanHasher();
  }

  async repairApprovedPlan(input: {
    runId: string;
    reason: string;
    operatorPrincipalId?: string;
  }): Promise<ApprovedPlanRepairResult> {
    const run = async () => this.repairApprovedPlanLocked(input);
    if (this.deps.withLock) {
      return this.deps.withLock(input.runId, run);
    }
    return run();
  }

  private async repairApprovedPlanLocked(input: {
    runId: string;
    reason: string;
    operatorPrincipalId?: string;
  }): Promise<ApprovedPlanRepairResult> {
    if (
      !(APPROVED_PLAN_REPAIR_REASONS as readonly string[]).includes(input.reason)
    ) {
      throw new ApprovedPlanRepairError(
        "REPAIR_REASON_DENIED",
        `Repair reason ${input.reason} is not allowlisted`,
        { reason: input.reason },
      );
    }
    const reason = input.reason as ApprovedPlanRepairReason;
    const now = this.deps.clock.nowIso();

    const run = await this.deps.runs.getById(input.runId);
    if (!run) {
      throw new ApprovedPlanRepairError(
        "RUN_NOT_FOUND",
        `Run not found: ${input.runId}`,
      );
    }

    const sourcePlan = await this.deps.plans.getByRunId(input.runId);
    if (!sourcePlan) {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "No current plan for run",
        { runId: input.runId },
      );
    }

    const existingFence = await this.deps.coordinator.get(input.runId);
    if (existingFence?.status === "REPAIRED" && existingFence.repairedPlanId) {
      const live = await this.deps.runs.getById(input.runId);
      const repaired = await this.deps.plans.getById(existingFence.repairedPlanId);
      return {
        outcome: "ALREADY_REPAIRED",
        runId: input.runId,
        sourcePlanId: existingFence.sourcePlanId,
        repairedPlanId: existingFence.repairedPlanId,
        repairedPlanVersion: existingFence.repairedPlanVersion ?? 2,
        repairedPlanHash:
          existingFence.repairedPlanHash ?? repaired?.planHash ?? "",
        runState: live?.state ?? "VALIDATING",
      };
    }

    // Idempotent if latest plan already supersedes a prior approved v1 with same reason path
    if (
      sourcePlan.planVersion >= 2 &&
      sourcePlan.supersedesPlanId &&
      run.state === "VALIDATING"
    ) {
      return {
        outcome: "ALREADY_REPAIRED",
        runId: input.runId,
        sourcePlanId: sourcePlan.supersedesPlanId,
        repairedPlanId: sourcePlan.planId,
        repairedPlanVersion: sourcePlan.planVersion,
        repairedPlanHash: sourcePlan.planHash,
        runState: "VALIDATING",
      };
    }

    await this.assertEligible({
      runId: input.runId,
      runState: run.state,
      sourcePlan,
    });

    const begin = await this.deps.coordinator.begin(
      input.runId,
      sourcePlan.planId,
      now,
    );
    if (begin.outcome === "ALREADY_REPAIRED") {
      const live = await this.deps.runs.getById(input.runId);
      return {
        outcome: "ALREADY_REPAIRED",
        runId: input.runId,
        sourcePlanId: begin.fence.sourcePlanId,
        repairedPlanId: begin.fence.repairedPlanId!,
        repairedPlanVersion: begin.fence.repairedPlanVersion ?? 2,
        repairedPlanHash: begin.fence.repairedPlanHash ?? "",
        runState: live?.state ?? "VALIDATING",
      };
    }
    if (begin.outcome === "IN_PROGRESS") {
      throw new ApprovedPlanRepairError(
        "REPAIR_IN_PROGRESS",
        "Approved plan repair already in progress",
        { runId: input.runId },
      );
    }

    const ownerToken = begin.ownerToken;
    try {
      // Re-check after lock; leave APPROVED early for scheduler safety.
      const lockedRun = await this.deps.runs.getById(input.runId);
      if (!lockedRun || lockedRun.state !== "APPROVED") {
        throw new ApprovedPlanRepairError(
          "REPAIR_NOT_ELIGIBLE",
          `Run must be APPROVED to repair (state=${lockedRun?.state ?? "missing"})`,
        );
      }
      await this.assertEligible({
        runId: input.runId,
        runState: lockedRun.state,
        sourcePlan,
      });

      await commitRunTransition(
        this.deps.runs,
        lockedRun,
        "BLOCKED",
        this.deps.clock.nowIso(),
        { failureReasonCode: UNEXECUTABLE_APPROVED_PLAN_REPAIR },
      );

      const blocked = await this.deps.runs.getById(input.runId);
      if (!blocked) {
        throw new ApprovedPlanRepairError("RUN_NOT_FOUND", "Run disappeared");
      }
      await commitRunTransition(
        this.deps.runs,
        blocked,
        "REVISING",
        this.deps.clock.nowIso(),
        { failureReasonCode: UNEXECUTABLE_APPROVED_PLAN_REPAIR },
      );

      const repairedPlan = await this.buildRepairedPlan({
        runId: input.runId,
        sourcePlan,
      });

      assertExecutionPlanRecoveryTargets(repairedPlan, { runId: input.runId });

      const repairedRecord: StoredPlanRecord = {
        planId: repairedPlan.planId,
        runId: input.runId,
        planVersion: repairedPlan.planVersion,
        status: "READY_FOR_VALIDATION",
        plan: repairedPlan,
        planHash: repairedPlan.planHash,
        planningContextFingerprint: sourcePlan.planningContextFingerprint,
        planningPromptVersion: sourcePlan.planningPromptVersion,
        modelProvider: sourcePlan.modelProvider,
        modelId: sourcePlan.modelId,
        createdAt: this.deps.clock.nowIso(),
        supersedesPlanId: sourcePlan.planId,
        lineageRootPlanId: sourcePlan.lineageRootPlanId ?? sourcePlan.planId,
      };

      await this.deps.plans.markSuperseded(sourcePlan.planId);
      await this.deps.plans.save(repairedRecord);

      const revising = await this.deps.runs.getById(input.runId);
      if (!revising) {
        throw new ApprovedPlanRepairError("RUN_NOT_FOUND", "Run disappeared");
      }
      await commitRunTransition(
        this.deps.runs,
        revising,
        "VALIDATING",
        this.deps.clock.nowIso(),
        { failureReasonCode: UNEXECUTABLE_APPROVED_PLAN_REPAIR },
      );

      await this.deps.coordinator.complete(input.runId, ownerToken, this.deps.clock.nowIso(), {
        repairedPlanId: repairedPlan.planId,
        repairedPlanVersion: repairedPlan.planVersion,
        repairedPlanHash: repairedPlan.planHash,
      });

      await this.appendAudit({
        runId: input.runId,
        sourcePlan,
        repairedPlan,
        reason,
        structuralFailureCode: "EXECUTION_ARGUMENT_INVALID",
        ...(input.operatorPrincipalId !== undefined
          ? { operatorPrincipalId: input.operatorPrincipalId }
          : {}),
      });

      return {
        outcome: "REPAIRED",
        runId: input.runId,
        sourcePlanId: sourcePlan.planId,
        sourcePlanVersion: sourcePlan.planVersion,
        sourcePlanHash: sourcePlan.planHash,
        repairedPlanId: repairedPlan.planId,
        repairedPlanVersion: repairedPlan.planVersion,
        repairedPlanHash: repairedPlan.planHash,
        runState: "VALIDATING",
        reason,
      };
    } catch (error) {
      await this.deps.coordinator.fail(input.runId, ownerToken).catch(() => undefined);
      throw error;
    }
  }

  private async assertEligible(input: {
    runId: string;
    runState: string;
    sourcePlan: StoredPlanRecord;
  }): Promise<void> {
    if (input.runState !== "APPROVED") {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        `Run must be APPROVED (state=${input.runState})`,
        { runId: input.runId, state: input.runState },
      );
    }
    if (input.sourcePlan.status === "SUPERSEDED") {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "Current plan is already SUPERSEDED",
      );
    }

    const authz = await this.deps.authorizationRecords.getLatestByRun(
      input.runId,
    );
    if (
      !authz ||
      authz.decision !== "APPROVE" ||
      authz.planId !== input.sourcePlan.planId ||
      authz.planVersion !== input.sourcePlan.planVersion ||
      authz.planHash !== input.sourcePlan.planHash
    ) {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "No matching APPROVE AuthorizationRecord for the current plan",
      );
    }

    const approval = await this.deps.approvalRequests.getById(
      authz.approvalRequestId,
    );
    if (!approval || approval.status !== "APPROVED") {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "Matching ApprovalRequest is not APPROVED",
      );
    }

    const attempts = await this.deps.executionAttempts.listByRun(input.runId);
    const attemptForPlan = attempts.find(
      (a) =>
        a.planId === input.sourcePlan.planId &&
        a.planVersion === input.sourcePlan.planVersion,
    );
    if (attemptForPlan) {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "ExecutionAttempt already exists for this plan",
        { executionAttemptId: attemptForPlan.executionAttemptId },
      );
    }

    const fenceKey: ExecutionFenceKey = {
      runId: input.runId,
      planId: input.sourcePlan.planId,
      planVersion: input.sourcePlan.planVersion,
      planHash: input.sourcePlan.planHash,
      authorizationRecordId: authz.authorizationRecordId,
    };
    const fence = await this.deps.executionCoordinator.get(fenceKey);
    if (fence?.status === "IN_PROGRESS") {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "Execution is in progress; refuse repair",
      );
    }
    if (
      !fence ||
      fence.status !== "FAILED" ||
      !ALLOWED_STRUCTURAL_FAILURE_CODES.includes(
        fence.failureCode as (typeof ALLOWED_STRUCTURAL_FAILURE_CODES)[number],
      )
    ) {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "Repair requires a FAILED execution fence with allowlisted structural failure",
        {
          fenceStatus: fence?.status ?? null,
          failureCode: fence?.failureCode ?? null,
        },
      );
    }

    const recoverySteps = input.sourcePlan.plan.steps.filter((s) =>
      isRecoveryPhase7ActionType(s.actionType),
    );
    if (recoverySteps.length === 0) {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "Plan has no Revenue Recovery steps to repair",
      );
    }
    const grammar = validateRecoveryStepsTargetGrammar(
      input.sourcePlan.plan.steps,
    );
    if (grammar.ok) {
      throw new ApprovedPlanRepairError(
        "REPAIR_NOT_ELIGIBLE",
        "Recovery targets are already well-formed; refuse generic plan mutation",
      );
    }

    if (this.deps.recoveryAttempts) {
      // Prefer case binding via binder when possible; otherwise scan attempts by runId.
      try {
        const binding =
          await this.deps.recoveryTargetBinder.resolveCaseAndLead(input.runId);
        const caseAttempts = await this.deps.recoveryAttempts.listByCase(
          binding.recoveryCase.recoveryCaseId,
        );
        const fromThisRun = caseAttempts.find((a) => a.runId === input.runId);
        if (fromThisRun) {
          throw new ApprovedPlanRepairError(
            "REPAIR_NOT_ELIGIBLE",
            "RecoveryAttempt already exists for this run; refuse repair after side effect",
            { recoveryAttemptId: fromThisRun.attemptId },
          );
        }
      } catch (error) {
        if (isApprovedPlanRepairError(error)) {
          throw error;
        }
        // Binder failure is handled later during repair build.
      }
    }
  }

  private async buildRepairedPlan(input: {
    runId: string;
    sourcePlan: StoredPlanRecord;
  }): Promise<ExecutionPlan> {
    const source = input.sourcePlan.plan;
    let boundSteps;
    try {
      boundSteps = await this.deps.recoveryTargetBinder.bindPlanSteps({
        runId: input.runId,
        steps: source.steps,
      });
    } catch (error) {
      if (isRecoveryTargetBinderError(error)) {
        throw new ApprovedPlanRepairError(
          "REPAIR_BINDING_FAILED",
          error.message,
          { binderCode: error.code, ...error.details },
        );
      }
      throw error;
    }

    // Only targetIds may change; refuse any other step field drift.
    for (let i = 0; i < source.steps.length; i += 1) {
      const before = source.steps[i]!;
      const after = boundSteps[i]!;
      if (
        before.stepId !== after.stepId ||
        before.actionType !== after.actionType ||
        before.description !== (after as { description?: string }).description
      ) {
        throw new ApprovedPlanRepairError(
          "REPAIR_SEMANTIC_CHANGE_DENIED",
          "Repair may only bind recovery targetIds",
        );
      }
    }

    const newPlanId = this.identities.nextPlanId();
    const planVersion = input.sourcePlan.planVersion + 1;
    const steps = boundSteps.map((step) => {
      const original = source.steps.find((s) => s.stepId === step.stepId)!;
      return {
        ...original,
        targetIds: [...step.targetIds],
        idempotencyKey: `${newPlanId}:${original.stepId}`,
      };
    });

    const forHash: ExecutionPlanForHash = {
      planId: newPlanId,
      planVersion,
      objectiveId: source.objectiveId,
      objectiveVersion: source.objectiveVersion,
      repositoryCommitSha: source.repositoryCommitSha,
      repositoryFingerprint: source.repositoryFingerprint,
      policyBundleId: source.policyBundleId,
      policyBundleHash: source.policyBundleHash,
      schemaVersion: source.schemaVersion,
      assumptions: [...source.assumptions],
      unknowns: [...source.unknowns],
      successDefinition: [...source.successDefinition],
      resourceTotals: { ...source.resourceTotals },
      criticalPath: [...source.criticalPath],
      workstreams: source.workstreams.map((ws) => ({
        workstreamId: ws.workstreamId,
        name: ws.name,
        stepIds: [...ws.stepIds],
      })),
      steps,
      approvalRequirements: [...source.approvalRequirements],
      failurePolicy: { ...source.failurePolicy },
      acceptanceCriterionVerificationBindings: [
        ...source.acceptanceCriterionVerificationBindings,
      ],
    };
    const planHash = this.hasher.hash(forHash);
    return parseExecutionPlan({ ...forHash, planHash });
  }

  private async appendAudit(input: {
    runId: string;
    sourcePlan: StoredPlanRecord;
    repairedPlan: ExecutionPlan;
    reason: ApprovedPlanRepairReason;
    structuralFailureCode: string;
    operatorPrincipalId?: string;
  }): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    const run = await this.deps.runs.getById(input.runId);
    if (!run) {
      return;
    }
    const now = this.deps.clock.nowIso();
    await this.deps.events.append({
      eventId: `evt_${randomUUID()}`,
      eventType: APPROVED_PLAN_REPAIR_EVENT,
      eventVersion: "1",
      runId: run.runId,
      correlationId: run.correlationId,
      causationId: input.sourcePlan.planId,
      idempotencyKey: `${APPROVED_PLAN_REPAIR_EVENT}:${input.sourcePlan.planId}:${input.repairedPlan.planId}`,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      objectiveVersion: run.objectiveVersion,
      traceId: run.traceId,
      createdAt: now,
      expiresAt: now,
      schemaVersion: "1",
      data: {
        runId: run.runId,
        sourcePlanId: input.sourcePlan.planId,
        sourcePlanVersion: input.sourcePlan.planVersion,
        sourcePlanHash: input.sourcePlan.planHash,
        repairedPlanId: input.repairedPlan.planId,
        repairedPlanVersion: input.repairedPlan.planVersion,
        repairedPlanHash: input.repairedPlan.planHash,
        repairReason: input.reason,
        structuralFailureCode: input.structuralFailureCode,
        transitionReason: UNEXECUTABLE_APPROVED_PLAN_REPAIR,
        timestamp: now,
        ...(input.operatorPrincipalId !== undefined
          ? { operatorPrincipalId: input.operatorPrincipalId }
          : {}),
      },
    });
  }
}
