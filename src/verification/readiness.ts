import { z } from "zod";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { PlanRepository } from "../planning/plan-repository.js";
import type { AuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import type { ExecutionService } from "../execution/service.js";
import type { ExecutionCoordinator } from "../execution/coordinator.js";
import type { ExecutionFenceKey } from "../execution/coordinator.js";
import type { StepExecutionRepository } from "../execution/step-repository.js";
import type { ExecutionArtifactRepository } from "../execution/artifact-repository.js";
import type { ExecutionAttemptRepository } from "../execution/attempt-repository.js";
import type {
  ExecutionAuthoritySnapshot,
  ExecutionResult,
  StepExecutionResult,
} from "../domain/execution/index.js";

export const VerificationReadinessCodeSchema = z.enum([
  "READY",
  "EXECUTION_NOT_TERMINAL",
  "EXECUTION_RESULT_MISSING",
  "AUTHORITY_SNAPSHOT_MISMATCH",
  "EXECUTION_BINDING_MISMATCH",
  "STEP_STATE_UNKNOWN",
  "ARTIFACT_REFERENCE_MISSING",
  "PLAN_VERIFICATION_REQUIREMENTS_MISSING",
  "RUN_NOT_VERIFIABLE",
  "ATTEMPT_MISSING",
  "AUTHORIZATION_MISSING",
  "PLAN_MISSING",
  "EXECUTION_COORDINATOR_NOT_TERMINAL",
]);

export type VerificationReadinessCode = z.infer<
  typeof VerificationReadinessCodeSchema
>;

export type VerificationReadinessResult =
  | {
      ready: true;
      code: "READY";
      runId: string;
      executionAttemptId: string;
      contained: boolean;
    }
  | {
      ready: false;
      code: Exclude<VerificationReadinessCode, "READY">;
      message: string;
      details?: Readonly<Record<string, unknown>>;
    };

const TERMINAL_STEP_STATUSES = new Set([
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "COMPENSATED",
  "CONTAINED",
]);

export interface VerificationReadinessServiceDeps {
  runs: RunRepository;
  plans: PlanRepository;
  objectives: ObjectiveRepository;
  authorizationRecords: AuthorizationRecordRepository;
  execution: ExecutionService;
  executionCoordinator: ExecutionCoordinator;
  steps: StepExecutionRepository;
  attempts: ExecutionAttemptRepository;
  artifacts: ExecutionArtifactRepository;
}

/**
 * Gates Phase 8 verification. Fail closed when authority or terminal
 * execution evidence is missing.
 */
export class VerificationReadinessService {
  constructor(private readonly deps: VerificationReadinessServiceDeps) {}

  async assess(runId: string): Promise<VerificationReadinessResult> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      return {
        ready: false,
        code: "RUN_NOT_VERIFIABLE",
        message: `Run not found: ${runId}`,
      };
    }

    const contained = run.state === "CONTAINED";
    const verifying = run.state === "VERIFYING";
    if (run.state !== "EXECUTING" && !contained && !verifying) {
      return {
        ready: false,
        code: "RUN_NOT_VERIFIABLE",
        message: `Run state ${run.state} is not verifiable (need EXECUTING, VERIFYING, or CONTAINED)`,
        details: { state: run.state },
      };
    }

    const result = await this.deps.execution.getLatestResult(runId);
    if (!result) {
      return {
        ready: false,
        code: "EXECUTION_RESULT_MISSING",
        message: "Terminal ExecutionResult is missing",
      };
    }

    const attempt = await this.deps.attempts.getLatestByRun(runId);
    if (!attempt) {
      return {
        ready: false,
        code: "ATTEMPT_MISSING",
        message: "ExecutionAttempt is missing",
      };
    }
    if (attempt.executionAttemptId !== result.executionAttemptId) {
      return {
        ready: false,
        code: "EXECUTION_BINDING_MISMATCH",
        message: "ExecutionAttempt does not match ExecutionResult",
        details: {
          attemptId: attempt.executionAttemptId,
          resultAttemptId: result.executionAttemptId,
        },
      };
    }

    const planRecord = await this.deps.plans.getByRunId(runId);
    if (!planRecord) {
      return {
        ready: false,
        code: "PLAN_MISSING",
        message: "Exact plan is missing",
      };
    }
    const plan = planRecord.plan;

    if (
      result.planId !== plan.planId ||
      result.planVersion !== plan.planVersion ||
      result.planHash !== plan.planHash ||
      result.runId !== runId
    ) {
      return {
        ready: false,
        code: "EXECUTION_BINDING_MISMATCH",
        message: "ExecutionResult does not bind to exact plan/run",
        details: {
          resultPlanId: result.planId,
          planId: plan.planId,
          resultHash: result.planHash,
          planHash: plan.planHash,
        },
      };
    }

    const auth = await this.deps.authorizationRecords.getLatestByRun(runId);
    if (!auth) {
      return {
        ready: false,
        code: "AUTHORIZATION_MISSING",
        message: "AuthorizationRecord is missing",
      };
    }
    if (auth.authorizationRecordId !== result.authorizationRecordId) {
      return {
        ready: false,
        code: "EXECUTION_BINDING_MISMATCH",
        message: "AuthorizationRecord does not match ExecutionResult",
      };
    }
    if (
      auth.planId !== plan.planId ||
      auth.planVersion !== plan.planVersion ||
      auth.planHash !== plan.planHash
    ) {
      return {
        ready: false,
        code: "EXECUTION_BINDING_MISMATCH",
        message: "AuthorizationRecord plan binding mismatch",
      };
    }

    const snapshot = await this.deps.execution.getAuthoritySnapshot(
      result.executionAttemptId,
    );
    if (!snapshot) {
      return {
        ready: false,
        code: "AUTHORITY_SNAPSHOT_MISMATCH",
        message: "ExecutionAuthoritySnapshot is missing",
      };
    }
    const snapshotCheck = this.checkAuthoritySnapshot(snapshot, auth, result);
    if (snapshotCheck) {
      return snapshotCheck;
    }

    const fenceKey: ExecutionFenceKey = {
      runId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      authorizationRecordId: auth.authorizationRecordId,
    };
    const fence = await this.deps.executionCoordinator.get(fenceKey);
    if (
      !fence ||
      (fence.status !== "COMPLETED" &&
        fence.status !== "CONTAINED" &&
        fence.status !== "FAILED")
    ) {
      return {
        ready: false,
        code: "EXECUTION_COORDINATOR_NOT_TERMINAL",
        message: "Execution coordinator is not terminal",
        details: { status: fence?.status },
      };
    }

    const steps = await this.deps.steps.listByExecutionAttempt(
      result.executionAttemptId,
    );
    const stepState = this.checkStepStates(steps, result);
    if (stepState) {
      return stepState;
    }

    const artifactCheck = await this.checkArtifacts(result);
    if (artifactCheck) {
      return artifactCheck;
    }

    for (const step of plan.steps) {
      if (!step.validation.checks || step.validation.checks.length === 0) {
        return {
          ready: false,
          code: "PLAN_VERIFICATION_REQUIREMENTS_MISSING",
          message: `Step ${step.stepId} lacks verification requirements`,
          details: { stepId: step.stepId },
        };
      }
    }

    const objective = await this.deps.objectives.getById(
      run.objectiveId,
      run.objectiveVersion,
    );
    if (!objective || objective.acceptanceCriteria.length === 0) {
      return {
        ready: false,
        code: "PLAN_VERIFICATION_REQUIREMENTS_MISSING",
        message: "Objective acceptance criteria missing",
      };
    }

    if (
      result.status === "EXECUTION_CONTAINED" ||
      result.containmentRequired ||
      contained
    ) {
      // Contained path: may record verification but not COMPLETE.
      return {
        ready: true,
        code: "READY",
        runId,
        executionAttemptId: result.executionAttemptId,
        contained: true,
      };
    }

    return {
      ready: true,
      code: "READY",
      runId,
      executionAttemptId: result.executionAttemptId,
      contained: false,
    };
  }

  private checkAuthoritySnapshot(
    snapshot: ExecutionAuthoritySnapshot,
    auth: {
      authorizationRecordId: string;
      capabilitySetFingerprint: string;
      planId: string;
      planVersion: number;
      planHash: string;
      repositoryFingerprint: string;
      policyBundleHash: string;
    },
    result: ExecutionResult,
  ): VerificationReadinessResult | null {
    if (snapshot.authorizationRecordId !== auth.authorizationRecordId) {
      return {
        ready: false,
        code: "AUTHORITY_SNAPSHOT_MISMATCH",
        message: "Authority snapshot authorizationRecordId mismatch",
      };
    }
    if (
      snapshot.authorizedCapabilitySetFingerprint !==
        auth.capabilitySetFingerprint ||
      snapshot.liveCapabilitySetFingerprint !==
        auth.capabilitySetFingerprint ||
      snapshot.capabilitySetFingerprint !== auth.capabilitySetFingerprint
    ) {
      return {
        ready: false,
        code: "AUTHORITY_SNAPSHOT_MISMATCH",
        message:
          "Historical capability fingerprints do not match AuthorizationRecord",
      };
    }
    if (
      snapshot.planId !== result.planId ||
      snapshot.planVersion !== result.planVersion ||
      snapshot.planHash !== result.planHash
    ) {
      return {
        ready: false,
        code: "AUTHORITY_SNAPSHOT_MISMATCH",
        message: "Authority snapshot plan binding mismatch",
      };
    }
    if (
      snapshot.repositoryFingerprint !== auth.repositoryFingerprint ||
      snapshot.policyBundleHash !== auth.policyBundleHash
    ) {
      return {
        ready: false,
        code: "AUTHORITY_SNAPSHOT_MISMATCH",
        message: "Authority snapshot repository/policy binding mismatch",
      };
    }
    return null;
  }

  private checkStepStates(
    steps: readonly StepExecutionResult[],
    result: ExecutionResult,
  ): VerificationReadinessResult | null {
    for (const step of steps) {
      if (step.status === "RUNNING" || step.status === "RESERVED") {
        return {
          ready: false,
          code: "STEP_STATE_UNKNOWN",
          message: `Step ${step.stepId} is not in a terminal state (${step.status})`,
          details: { stepId: step.stepId, status: step.status },
        };
      }
      if (!TERMINAL_STEP_STATUSES.has(step.status)) {
        return {
          ready: false,
          code: "STEP_STATE_UNKNOWN",
          message: `Step ${step.stepId} has unknown status ${step.status}`,
        };
      }
    }
    for (const step of result.stepResults) {
      if (step.status === "RUNNING") {
        return {
          ready: false,
          code: "STEP_STATE_UNKNOWN",
          message: `Result step ${step.stepId} still RUNNING`,
        };
      }
    }
    return null;
  }

  private async checkArtifacts(
    result: ExecutionResult,
  ): Promise<VerificationReadinessResult | null> {
    const refs = new Set<string>([
      ...result.artifactRefs,
      ...result.stepResults.flatMap((s) => s.outputArtifactRefs),
    ]);
    for (const ref of refs) {
      const artifact = await this.deps.artifacts.getById(ref);
      if (!artifact) {
        return {
          ready: false,
          code: "ARTIFACT_REFERENCE_MISSING",
          message: `Referenced artifact missing: ${ref}`,
          details: { artifactId: ref },
        };
      }
    }
    return null;
  }
}
