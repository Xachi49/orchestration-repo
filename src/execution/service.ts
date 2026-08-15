import type { ClockPort } from "../infrastructure/clock.js";
import type { RunRepository } from "../admission/run-repository.js";
import { withRunState } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { LockedRepositoryStore } from "../ingestion/locked-state.js";
import type { EventStore } from "../admission/event-store.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import {
  parseExecutionAttempt,
  parseExecutionAuthoritySnapshot,
  parseExecutionResult,
  type ExecutionAuthoritySnapshot,
  type ExecutionResult,
  type StepExecutionResult,
} from "../domain/execution/index.js";
import { assertTransition } from "../domain/run/run-state.js";
import {
  workspaceRootFor,
} from "../ingestion/workspace-paths.js";
import { DependencyGraphService } from "../planning/dependency-graph.js";
import type { SafeActuator } from "./actuator.js";
import type { ExecutionArtifactRepository } from "./artifact-repository.js";
import type { ExecutionAttemptRepository } from "./attempt-repository.js";
import { buildContainmentResult } from "./containment.js";
import type {
  ExecutionCoordinator,
  ExecutionFenceKey,
} from "./coordinator.js";
import { DryRunCompiler, type CompiledExecutionStep } from "./dry-run.js";
import { ExecutionError, isExecutionError } from "./errors.js";
import type { ExecutionIdentityGenerator } from "./identity.js";
import { SequenceExecutionIdentityGenerator } from "./identity.js";
import { fingerprintValue, rollbackIdempotencyKey } from "./idempotency.js";
import {
  capabilitySetFingerprint,
  uniqueCapabilitiesForPlanActions,
} from "./capability-fingerprint.js";
import { ExecutionPreconditionService } from "./precondition.js";
import { ExecutionPreflightService } from "./preflight.js";
import { ExecutionReadinessService } from "./readiness.js";
import { ExecutionResourceLedger } from "./resource-ledger.js";
import { RollbackService } from "./rollback.js";
import type { StepExecutionRepository } from "./step-repository.js";
import { TestProfileRegistry } from "./test-profiles.js";
import {
  CreateLocalPatchArgsSchema,
  CreateTaskArgsSchema,
  PreparePullRequestArgsSchema,
  RunTestsArgsSchema,
} from "./action-schemas.js";
import { artifactRootFor } from "./paths.js";
import type { Capability } from "../control-plane/capabilities/capability.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";
import type { ProjectControlContext } from "../control-plane/context.js";

export interface ExecutionServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
  locks: LockedRepositoryStore;
  authorizationRecords: AuthorizationRecordRepository;
  approvalRequests: ApprovalRequestRepository;
  readiness: ExecutionReadinessService;
  coordinator: ExecutionCoordinator;
  steps: StepExecutionRepository;
  attempts: ExecutionAttemptRepository;
  artifacts: ExecutionArtifactRepository;
  actuator: SafeActuator;
  clock: ClockPort;
  dataRoot: string;
  events?: EventStore;
  identities?: ExecutionIdentityGenerator;
  testProfiles?: TestProfileRegistry;
  dependencies?: DependencyGraphService;
}

/**
 * Bounded Phase 7 execution.
 *
 * APPROVED → EXECUTING only. Does not COMPLETE.
 * EXECUTION_SUCCEEDED ≠ VERIFIED_SUCCESS.
 * No planning or approval authority. No model calls.
 */
export class ExecutionService {
  private readonly identities: ExecutionIdentityGenerator;
  private readonly testProfiles: TestProfileRegistry;
  private readonly dryRun: DryRunCompiler;
  private readonly dependencies: DependencyGraphService;
  private readonly rollback = new RollbackService();
  private readonly resultsByRun = new Map<string, ExecutionResult>();
  private readonly snapshotsByAttempt = new Map<
    string,
    ExecutionAuthoritySnapshot
  >();

  constructor(private readonly deps: ExecutionServiceDeps) {
    this.identities =
      deps.identities ?? new SequenceExecutionIdentityGenerator();
    this.testProfiles = deps.testProfiles ?? new TestProfileRegistry();
    this.dryRun = new DryRunCompiler(this.testProfiles);
    this.dependencies = deps.dependencies ?? new DependencyGraphService();
  }

  async execute(runId: string): Promise<ExecutionResult> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      throw new ExecutionError("EXECUTION_NOT_READY", `Run not found: ${runId}`);
    }

    // Idempotent replay for terminal fences (success stays EXECUTING; containment
    // may leave the run CONTAINED).
    if (run.state === "EXECUTING" || run.state === "CONTAINED") {
      const plan = await this.deps.plans.getByRunId(runId);
      const authorizationRecord =
        await this.deps.authorizationRecords.getLatestByRun(runId);
      if (plan && authorizationRecord) {
        const fenceKey: ExecutionFenceKey = {
          runId,
          planId: plan.planId,
          planVersion: plan.planVersion,
          planHash: plan.planHash,
          authorizationRecordId: authorizationRecord.authorizationRecordId,
        };
        const fence = await this.deps.coordinator.get(fenceKey);
        if (
          fence &&
          (fence.status === "COMPLETED" ||
            fence.status === "FAILED" ||
            fence.status === "CONTAINED")
        ) {
          const prior = await this.deps.coordinator.getResult(fenceKey);
          if (prior) {
            return prior;
          }
          const cached = this.resultsByRun.get(runId);
          if (cached) {
            return cached;
          }
        }
        if (fence?.status === "IN_PROGRESS" && run.state === "EXECUTING") {
          throw new ExecutionError(
            "EXECUTION_IN_PROGRESS",
            "Execution is already in progress for this authorization",
          );
        }
      }
    }

    const ready = await this.deps.readiness.requireReady(runId);
    const {
      plan,
      authorizationRecord,
      capabilitySetFingerprint: authorizedCapabilityFingerprint,
    } = ready;

    const fenceKey: ExecutionFenceKey = {
      runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      authorizationRecordId: authorizationRecord.authorizationRecordId,
    };

    const nowIso = this.deps.clock.nowIso();
    const begin = await this.deps.coordinator.begin(fenceKey, nowIso);
    if (begin.outcome === "IN_PROGRESS") {
      throw new ExecutionError(
        "EXECUTION_IN_PROGRESS",
        "Execution is already in progress for this authorization",
      );
    }
    if (begin.outcome === "ALREADY_COMPLETED") {
      const prior =
        begin.result ?? (await this.deps.coordinator.getResult(fenceKey));
      if (prior) {
        return prior;
      }
      const cached = this.resultsByRun.get(runId);
      if (cached) {
        return cached;
      }
      throw new ExecutionError(
        "EXECUTION_ALREADY_COMPLETED",
        "Execution fence is terminal but result is missing",
      );
    }

    const ownerToken = begin.ownerToken;
    const workspaceRoot = workspaceRootFor(this.deps.dataRoot, runId);
    const artifactRoot = artifactRootFor(this.deps.dataRoot, runId);

    try {
      const preflight = new ExecutionPreflightService({
        runs: this.deps.runs,
        plans: this.deps.plans,
        controlPlane: this.deps.controlPlane,
        locks: this.deps.locks,
        authorizationRecords: this.deps.authorizationRecords,
        expectedCapabilityFingerprint: authorizedCapabilityFingerprint,
      });
      await preflight.assertFresh({
        runId,
        plan,
        authorizationRecord,
        workspaceRoot,
      });

      const control = await this.deps.controlPlane.resolve(
        (await this.deps.runs.getById(runId))!.projectId,
        (await this.deps.runs.getById(runId))!.requestedEnvironment,
      );

      const capabilityIdsByAction = new Map<string, string>();
      for (const cap of control.availableCapabilities) {
        for (const action of cap.allowedActions) {
          if (!capabilityIdsByAction.has(action)) {
            capabilityIdsByAction.set(action, cap.capabilityId);
          }
        }
      }

      const compiled = this.dryRun.compile({
        plan: plan.plan,
        workspaceRoot,
        capabilityIdsByAction,
      });

      const attemptId = this.identities.nextExecutionAttemptId();
      const authorizedCapabilitySetFingerprint =
        authorizationRecord.capabilitySetFingerprint;
      if (
        authorizedCapabilitySetFingerprint !== authorizedCapabilityFingerprint
      ) {
        throw new ExecutionError(
          "EXECUTION_CAPABILITY_CHANGED",
          "Readiness fingerprint does not match AuthorizationRecord",
        );
      }
      const liveCapabilitySetFingerprint = capabilitySetFingerprint(
        uniqueCapabilitiesForPlanActions({
          stepActionTypes: plan.plan.steps.map((s) => s.actionType),
          availableCapabilities: control.availableCapabilities,
        }),
      );
      if (
        liveCapabilitySetFingerprint !== authorizedCapabilitySetFingerprint
      ) {
        throw new ExecutionError(
          "EXECUTION_CAPABILITY_CHANGED",
          "Live capability authority does not match AuthorizationRecord fingerprint",
          {
            authorized: authorizedCapabilitySetFingerprint,
            live: liveCapabilitySetFingerprint,
          },
        );
      }
      const snapshot = parseExecutionAuthoritySnapshot({
        authoritySnapshotId: this.identities.nextAuthoritySnapshotId(),
        runId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
        authorizationRecordId: authorizationRecord.authorizationRecordId,
        repositoryCommitSha: plan.plan.repositoryCommitSha,
        repositoryFingerprint: plan.plan.repositoryFingerprint,
        policyBundleHash: plan.plan.policyBundleHash,
        authorizedCapabilitySetFingerprint,
        liveCapabilitySetFingerprint,
        capabilitySetFingerprint: authorizedCapabilitySetFingerprint,
        executionMode: control.project.executionMode,
        capturedAt: nowIso,
      });
      this.snapshotsByAttempt.set(attemptId, snapshot);

      const attempt = parseExecutionAttempt({
        executionAttemptId: attemptId,
        runId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
        authorizationRecordId: authorizationRecord.authorizationRecordId,
        attemptNumber: begin.fence.attempt,
        startedAt: nowIso,
        status: "IN_PROGRESS",
        authoritySnapshotId: snapshot.authoritySnapshotId,
      });
      await this.deps.attempts.save(attempt);

      await this.appendEvent(runId, "EXECUTION_STARTED", {
        executionAttemptId: attemptId,
        planHash: plan.planHash,
      });

      const run = await this.deps.runs.getById(runId);
      if (!run) {
        throw new ExecutionError("EXECUTION_NOT_READY", "Run disappeared");
      }
      assertTransition(run.state, "EXECUTING");
      await this.deps.runs.save(
        withRunState(run, "EXECUTING", this.deps.clock.nowIso()),
      );

      const ledger = new ExecutionResourceLedger(
        control.resourceBudget,
        runId,
        attemptId,
      );
      const preconditions = new ExecutionPreconditionService({
        resourceLedger: ledger,
      });

      const compensatingOnly = this.rollback.compensatingOnlyStepIds(plan.plan);
      const order = this.executionOrder(
        compiled.filter((s) => !compensatingOnly.has(s.stepId)),
      );
      const completedByStepId = new Map<string, StepExecutionResult>();
      const stepResults: StepExecutionResult[] = [];
      let failureSummary: string | undefined;
      let containmentRequired = false;
      let failed = false;
      let runContained = false;

      for (const step of order) {
        if (failed || containmentRequired) {
          const skipped = this.skippedResult({
            step,
            runId,
            executionAttemptId: attemptId,
            reason: containmentRequired
              ? "Skipped because execution was contained"
              : "Skipped because a prior dependency failed",
            nowIso: this.deps.clock.nowIso(),
          });
          stepResults.push(skipped);
          continue;
        }

        const depsFailed = step.dependsOn.some((depId) => {
          const dep = completedByStepId.get(depId);
          return !dep || dep.status !== "SUCCEEDED";
        });
        if (depsFailed) {
          const skipped = this.skippedResult({
            step,
            runId,
            executionAttemptId: attemptId,
            reason: "Dependency did not succeed",
            nowIso: this.deps.clock.nowIso(),
          });
          stepResults.push(skipped);
          completedByStepId.set(step.stepId, skipped);
          continue;
        }

        try {
          const capability = this.requireCapability(
            control,
            step.capabilityId,
            step.actionType,
          );
          preconditions.assertBeforeStep({
            plan: plan.plan,
            step,
            completedByStepId,
            workspaceRoot,
            capabilityStillEnabled: capability.enabled,
            repositoryCommitSha: plan.plan.repositoryCommitSha,
            expectedCommitSha: plan.plan.repositoryCommitSha,
          });

          const pipelineResult = await this.runBoundedStepPipeline({
            step,
            runId,
            executionAttemptId: attemptId,
            planId: plan.planId,
            planHash: plan.planHash,
            workspaceRoot,
            artifactRoot,
            control,
            ledger,
            capability,
          });

          if (pipelineResult.kind === "REPLAY") {
            stepResults.push(pipelineResult.result);
            completedByStepId.set(step.stepId, pipelineResult.result);
            continue;
          }

          if (pipelineResult.kind === "UNKNOWN") {
            failed = true;
            containmentRequired = true;
            failureSummary = pipelineResult.message;
            stepResults.push(pipelineResult.result);
            completedByStepId.set(step.stepId, pipelineResult.result);
            await this.appendEvent(runId, "STEP_EXECUTION_FAILED", {
              stepId: step.stepId,
              errorCode: "STEP_EXECUTION_STATE_UNKNOWN",
            });
            runContained = await this.transitionToContained(runId);
            await this.appendEvent(
              runId,
              "EXECUTION_CONTAINED",
              buildContainmentResult({
                runId,
                executionAttemptId: attemptId,
                reasonCode: "STEP_EXECUTION_STATE_UNKNOWN",
                reasonMessage: pipelineResult.message,
                preservedStepIds: stepResults
                  .filter((r) => r.status === "SUCCEEDED")
                  .map((r) => r.stepId),
                preservedArtifactRefs: stepResults.flatMap(
                  (r) => r.outputArtifactRefs,
                ),
                containedAt: this.deps.clock.nowIso(),
              }),
            );
            continue;
          }

          stepResults.push(pipelineResult.result);
          completedByStepId.set(step.stepId, pipelineResult.result);
          await this.appendEvent(runId, "STEP_EXECUTION_SUCCEEDED", {
            stepId: step.stepId,
          });
        } catch (error) {
          failed = true;
          const code = isExecutionError(error)
            ? error.code
            : "STEP_EXECUTION_FAILED";
          failureSummary =
            error instanceof Error ? error.message : "Step execution failed";

          if (code === "STEP_EXECUTION_STATE_UNKNOWN") {
            const existing = await this.deps.steps.getByIdempotencyKey(
              step.idempotencyKey,
            );
            const unknownResult: StepExecutionResult =
              existing ??
              ({
                stepId: step.stepId,
                idempotencyKey: step.idempotencyKey,
                capabilityId: step.capabilityId,
                actionType: step.actionType,
                status: "CONTAINED",
                startedAt: this.deps.clock.nowIso(),
                completedAt: this.deps.clock.nowIso(),
                outputArtifactRefs: [],
                outputHashes: [],
                affectedTargets: [...step.validatedTargets],
                errorCode: code,
                errorMessage: failureSummary,
                executionAttemptId: attemptId,
                runId,
              } satisfies StepExecutionResult);
            stepResults.push(unknownResult);
            completedByStepId.set(step.stepId, unknownResult);
            await this.appendEvent(runId, "STEP_EXECUTION_FAILED", {
              stepId: step.stepId,
              errorCode: code,
            });
            containmentRequired = true;
            runContained = await this.transitionToContained(runId);
            await this.appendEvent(
              runId,
              "EXECUTION_CONTAINED",
              buildContainmentResult({
                runId,
                executionAttemptId: attemptId,
                reasonCode: code,
                reasonMessage: failureSummary,
                preservedStepIds: stepResults
                  .filter((r) => r.status === "SUCCEEDED")
                  .map((r) => r.stepId),
                preservedArtifactRefs: stepResults.flatMap(
                  (r) => r.outputArtifactRefs,
                ),
                containedAt: this.deps.clock.nowIso(),
              }),
            );
            continue;
          }

          const failedResult: StepExecutionResult = {
            stepId: step.stepId,
            idempotencyKey: step.idempotencyKey,
            capabilityId: step.capabilityId,
            actionType: step.actionType,
            status: "FAILED",
            startedAt: this.deps.clock.nowIso(),
            completedAt: this.deps.clock.nowIso(),
            outputArtifactRefs: [],
            outputHashes: [],
            affectedTargets: [...step.validatedTargets],
            errorCode: code,
            errorMessage: failureSummary,
            executionAttemptId: attemptId,
            runId,
          };
          await this.deps.steps.fail(step.idempotencyKey, failedResult);
          stepResults.push(failedResult);
          completedByStepId.set(step.stepId, failedResult);
          await this.appendEvent(runId, "STEP_EXECUTION_FAILED", {
            stepId: step.stepId,
            errorCode: code,
          });

          try {
            await this.executeAuthorizedRollback({
              plan: plan.plan,
              failedStepId: step.stepId,
              runId,
              executionAttemptId: attemptId,
              planId: plan.planId,
              planHash: plan.planHash,
              workspaceRoot,
              artifactRoot,
              control,
              ledger,
              capabilityIdsByAction,
              stepResults,
              expectedCapabilityFingerprint: authorizedCapabilityFingerprint,
            });
          } catch (rollbackError) {
            containmentRequired = true;
            const reasonCode = isExecutionError(rollbackError)
              ? rollbackError.code
              : "ROLLBACK_FAILED";
            const reasonMessage =
              rollbackError instanceof Error
                ? rollbackError.message
                : "Rollback failed";
            failureSummary = `${failureSummary}; ${reasonMessage}`;
            runContained = await this.transitionToContained(runId);
            await this.appendEvent(
              runId,
              "EXECUTION_CONTAINED",
              buildContainmentResult({
                runId,
                executionAttemptId: attemptId,
                reasonCode,
                reasonMessage,
                preservedStepIds: stepResults
                  .filter((r) => r.status === "SUCCEEDED")
                  .map((r) => r.stepId),
                preservedArtifactRefs: stepResults.flatMap(
                  (r) => r.outputArtifactRefs,
                ),
                containedAt: this.deps.clock.nowIso(),
              }),
            );
          }
        }
      }

      const succeeded = stepResults.filter((r) => r.status === "SUCCEEDED");
      const failedSteps = stepResults.filter((r) => r.status === "FAILED");
      let status: ExecutionResult["status"];
      let attemptStatus: "SUCCEEDED" | "FAILED" | "PARTIAL" | "CONTAINED";

      if (containmentRequired) {
        status = "EXECUTION_CONTAINED";
        attemptStatus = "CONTAINED";
      } else if (
        failedSteps.length === 0 &&
        succeeded.length === order.length
      ) {
        status = "EXECUTION_SUCCEEDED";
        attemptStatus = "SUCCEEDED";
      } else if (succeeded.length > 0 && failedSteps.length > 0) {
        status = "EXECUTION_PARTIAL";
        attemptStatus = "PARTIAL";
      } else {
        status = "EXECUTION_FAILED";
        attemptStatus = "FAILED";
      }

      const completedAt = this.deps.clock.nowIso();
      const result = parseExecutionResult({
        executionAttemptId: attemptId,
        runId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
        authorizationRecordId: authorizationRecord.authorizationRecordId,
        status,
        stepResults,
        startedAt: attempt.startedAt,
        completedAt,
        artifactRefs: stepResults.flatMap((r) => r.outputArtifactRefs),
        ...(failureSummary !== undefined ? { failureSummary } : {}),
        containmentRequired,
      });

      await this.deps.attempts.save({
        ...attempt,
        completedAt,
        status: attemptStatus,
      });
      this.resultsByRun.set(runId, result);
      await this.deps.coordinator.storeResult(fenceKey, result);

      if (status === "EXECUTION_CONTAINED") {
        await this.deps.coordinator.markContained(
          fenceKey,
          ownerToken,
          completedAt,
          "EXECUTION_CONTAINED",
        );
        if (!runContained) {
          await this.transitionToContained(runId);
        }
      } else if (
        status === "EXECUTION_FAILED" ||
        status === "EXECUTION_PARTIAL"
      ) {
        await this.deps.coordinator.markFailed(
          fenceKey,
          ownerToken,
          completedAt,
          status,
        );
      } else {
        await this.deps.coordinator.markCompleted(fenceKey, ownerToken, completedAt, {
          executionAttemptId: attemptId,
          resultStatus: status,
        });
      }

      await this.appendEvent(runId, "EXECUTION_FINISHED", {
        status,
        executionAttemptId: attemptId,
      });

      // Normal success remains EXECUTING for Phase 8. Containment uses CONTAINED.
      return result;
    } catch (error) {
      const code = isExecutionError(error) ? error.code : "EXECUTION_FENCE_FAILED";
      await this.deps.coordinator.markFailed(
        fenceKey,
        ownerToken,
        this.deps.clock.nowIso(),
        code,
      );
      throw error;
    }
  }

  async getLatestResult(runId: string): Promise<ExecutionResult | null> {
    return this.resultsByRun.get(runId) ?? null;
  }

  async getLatestAttempt(runId: string) {
    return this.deps.attempts.getLatestByRun(runId);
  }

  async listArtifacts(runId: string) {
    return this.deps.artifacts.listByRun(runId);
  }

  getAuthoritySnapshot(
    executionAttemptId: string,
  ): ExecutionAuthoritySnapshot | null {
    return this.snapshotsByAttempt.get(executionAttemptId) ?? null;
  }

  private executionOrder(
    compiled: CompiledExecutionStep[],
  ): CompiledExecutionStep[] {
    const graph = this.dependencies.validate(
      compiled.map((step) => ({
        stepId: step.stepId,
        actionType: step.actionType,
        description: step.stepId,
        targetIds: step.validatedTargets,
        evidenceRefs: [],
        dependsOn: step.dependsOn,
        preconditions: step.preconditions,
        expectedPostconditions: step.expectedPostconditions,
        resourceEstimate: {},
        risk: { level: "LOW" as const, categories: [] },
        validationChecks: step.verificationRequirements,
        rollbackStrategy: step.rollbackReference.strategy,
      })),
    );
    const byId = new Map(compiled.map((s) => [s.stepId, s]));
    const ordered: CompiledExecutionStep[] = [];
    for (const group of graph.parallelGroups) {
      for (const stepId of group) {
        const step = byId.get(stepId);
        if (step) {
          ordered.push(step);
        }
      }
    }
    return ordered;
  }

  private skippedResult(input: {
    step: CompiledExecutionStep;
    runId: string;
    executionAttemptId: string;
    reason: string;
    nowIso: string;
  }): StepExecutionResult {
    return {
      stepId: input.step.stepId,
      idempotencyKey: input.step.idempotencyKey,
      capabilityId: input.step.capabilityId,
      actionType: input.step.actionType,
      status: "SKIPPED",
      startedAt: input.nowIso,
      completedAt: input.nowIso,
      outputArtifactRefs: [],
      outputHashes: [],
      affectedTargets: [],
      errorCode: "EXECUTION_PRECONDITION_FAILED",
      errorMessage: input.reason,
      executionAttemptId: input.executionAttemptId,
      runId: input.runId,
    };
  }

  private requireCapability(
    control: ProjectControlContext,
    capabilityId: string,
    actionType: string,
  ): Capability {
    const capability = control.availableCapabilities.find(
      (c) => c.capabilityId === capabilityId,
    );
    if (!capability || !capability.enabled) {
      throw new ExecutionError(
        "EXECUTION_CAPABILITY_CHANGED",
        `Capability ${capabilityId} is not available or disabled`,
        { capabilityId, actionType, environment: control.environment },
      );
    }
    if (!capability.allowedActions.includes(actionType)) {
      throw new ExecutionError(
        "EXECUTION_CAPABILITY_CHANGED",
        `Capability ${capabilityId} does not allow ${actionType}`,
        { capabilityId, actionType },
      );
    }
    if (!capability.allowedEnvironments.includes(control.environment)) {
      throw new ExecutionError(
        "EXECUTION_MODE_DENIED",
        `Capability ${capabilityId} is not allowed in environment ${control.environment}`,
        { capabilityId, environmentId: control.environment },
      );
    }
    return capability;
  }

  private async transitionToContained(runId: string): Promise<boolean> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      return false;
    }
    if (run.state === "CONTAINED") {
      return true;
    }
    assertTransition(run.state, "CONTAINED");
    await this.deps.runs.save(
      withRunState(run, "CONTAINED", this.deps.clock.nowIso()),
    );
    return true;
  }

  /**
   * RESERVED → (runtime reserve) → RUNNING → SafeActuator → SUCCEEDED|FAILED.
   * RUNNING must be persisted before actuator invocation.
   */
  private async runBoundedStepPipeline(input: {
    step: CompiledExecutionStep;
    runId: string;
    executionAttemptId: string;
    planId: string;
    planHash: string;
    workspaceRoot: string;
    artifactRoot: string;
    control: ProjectControlContext;
    ledger: ExecutionResourceLedger;
    capability: Capability;
  }): Promise<
    | { kind: "SUCCEEDED"; result: StepExecutionResult }
    | { kind: "REPLAY"; result: StepExecutionResult }
    | { kind: "UNKNOWN"; result: StepExecutionResult; message: string }
  > {
    const { step, ledger, capability } = input;

    let reserved: Awaited<ReturnType<StepExecutionRepository["reserve"]>>;
    try {
      reserved = await this.deps.steps.reserve({
        idempotencyKey: step.idempotencyKey,
        runId: input.runId,
        executionAttemptId: input.executionAttemptId,
        stepId: step.stepId,
        capabilityId: step.capabilityId,
        actionType: step.actionType,
        startedAt: this.deps.clock.nowIso(),
      });
    } catch (error) {
      if (
        isExecutionError(error) &&
        error.code === "STEP_EXECUTION_STATE_UNKNOWN"
      ) {
        const reconciled = await this.tryReconcileRunningStep({
          step,
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
        });
        if (reconciled) {
          return { kind: "REPLAY", result: reconciled };
        }
        const existing = await this.deps.steps.getByIdempotencyKey(
          step.idempotencyKey,
        );
        return {
          kind: "UNKNOWN",
          result:
            existing ??
            ({
              stepId: step.stepId,
              idempotencyKey: step.idempotencyKey,
              capabilityId: step.capabilityId,
              actionType: step.actionType,
              status: "CONTAINED",
              startedAt: this.deps.clock.nowIso(),
              completedAt: this.deps.clock.nowIso(),
              outputArtifactRefs: [],
              outputHashes: [],
              affectedTargets: [...step.validatedTargets],
              errorCode: "STEP_EXECUTION_STATE_UNKNOWN",
              errorMessage: error.message,
              executionAttemptId: input.executionAttemptId,
              runId: input.runId,
            } satisfies StepExecutionResult),
          message: error.message,
        };
      }
      throw error;
    }

    if (reserved.outcome === "REPLAY") {
      return { kind: "REPLAY", result: reserved.result };
    }

    const testProfileTimeoutSeconds =
      step.actionType === "RUN_TESTS"
        ? this.testProfiles.require(
            String(
              (step.normalizedArguments as { testProfileId?: string })
                .testProfileId ?? "",
            ),
          ).timeoutSeconds
        : undefined;

    const timeoutMs = ledger.allowedRuntimeMs({
      capabilityMaximumRuntimeSeconds: capability.maximumRuntimeSeconds,
      ...(testProfileTimeoutSeconds !== undefined
        ? { testProfileTimeoutSeconds }
        : {}),
    });
    if (timeoutMs <= 0) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Insufficient execution time remains to safely start this operation",
        { stepId: step.stepId, timeoutMs },
      );
    }

    ledger.assertDiscreteBudgetAvailable({ stepsExecuted: 1 });
    ledger.reserveDurationMs(timeoutMs);

    await this.appendEvent(input.runId, "STEP_EXECUTION_STARTED", {
      stepId: step.stepId,
      idempotencyKey: step.idempotencyKey,
    });

    // Side-effect boundary: RUNNING before SafeActuator.
    await this.deps.steps.markRunning(step.idempotencyKey);

    const startedMs = Date.now();
    try {
      const actuated = await this.actuateStep({
        step,
        runId: input.runId,
        executionAttemptId: input.executionAttemptId,
        planId: input.planId,
        workspaceRoot: input.workspaceRoot,
        artifactRoot: input.artifactRoot,
        runtime: { timeoutMs },
      });
      const completed = await this.deps.steps.complete(
        step.idempotencyKey,
        actuated,
      );
      const actualMs = Math.max(1, Date.now() - startedMs);
      ledger.settleReservedDuration(timeoutMs, actualMs);
      ledger.recordStep({
        testExecutions: step.actionType === "RUN_TESTS" ? 1 : 0,
        taskCreations: step.actionType === "CREATE_TASK" ? 1 : 0,
        artifactBytes: actuated.outputHashes.length,
        stepsExecuted: 1,
      });
      return { kind: "SUCCEEDED", result: completed };
    } catch (error) {
      ledger.releaseReservation(timeoutMs);
      throw error;
    }
  }

  private async tryReconcileRunningStep(input: {
    step: CompiledExecutionStep;
    runId: string;
    executionAttemptId: string;
  }): Promise<StepExecutionResult | null> {
    if (!this.deps.actuator.reconcileRunningStep) {
      return null;
    }
    const proven = await this.deps.actuator.reconcileRunningStep({
      idempotencyKey: input.step.idempotencyKey,
      stepId: input.step.stepId,
      actionType: input.step.actionType,
      runId: input.runId,
      executionAttemptId: input.executionAttemptId,
    });
    if (!proven) {
      return null;
    }
    return this.deps.steps.reconcileSucceeded(
      input.step.idempotencyKey,
      proven,
    );
  }

  /**
   * Authorized rollback through the full bounded pipeline.
   * Does not invent commands; compensating steps must already be in the plan.
   */
  private async executeAuthorizedRollback(input: {
    plan: ExecutionPlan;
    failedStepId: string;
    runId: string;
    executionAttemptId: string;
    planId: string;
    planHash: string;
    workspaceRoot: string;
    artifactRoot: string;
    control: ProjectControlContext;
    ledger: ExecutionResourceLedger;
    capabilityIdsByAction: Map<string, string>;
    stepResults: StepExecutionResult[];
    expectedCapabilityFingerprint: string;
  }): Promise<void> {
    const rollbackPlan = this.rollback.assertCanRollback(
      input.plan,
      input.failedStepId,
    );
    this.rollback.recordAutomaticRollback();

    await this.appendEvent(input.runId, "ROLLBACK_STARTED", {
      sourceStepId: input.failedStepId,
      compensatingStepIds: rollbackPlan.compensatingStepIds,
      rollbackPlanId: rollbackPlan.rollbackPlanId,
    });

    const run = await this.deps.runs.getById(input.runId);
    if (!run) {
      throw new ExecutionError("ROLLBACK_FAILED", "Run disappeared during rollback");
    }
    // Re-resolve control so capability authority is checked at rollback time
    // against the same fingerprint semantics as preflight.
    const liveControl = await this.deps.controlPlane.resolve(
      run.projectId,
      run.requestedEnvironment,
    );
    const liveCaps = uniqueCapabilitiesForPlanActions({
      stepActionTypes: input.plan.steps.map((s) => s.actionType),
      availableCapabilities: liveControl.availableCapabilities,
    });
    const liveFingerprint = capabilitySetFingerprint(liveCaps);
    if (liveFingerprint !== input.expectedCapabilityFingerprint) {
      throw new ExecutionError(
        "EXECUTION_CAPABILITY_CHANGED",
        "Capability set fingerprint changed at rollback; refusing automatic rollback",
        {
          expected: input.expectedCapabilityFingerprint,
          live: liveFingerprint,
        },
      );
    }

    for (const compensatingStepId of rollbackPlan.compensatingStepIds) {
      const planStep = input.plan.steps.find(
        (s) => s.stepId === compensatingStepId,
      );
      if (!planStep) {
        throw new ExecutionError(
          "ROLLBACK_NOT_AUTHORIZED",
          `Compensating step ${compensatingStepId} missing from approved plan`,
        );
      }

      let compiled: CompiledExecutionStep;
      try {
        compiled = this.dryRun.compileStep(planStep, {
          plan: input.plan,
          workspaceRoot: input.workspaceRoot,
          capabilityIdsByAction: input.capabilityIdsByAction,
        });
      } catch (error) {
        throw new ExecutionError(
          "ROLLBACK_FAILED",
          error instanceof Error
            ? `Rollback compilation failed: ${error.message}`
            : "Rollback compilation failed",
          isExecutionError(error) ? { cause: error.code } : undefined,
        );
      }

      const capability = this.requireCapability(
        liveControl,
        compiled.capabilityId,
        compiled.actionType,
      );

      const rollbackKey = rollbackIdempotencyKey({
        planHash: input.planHash,
        sourceStepId: input.failedStepId,
        rollbackPlanId: rollbackPlan.rollbackPlanId,
        compensatingStepId: compiled.stepId,
        capabilityId: compiled.capabilityId,
        targetFingerprint: fingerprintValue(compiled.validatedTargets),
        argumentFingerprint: fingerprintValue(compiled.normalizedArguments),
      });
      const rollbackCompiled: CompiledExecutionStep = {
        ...compiled,
        idempotencyKey: rollbackKey,
      };

      try {
        const pipelineResult = await this.runBoundedStepPipeline({
          step: rollbackCompiled,
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          planId: input.planId,
          planHash: input.planHash,
          workspaceRoot: input.workspaceRoot,
          artifactRoot: input.artifactRoot,
          control: liveControl,
          ledger: input.ledger,
          capability,
        });

        if (pipelineResult.kind === "UNKNOWN") {
          throw new ExecutionError(
            "STEP_EXECUTION_STATE_UNKNOWN",
            pipelineResult.message,
          );
        }

        if (pipelineResult.kind === "SUCCEEDED" || pipelineResult.kind === "REPLAY") {
          input.stepResults.push(pipelineResult.result);
        }
      } catch (error) {
        if (
          isExecutionError(error) &&
          error.code === "STEP_EXECUTION_STATE_UNKNOWN"
        ) {
          throw error;
        }
        throw new ExecutionError(
          "ROLLBACK_FAILED",
          error instanceof Error
            ? `Rollback actuation failed: ${error.message}`
            : "Rollback actuation failed",
          isExecutionError(error) ? { cause: error.code } : undefined,
        );
      }
    }

    await this.appendEvent(input.runId, "ROLLBACK_COMPLETED", {
      sourceStepId: input.failedStepId,
      rollbackPlanId: rollbackPlan.rollbackPlanId,
    });
  }

  private async actuateStep(input: {
    step: CompiledExecutionStep;
    runId: string;
    executionAttemptId: string;
    planId: string;
    workspaceRoot: string;
    artifactRoot: string;
    runtime: { timeoutMs: number };
  }): Promise<StepExecutionResult> {
    const { step, runtime } = input;
    const nowIso = this.deps.clock.nowIso();
    switch (step.actionType) {
      case "CREATE_LOCAL_PATCH": {
        const args = CreateLocalPatchArgsSchema.parse(step.normalizedArguments);
        const result = await this.deps.actuator.createLocalPatch({
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          workspaceRoot: input.workspaceRoot,
          artifactRoot: input.artifactRoot,
          args,
          nowIso,
          runtime,
        });
        const artifactId = this.identities.nextArtifactId();
        await this.deps.artifacts.save({
          artifactId,
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          artifactType: "PATCH",
          relativePath: result.artifactRelativePath,
          contentHash: result.contentHash,
          size: result.size,
          createdAt: nowIso,
        });
        return {
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          capabilityId: step.capabilityId,
          actionType: step.actionType,
          status: "SUCCEEDED",
          startedAt: nowIso,
          completedAt: this.deps.clock.nowIso(),
          outputArtifactRefs: [artifactId],
          outputHashes: [result.contentHash],
          affectedTargets: [...result.affectedPaths],
          executionAttemptId: input.executionAttemptId,
          runId: input.runId,
        };
      }
      case "RUN_TESTS": {
        const args = RunTestsArgsSchema.parse(step.normalizedArguments);
        const result = await this.deps.actuator.runRegisteredTestProfile({
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          workspaceRoot: input.workspaceRoot,
          artifactRoot: input.artifactRoot,
          args,
          nowIso,
          runtime,
        });
        const refs: string[] = [];
        const hashes: string[] = [];
        if (result.artifactRelativePath && result.contentHash) {
          const artifactId = this.identities.nextArtifactId();
          await this.deps.artifacts.save({
            artifactId,
            runId: input.runId,
            executionAttemptId: input.executionAttemptId,
            stepId: step.stepId,
            artifactType: "TEST_RESULT",
            relativePath: result.artifactRelativePath,
            contentHash: result.contentHash,
            size: result.stdoutSummary.length + result.stderrSummary.length,
            createdAt: nowIso,
          });
          refs.push(artifactId);
          hashes.push(result.contentHash);
        }
        if (result.timedOut) {
          throw new ExecutionError(
            "STEP_EXECUTION_FAILED",
            `Test profile ${args.testProfileId} timed out after ${runtime.timeoutMs}ms`,
            { timedOut: true, timeoutMs: runtime.timeoutMs },
          );
        }
        if (result.exitCode !== 0) {
          throw new ExecutionError(
            "STEP_EXECUTION_FAILED",
            `Test profile ${args.testProfileId} exited with ${result.exitCode}`,
            { exitCode: result.exitCode },
          );
        }
        return {
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          capabilityId: step.capabilityId,
          actionType: step.actionType,
          status: "SUCCEEDED",
          startedAt: nowIso,
          completedAt: this.deps.clock.nowIso(),
          outputArtifactRefs: refs,
          outputHashes: hashes,
          affectedTargets: [args.testProfileId],
          verificationMetadata: {
            exitCode: result.exitCode,
            argv: [...result.argv],
            durationMs: result.durationMs,
            shell: false,
            timeoutMs: runtime.timeoutMs,
          },
          executionAttemptId: input.executionAttemptId,
          runId: input.runId,
        };
      }
      case "CREATE_TASK": {
        const args = CreateTaskArgsSchema.parse(step.normalizedArguments);
        const result = await this.deps.actuator.createLocalTask({
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          planId: input.planId,
          artifactRoot: input.artifactRoot,
          args,
          nowIso,
          runtime,
        });
        const artifactId = this.identities.nextArtifactId();
        await this.deps.artifacts.save({
          artifactId,
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          artifactType: "TASK",
          relativePath: result.artifactRelativePath,
          contentHash: result.contentHash,
          size: result.description.length,
          createdAt: nowIso,
        });
        return {
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          capabilityId: step.capabilityId,
          actionType: step.actionType,
          status: "SUCCEEDED",
          startedAt: nowIso,
          completedAt: this.deps.clock.nowIso(),
          outputArtifactRefs: [artifactId],
          outputHashes: [result.contentHash],
          affectedTargets: [result.taskId],
          executionAttemptId: input.executionAttemptId,
          runId: input.runId,
        };
      }
      case "PREPARE_PULL_REQUEST": {
        const args = PreparePullRequestArgsSchema.parse(
          step.normalizedArguments,
        );
        const result = await this.deps.actuator.preparePullRequestArtifact({
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          artifactRoot: input.artifactRoot,
          args,
          nowIso,
          runtime,
        });
        if (result.githubWritePerformed !== false) {
          throw new ExecutionError(
            "EXECUTION_ARTIFACT_FAILED",
            "PR preparation must not perform GitHub writes",
          );
        }
        const artifactId = this.identities.nextArtifactId();
        await this.deps.artifacts.save({
          artifactId,
          runId: input.runId,
          executionAttemptId: input.executionAttemptId,
          stepId: step.stepId,
          artifactType: "PR_PREPARATION",
          relativePath: result.artifactRelativePath,
          contentHash: result.contentHash,
          size: result.size,
          createdAt: nowIso,
        });
        return {
          stepId: step.stepId,
          idempotencyKey: step.idempotencyKey,
          capabilityId: step.capabilityId,
          actionType: step.actionType,
          status: "SUCCEEDED",
          startedAt: nowIso,
          completedAt: this.deps.clock.nowIso(),
          outputArtifactRefs: [artifactId],
          outputHashes: [result.contentHash],
          affectedTargets: [result.proposedHeadBranchName],
          verificationMetadata: {
            githubWritePerformed: false,
            title: result.title,
            baseBranch: result.baseBranch,
          },
          executionAttemptId: input.executionAttemptId,
          runId: input.runId,
        };
      }
      default: {
        throw new ExecutionError(
          "EXECUTION_UNSUPPORTED_ACTION",
          `Unsupported action ${(step as CompiledExecutionStep).actionType}`,
        );
      }
    }
  }

  private async appendEvent(
    runId: string,
    eventType: string,
    data: unknown,
  ): Promise<void> {
    if (!this.deps.events) {
      return;
    }
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      return;
    }
    const now = this.deps.clock.nowIso();
    await this.deps.events.append({
      eventId: this.identities.nextEventId(),
      eventType,
      eventVersion: "1",
      runId,
      correlationId: run.correlationId,
      causationId: run.runId,
      idempotencyKey: `${eventType}:${runId}:${this.identities.nextEventId()}`,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      objectiveVersion: run.objectiveVersion,
      traceId: run.traceId,
      createdAt: now,
      expiresAt: now,
      schemaVersion: "1",
      data,
    });
  }
}
