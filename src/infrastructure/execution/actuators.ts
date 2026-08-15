import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ActuatorRuntimeBounds,
  LocalPatchActuatorResult,
  LocalTaskActuatorResult,
  PullRequestPreparationResult,
  RegisteredTestActuatorResult,
  SafeActuator,
} from "../../execution/actuator.js";
import type {
  CreateLocalPatchArgs,
  CreateTaskArgs,
  PreparePullRequestArgs,
  RunTestsArgs,
} from "../../execution/action-schemas.js";
import { TestProfileRegistry } from "../../execution/test-profiles.js";
import { ExecutionTargetValidator } from "../../execution/target-validator.js";
import { resolveContained } from "../../ingestion/workspace-paths.js";
import { ExecutionError } from "../../execution/errors.js";
import type { StepExecutionResult } from "../../domain/execution/index.js";

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Deterministic fake actuator for local/unit tests.
 * Records invocations; does not spawn processes or write GitHub.
 * Enforces timeoutMs by failing closed when simulateTimeout is set or
 * when timeoutMs is non-positive.
 */
export class FakeSafeActuator implements SafeActuator {
  readonly invocations: Array<{ method: string; input: unknown }> = [];
  /** Proven completions keyed by idempotencyKey for crash reconciliation tests. */
  readonly provenByIdempotencyKey = new Map<string, StepExecutionResult>();
  testExitCode = 0;
  failNextPatch = false;
  simulateTimeout = false;
  /** When true, next actuation throws STEP_EXECUTION_STATE_UNKNOWN (uncertain side effect). */
  simulateStateUnknown = false;

  constructor(private readonly testProfiles = new TestProfileRegistry()) {}

  private assertRuntime(runtime: ActuatorRuntimeBounds): void {
    if (runtime.timeoutMs <= 0) {
      throw new ExecutionError(
        "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
        "Actuator refused to start: timeoutMs must be positive",
        { timeoutMs: runtime.timeoutMs },
      );
    }
    if (this.simulateTimeout) {
      this.simulateTimeout = false;
      throw new ExecutionError(
        "STEP_EXECUTION_FAILED",
        `Actuator operation timed out after ${runtime.timeoutMs}ms`,
        { timedOut: true, timeoutMs: runtime.timeoutMs },
      );
    }
    if (this.simulateStateUnknown) {
      this.simulateStateUnknown = false;
      throw new ExecutionError(
        "STEP_EXECUTION_STATE_UNKNOWN",
        "Actuator side-effect state is uncertain; refusing blind retry",
        { timedOut: false },
      );
    }
  }

  async createLocalPatch(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    workspaceRoot: string;
    artifactRoot: string;
    args: CreateLocalPatchArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<LocalPatchActuatorResult> {
    this.invocations.push({ method: "createLocalPatch", input });
    this.assertRuntime(input.runtime);
    if (this.failNextPatch) {
      this.failNextPatch = false;
      throw new Error("Fake patch actuator failure");
    }
    const validator = new ExecutionTargetValidator();
    const affected = validator.validateTargets(
      input.workspaceRoot,
      input.args.targetPaths,
    );
    const relativePath = path.posix.join("patches", `${input.stepId}.patch`);
    const absolute = resolveContained(input.artifactRoot, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const body = [
      `# Phase 7 local patch artifact`,
      `# step=${input.stepId}`,
      `# run=${input.runId}`,
      input.args.patchContent,
    ].join("\n");
    await writeFile(absolute, body, "utf8");
    return {
      artifactRelativePath: relativePath,
      contentHash: hashContent(body),
      size: Buffer.byteLength(body, "utf8"),
      affectedPaths: affected,
    };
  }

  async runRegisteredTestProfile(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    workspaceRoot: string;
    artifactRoot: string;
    args: RunTestsArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<RegisteredTestActuatorResult> {
    this.invocations.push({ method: "runRegisteredTestProfile", input });
    this.assertRuntime(input.runtime);
    const profile = this.testProfiles.require(input.args.testProfileId);
    const relativePath = path.posix.join(
      "tests",
      `${input.stepId}-${input.args.testProfileId}.json`,
    );
    const absolute = resolveContained(input.artifactRoot, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const payload = {
      testProfileId: profile.testProfileId,
      argv: profile.argv,
      shell: false as const,
      exitCode: this.testExitCode,
      stdoutSummary: `fake ${profile.testProfileId} ok`,
      stderrSummary: "",
      durationMs: 1,
      timeoutMs: input.runtime.timeoutMs,
    };
    const body = JSON.stringify(payload);
    await writeFile(absolute, body, "utf8");
    return {
      testProfileId: profile.testProfileId,
      argv: profile.argv,
      exitCode: this.testExitCode,
      stdoutSummary: payload.stdoutSummary,
      stderrSummary: "",
      durationMs: 1,
      timedOut: false,
      artifactRelativePath: relativePath,
      contentHash: hashContent(body),
    };
  }

  async createLocalTask(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    planId: string;
    artifactRoot: string;
    args: CreateTaskArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<LocalTaskActuatorResult> {
    this.invocations.push({ method: "createLocalTask", input });
    this.assertRuntime(input.runtime);
    const taskId = `task_${input.stepId}`;
    const relativePath = path.posix.join("tasks", `${taskId}.json`);
    const absolute = resolveContained(input.artifactRoot, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const body = JSON.stringify({
      taskId,
      title: input.args.title,
      description: input.args.description,
      sourcePlanId: input.planId,
      sourceStepId: input.stepId,
      status: "CREATED",
      createdAt: input.nowIso,
    });
    await writeFile(absolute, body, "utf8");
    return {
      taskId,
      title: input.args.title,
      description: input.args.description,
      status: "CREATED",
      artifactRelativePath: relativePath,
      contentHash: hashContent(body),
    };
  }

  async preparePullRequestArtifact(input: {
    runId: string;
    executionAttemptId: string;
    stepId: string;
    artifactRoot: string;
    args: PreparePullRequestArgs;
    nowIso: string;
    runtime: ActuatorRuntimeBounds;
  }): Promise<PullRequestPreparationResult> {
    this.invocations.push({ method: "preparePullRequestArtifact", input });
    this.assertRuntime(input.runtime);
    const relativePath = path.posix.join(
      "pull-requests",
      `${input.stepId}.json`,
    );
    const absolute = resolveContained(input.artifactRoot, relativePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    const body = JSON.stringify({
      title: input.args.title,
      body: input.args.body,
      baseBranch: input.args.baseBranch,
      proposedHeadBranchName: input.args.proposedHeadBranchName,
      associatedPatchReferences: input.args.associatedPatchReferences ?? [],
      githubWritePerformed: false,
      createdAt: input.nowIso,
    });
    await writeFile(absolute, body, "utf8");
    return {
      artifactRelativePath: relativePath,
      contentHash: hashContent(body),
      size: Buffer.byteLength(body, "utf8"),
      title: input.args.title,
      baseBranch: input.args.baseBranch,
      proposedHeadBranchName: input.args.proposedHeadBranchName,
      githubWritePerformed: false,
    };
  }

  async reconcileRunningStep(input: {
    idempotencyKey: string;
    stepId: string;
    actionType: string;
    runId: string;
    executionAttemptId: string;
  }): Promise<StepExecutionResult | null> {
    return this.provenByIdempotencyKey.get(input.idempotencyKey) ?? null;
  }
}

/** Local patch actuator — thin alias over FakeSafeActuator for stack wiring. */
export class LocalPatchActuator {
  constructor(private readonly inner: FakeSafeActuator) {}
  createLocalPatch(
    input: Parameters<SafeActuator["createLocalPatch"]>[0],
  ): ReturnType<SafeActuator["createLocalPatch"]> {
    return this.inner.createLocalPatch(input);
  }
}

export class RegisteredTestActuator {
  constructor(private readonly inner: FakeSafeActuator) {}
  runRegisteredTestProfile(
    input: Parameters<SafeActuator["runRegisteredTestProfile"]>[0],
  ): ReturnType<SafeActuator["runRegisteredTestProfile"]> {
    return this.inner.runRegisteredTestProfile(input);
  }
}

export class LocalTaskActuator {
  constructor(private readonly inner: FakeSafeActuator) {}
  createLocalTask(
    input: Parameters<SafeActuator["createLocalTask"]>[0],
  ): ReturnType<SafeActuator["createLocalTask"]> {
    return this.inner.createLocalTask(input);
  }
}

export class PullRequestPreparationActuator {
  constructor(private readonly inner: FakeSafeActuator) {}
  preparePullRequestArtifact(
    input: Parameters<SafeActuator["preparePullRequestArtifact"]>[0],
  ): ReturnType<SafeActuator["preparePullRequestArtifact"]> {
    return this.inner.preparePullRequestArtifact(input);
  }
}
