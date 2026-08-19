import { describe, expect, it } from "vitest";
import { createLocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import { createExecutionFriendlyPlanningModel } from "./friendly-planning-model.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_BUDGET,
} from "../control-plane/fixtures.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import { assertTransition } from "../domain/run/run-state.js";
import { DryRunCompiler } from "./dry-run.js";
import { TestProfileRegistry } from "./test-profiles.js";
import { stepIdempotencyKey, fingerprintValue, rollbackIdempotencyKey } from "./idempotency.js";
import { InMemoryStepExecutionRepository } from "./step-repository.js";
import { ExecutionTargetValidator } from "./target-validator.js";
import { ExecutionResourceLedger } from "./resource-ledger.js";
import { RollbackService } from "./rollback.js";
import { capabilitySetFingerprint } from "./capability-fingerprint.js";
import { MAX_AUTOMATIC_ROLLBACKS } from "../domain/execution/index.js";
import { ControlPlaneService } from "../control-plane/service.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { FixedClock } from "../infrastructure/clock.js";
import { ExecutionReadinessService } from "./readiness.js";
import type { LocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import type { ExecutionPlan } from "../domain/plan/execution-plan.js";

async function approvedRun(options?: {
  delivery?: FakeApprovalDeliveryService;
}): Promise<{ stack: LocalExecutionStack; runId: string; delivery: FakeApprovalDeliveryService }> {
  const delivery = options?.delivery ?? new FakeApprovalDeliveryService();
  const stack = createLocalExecutionStack({
    approvalDelivery: delivery,
    planningModel: createExecutionFriendlyPlanningModel(),
  });
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const runId = admitted.runId;
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  const routed = await stack.authorizationRouting.route(runId);
  if (routed.outcome !== "PENDING_APPROVAL") {
    throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
  }
  const nonce = delivery.nonceFor(routed.approvalRequestId);
  if (!nonce) {
    throw new Error("missing nonce");
  }
  await stack.humanAuthorization.decide({
    approvalRequestId: routed.approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    submittedAt: stack.clock.nowIso(),
    decisionNonce: nonce,
  });
  const run = await stack.runs.getById(runId);
  expect(run?.state).toBe("APPROVED");
  return { stack, runId, delivery };
}

describe("ExecutionService", () => {
  it("executes APPROVED → EXECUTING and never COMPLETED", async () => {
    const { stack, runId } = await approvedRun();
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_SUCCEEDED");
    expect(result.stepResults.every((s) => s.status === "SUCCEEDED")).toBe(
      true,
    );
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("EXECUTING");
    expect(run?.state).not.toBe("COMPLETED");
    expect(() => assertTransition("APPROVED", "EXECUTING")).not.toThrow();
    expect(() => assertTransition("VALIDATING", "EXECUTING")).toThrow();
    expect(() => assertTransition("AWAITING_APPROVAL", "EXECUTING")).toThrow();
  });

  it("denies execution when run is not APPROVED", async () => {
    const stack = createLocalExecutionStack({
      planningModel: createExecutionFriendlyPlanningModel(),
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    await expect(stack.execution.execute(runId)).rejects.toMatchObject({
      code: "EXECUTION_NOT_READY",
    });
  });

  it("denies PLAN_ONLY execution mode", async () => {
    const clock = new FixedClock("2026-08-14T12:00:00.000Z");
    const controlPlane = new ControlPlaneService({
      projects: new InMemoryProjectRegistry([
        { ...EXAMPLE_PROJECT, executionMode: "PLAN_ONLY" },
      ]),
      capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
      policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
      budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
      clock,
    });
    const { stack, runId } = await approvedRun();
    const readiness = new ExecutionReadinessService({
      runs: stack.runs,
      plans: stack.plans,
      objectives: stack.objectives,
      controlPlane,
      locks: stack.locks,
      authorizationRecords: stack.authorizationRecords,
      approvalRequests: stack.approvalRequests,
      clockNowIso: () => clock.nowIso(),
    });
    const assessed = await readiness.assess(runId);
    expect(assessed.ready).toBe(false);
    if (!assessed.ready) {
      expect(assessed.code).toBe("EXECUTION_MODE_DENIED");
    }
  });

  it("dry-run rejects unsupported READ_FILE from default planner", async () => {
    const stack = createLocalExecutionStack();
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    const plan = await stack.plans.getByRunId(runId);
    const compiler = new DryRunCompiler(new TestProfileRegistry());
    expect(() =>
      compiler.compile({
        plan: plan!.plan,
        workspaceRoot: "/tmp/ws",
        capabilityIdsByAction: new Map([
          ["READ_FILE", "READ_FILE"],
          ["CREATE_LOCAL_PATCH", "CREATE_LOCAL_PATCH"],
          ["RUN_TESTS", "RUN_TESTS"],
        ]),
      }),
    ).toThrow(/not supported in Phase 7/);
  });

  it("dry-run rejects absolute paths, shell strings, and unregistered profiles", async () => {
    const compiler = new DryRunCompiler(new TestProfileRegistry());
    const basePlan = {
      planId: "p1",
      planVersion: 1,
      objectiveId: "o1",
      objectiveVersion: 1,
      repositoryCommitSha: "a".repeat(40),
      repositoryFingerprint: "fp",
      policyBundleId: "pol",
      policyBundleHash: "ph",
      schemaVersion: "1",
      assumptions: [],
      unknowns: [],
      successDefinition: ["ok"],
      resourceTotals: {},
      criticalPath: ["s1"],
      workstreams: [{ workstreamId: "w", name: "w", stepIds: ["s1"] }],
      approvalRequirements: [],
      failurePolicy: { onStepFailure: "FAIL_RUN" as const, maxRetries: 0 },
      planHash: "hash",
    };

    const absolute = {
      ...basePlan,
      steps: [
        {
          stepId: "s1",
          actionType: "CREATE_LOCAL_PATCH",
          description: "patch",
          targetIds: ["/etc/passwd"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW" as const, categories: [] },
          validation: { checks: ["c"] },
          rollback: { strategy: "NONE" as const },
          idempotencyKey: "k",
        },
      ],
    } as ExecutionPlan;
    expect(() =>
      compiler.compile({
        plan: absolute,
        workspaceRoot: "/tmp/ws",
        capabilityIdsByAction: new Map([["CREATE_LOCAL_PATCH", "CREATE_LOCAL_PATCH"]]),
      }),
    ).toThrow();

    const shell = {
      ...basePlan,
      steps: [
        {
          stepId: "s1",
          actionType: "CREATE_LOCAL_PATCH",
          description: "run bash -c 'rm -rf /'",
          targetIds: ["src/a.ts"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW" as const, categories: [] },
          validation: { checks: ["c"] },
          rollback: { strategy: "NONE" as const },
          idempotencyKey: "k",
        },
      ],
    } as ExecutionPlan;
    expect(() =>
      compiler.compile({
        plan: shell,
        workspaceRoot: "/tmp/ws",
        capabilityIdsByAction: new Map([["CREATE_LOCAL_PATCH", "CREATE_LOCAL_PATCH"]]),
      }),
    ).toThrow();

    const badProfile = {
      ...basePlan,
      steps: [
        {
          stepId: "s1",
          actionType: "RUN_TESTS",
          description: "tests",
          targetIds: ["ARBITRARY_SHELL"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW" as const, categories: [] },
          validation: { checks: ["c"] },
          rollback: { strategy: "NONE" as const },
          idempotencyKey: "k",
        },
      ],
    } as ExecutionPlan;
    expect(() =>
      compiler.compile({
        plan: badProfile,
        workspaceRoot: "/tmp/ws",
        capabilityIdsByAction: new Map([["RUN_TESTS", "RUN_TESTS"]]),
      }),
    ).toThrow(/Unregistered test profile/);
  });

  it("idempotency: RESERVED is safe; RUNNING is uncertain; SUCCEEDED replays", async () => {
    const repo = new InMemoryStepExecutionRepository();
    const key = stepIdempotencyKey({
      planHash: "ph",
      stepId: "s1",
      capabilityId: "CREATE_LOCAL_PATCH",
      targetFingerprint: fingerprintValue(["a.ts"]),
      argumentFingerprint: fingerprintValue({ x: 1 }),
    });
    const key2 = stepIdempotencyKey({
      planHash: "ph",
      stepId: "s1",
      capabilityId: "CREATE_LOCAL_PATCH",
      targetFingerprint: fingerprintValue(["a.ts"]),
      argumentFingerprint: fingerprintValue({ x: 2 }),
    });
    expect(key).not.toBe(key2);

    const reserved = await repo.reserve({
      idempotencyKey: key,
      runId: "r1",
      executionAttemptId: "a1",
      stepId: "s1",
      capabilityId: "CREATE_LOCAL_PATCH",
      actionType: "CREATE_LOCAL_PATCH",
      startedAt: "2026-08-14T12:00:00.000Z",
    });
    expect(reserved.outcome).toBe("RESERVED");
    expect(reserved.result.status).toBe("RESERVED");

    const reservedAgain = await repo.reserve({
      idempotencyKey: key,
      runId: "r1",
      executionAttemptId: "a1",
      stepId: "s1",
      capabilityId: "CREATE_LOCAL_PATCH",
      actionType: "CREATE_LOCAL_PATCH",
      startedAt: "2026-08-14T12:00:00.000Z",
    });
    expect(reservedAgain.outcome).toBe("RESERVED");

    await repo.markRunning(key);
    await expect(
      repo.reserve({
        idempotencyKey: key,
        runId: "r1",
        executionAttemptId: "a1",
        stepId: "s1",
        capabilityId: "CREATE_LOCAL_PATCH",
        actionType: "CREATE_LOCAL_PATCH",
        startedAt: "2026-08-14T12:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "STEP_EXECUTION_STATE_UNKNOWN" });

    await repo.complete(key, {
      ...reserved.result,
      status: "SUCCEEDED",
      completedAt: "2026-08-14T12:00:01.000Z",
      outputArtifactRefs: ["art1"],
      outputHashes: ["h1"],
      affectedTargets: ["a.ts"],
    });

    const replay = await repo.reserve({
      idempotencyKey: key,
      runId: "r1",
      executionAttemptId: "a1",
      stepId: "s1",
      capabilityId: "CREATE_LOCAL_PATCH",
      actionType: "CREATE_LOCAL_PATCH",
      startedAt: "2026-08-14T12:00:02.000Z",
    });
    expect(replay.outcome).toBe("REPLAY");
    expect(replay.result.outputArtifactRefs).toEqual(["art1"]);
  });

  it("creates patch artifacts under run artifact root without git push", async () => {
    const { stack, runId } = await approvedRun();
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_SUCCEEDED");
    const artifacts = await stack.execution.listArtifacts(runId);
    expect(artifacts.some((a) => a.artifactType === "PATCH")).toBe(true);
    expect(artifacts.every((a) => !a.relativePath.includes(".."))).toBe(true);
    expect(
      stack.actuator.invocations.some((i) => i.method === "createLocalPatch"),
    ).toBe(true);
    expect(
      stack.actuator.invocations.some((i) =>
        JSON.stringify(i).includes("git push"),
      ),
    ).toBe(false);
  });

  it("maps registered test profiles to trusted argv with shell:false", async () => {
    const { stack, runId } = await approvedRun();
    await stack.execution.execute(runId);
    const testCall = stack.actuator.invocations.find(
      (i) => i.method === "runRegisteredTestProfile",
    );
    expect(testCall).toBeDefined();
    const profile = stack.testProfiles.require("UNIT_TESTS");
    expect(profile.shell).toBe(false);
    expect(profile.argv).toEqual(["npm", "test"]);
  });

  it("PR preparation creates local artifact only (no GitHub write)", async () => {
    const stack = createLocalExecutionStack();
    const pr = await stack.actuator.preparePullRequestArtifact({
      runId: "run_x",
      executionAttemptId: "att_1",
      stepId: "step_pr",
      artifactRoot: stack.dataRoot + "/runs/run_x/artifacts",
      args: {
        title: "Test PR",
        body: "body",
        baseBranch: "main",
        proposedHeadBranchName: "orchestrator/step_pr",
      },
      nowIso: stack.clock.nowIso(),
      runtime: { timeoutMs: 60_000 },
    });
    expect(pr.githubWritePerformed).toBe(false);
    expect(pr.artifactRelativePath).toContain("pull-requests");
  });

  it("failure stops dependents and preserves completed results", async () => {
    const { stack, runId } = await approvedRun();
    stack.actuator.failNextPatch = true;
    const result = await stack.execution.execute(runId);
    expect(["EXECUTION_FAILED", "EXECUTION_PARTIAL", "EXECUTION_CONTAINED"]).toContain(
      result.status,
    );
    const patch = result.stepResults.find((s) => s.stepId === "step_patch");
    const test = result.stepResults.find((s) => s.stepId === "step_test");
    expect(patch?.status).toBe("FAILED");
    expect(test?.status).toBe("SKIPPED");
  });

  it("rejects protected paths and allows max one automatic rollback", async () => {
    const validator = new ExecutionTargetValidator();
    expect(() => validator.assertNotProtected(".env")).toThrow(
      /protected/i,
    );
    expect(() => validator.assertNotProtected(".git/config")).toThrow(
      /protected/i,
    );
    expect(() => validator.assertNotProtected("src/ok.ts")).not.toThrow();

    const rollback = new RollbackService();
    expect(MAX_AUTOMATIC_ROLLBACKS).toBe(1);
    const plan = {
      steps: [
        {
          stepId: "s1",
          rollback: {
            strategy: "COMPENSATING_ACTION" as const,
            compensatingStepIds: ["s2"],
          },
        },
        {
          stepId: "s2",
          rollback: { strategy: "NONE" as const },
        },
      ],
    } as ExecutionPlan;
    rollback.assertCanRollback(plan, "s1");
    rollback.recordAutomaticRollback();
    expect(() => rollback.assertCanRollback(plan, "s1")).toThrow(
      /Automatic rollback limit/,
    );
  });

  it("replays completed fence result on second execute", async () => {
    const { stack, runId } = await approvedRun();
    const first = await stack.execution.execute(runId);
    const second = await stack.execution.execute(runId);
    expect(second.executionAttemptId).toBe(first.executionAttemptId);
    expect(second.status).toBe(first.status);
    expect((await stack.runs.getById(runId))?.state).toBe("EXECUTING");
  });

  it("normal success leaves run EXECUTING (not COMPLETED or VERIFIED)", async () => {
    const { stack, runId } = await approvedRun();
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_SUCCEEDED");
    expect((await stack.runs.getById(runId))?.state).toBe("EXECUTING");
    expect(result.status).not.toBe("VERIFIED_SUCCESS" as never);
  });

  it("uncertain side effect contains the run without blind retry", async () => {
    const { stack, runId } = await approvedRun();
    stack.actuator.simulateStateUnknown = true;
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_CONTAINED");
    expect(result.containmentRequired).toBe(true);
    expect((await stack.runs.getById(runId))?.state).toBe("CONTAINED");
    const second = await stack.execution.execute(runId);
    expect(second.executionAttemptId).toBe(result.executionAttemptId);
    expect(
      stack.actuator.invocations.filter((i) => i.method === "createLocalPatch")
        .length,
    ).toBe(1);
  });

  it("authorized rollback runs through bounded pipeline and stays EXECUTING", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel({
        withAuthorizedRollback: true,
      }),
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    const nonce = delivery.nonceFor(routed.approvalRequestId!);
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId!,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce!,
    });

    stack.actuator.failNextPatch = true;
    const result = await stack.execution.execute(runId);
    expect(result.containmentRequired).toBe(false);
    expect(
      stack.actuator.invocations.some((i) => i.method === "createLocalTask"),
    ).toBe(true);
    expect(
      result.stepResults.some((s) => s.stepId === "step_discard"),
    ).toBe(true);
    expect((await stack.runs.getById(runId))?.state).toBe("EXECUTING");
  });

  it("rollback-time re-resolution observes Control Plane capability authority", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel({
        withAuthorizedRollback: true,
      }),
      capabilities: EXAMPLE_CAPABILITIES.map((c) =>
        c.capabilityId === "CREATE_TASK"
          ? { ...c, maximumRuntimeSeconds: 7 }
          : c,
      ),
    });
    expect(stack.capabilities).toBe(stack.controlPlane.capabilityRegistry());

    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
    }
    const nonce = delivery.nonceFor(routed.approvalRequestId);
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce!,
    });

    stack.actuator.failNextPatch = true;
    const result = await stack.execution.execute(runId);
    expect(result.containmentRequired).toBe(false);
    const taskCall = stack.actuator.invocations.find(
      (i) => i.method === "createLocalTask",
    );
    expect(taskCall).toBeDefined();
    expect(
      (taskCall?.input as { runtime: { timeoutMs: number } }).runtime.timeoutMs,
    ).toBe(7_000);
    expect((await stack.runs.getById(runId))?.state).toBe("EXECUTING");
  });

  it("post-approval capability drift on shared registry yields EXECUTION_CAPABILITY_CHANGED", async () => {
    const { stack, runId } = await approvedRun();
    const auth = await stack.authorizationRecords.getLatestByRun(runId);
    expect(auth?.capabilitySetFingerprint).toBeTruthy();
    const frozen = auth!.capabilitySetFingerprint;

    const patch = await stack.capabilities.getById("CREATE_LOCAL_PATCH");
    stack.capabilities.replace({
      ...patch!,
      maximumRuntimeSeconds: patch!.maximumRuntimeSeconds + 100,
    });

    await expect(stack.execution.execute(runId)).rejects.toMatchObject({
      code: "EXECUTION_CAPABILITY_CHANGED",
    });
    expect(auth!.capabilitySetFingerprint).toBe(frozen);
  });

  it("runtime ceiling increase 30→600 after APPROVE fails execution readiness", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel(),
      capabilities: EXAMPLE_CAPABILITIES.map((c) =>
        c.capabilityId === "CREATE_LOCAL_PATCH"
          ? { ...c, maximumRuntimeSeconds: 30 }
          : c,
      ),
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
    }
    const nonce = delivery.nonceFor(routed.approvalRequestId);
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce!,
    });
    const patch = await stack.capabilities.getById("CREATE_LOCAL_PATCH");
    stack.capabilities.replace({ ...patch!, maximumRuntimeSeconds: 600 });
    await expect(stack.execution.execute(runId)).rejects.toMatchObject({
      code: "EXECUTION_CAPABILITY_CHANGED",
    });
  });

  it("runtime ceiling decrease 600→30 after APPROVE also fails execution readiness", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel(),
      capabilities: EXAMPLE_CAPABILITIES.map((c) =>
        c.capabilityId === "CREATE_LOCAL_PATCH"
          ? { ...c, maximumRuntimeSeconds: 600 }
          : c,
      ),
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
    }
    const nonce = delivery.nonceFor(routed.approvalRequestId);
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce!,
    });
    const patch = await stack.capabilities.getById("CREATE_LOCAL_PATCH");
    stack.capabilities.replace({ ...patch!, maximumRuntimeSeconds: 30 });
    await expect(stack.execution.execute(runId)).rejects.toMatchObject({
      code: "EXECUTION_CAPABILITY_CHANGED",
    });
  });

  it("exact frozen fingerprint matching live permits execution readiness", async () => {
    const { stack, runId } = await approvedRun();
    const auth = await stack.authorizationRecords.getLatestByRun(runId);
    const ready = await stack.executionReadiness.requireReady(runId);
    expect(ready.capabilitySetFingerprint).toBe(auth!.capabilitySetFingerprint);
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_SUCCEEDED");
    const snap = await stack.execution.getAuthoritySnapshot(result.executionAttemptId);
    expect(snap?.authorizedCapabilitySetFingerprint).toBe(
      auth!.capabilitySetFingerprint,
    );
    expect(snap?.liveCapabilitySetFingerprint).toBe(
      auth!.capabilitySetFingerprint,
    );
    expect(snap?.capabilitySetFingerprint).toBe(auth!.capabilitySetFingerprint);
  });

  it("rollback cannot proceed under a changed capability fingerprint", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel({
        withAuthorizedRollback: true,
      }),
    });
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
    }
    const nonce = delivery.nonceFor(routed.approvalRequestId);
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce!,
    });

    stack.actuator.createLocalPatch = async () => {
      const task = await stack.capabilities.getById("CREATE_TASK");
      stack.capabilities.replace({
        ...task!,
        maximumRuntimeSeconds: task!.maximumRuntimeSeconds + 100,
      });
      throw new Error("Forced primary failure after capability drift");
    };

    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_CONTAINED");
    expect(result.failureSummary).toMatch(/fingerprint changed at rollback/i);
    expect(
      stack.actuator.invocations.some((i) => i.method === "createLocalTask"),
    ).toBe(false);
    expect((await stack.runs.getById(runId))?.state).toBe("CONTAINED");
  });

  it("invalid rollback target and arguments are rejected at compile", () => {
    const compiler = new DryRunCompiler(new TestProfileRegistry());
    const base = {
      planId: "p1",
      planVersion: 1,
      objectiveId: "o1",
      objectiveVersion: 1,
      repositoryCommitSha: "a".repeat(40),
      repositoryFingerprint: "fp",
      policyBundleId: "pol",
      policyBundleHash: "ph",
      schemaVersion: "1",
      assumptions: [],
      unknowns: [],
      successDefinition: ["ok"],
      resourceTotals: {},
      criticalPath: ["s1"],
      workstreams: [{ workstreamId: "w", name: "w", stepIds: ["s1"] }],
      approvalRequirements: [],
      failurePolicy: { onStepFailure: "FAIL_RUN" as const, maxRetries: 0 },
      planHash: "hash",
    };

    const badTarget = {
      ...base,
      steps: [
        {
          stepId: "s1",
          actionType: "CREATE_LOCAL_PATCH",
          description: "patch",
          targetIds: ["src/a.ts"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW" as const, categories: [] },
          validation: { checks: ["c"] },
          rollback: {
            strategy: "COMPENSATING_ACTION" as const,
            compensatingStepIds: ["s_rb"],
          },
          idempotencyKey: "k",
        },
        {
          stepId: "s_rb",
          actionType: "CREATE_LOCAL_PATCH",
          description: "bad rollback",
          targetIds: [".env"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW" as const, categories: [] },
          validation: { checks: ["c"] },
          rollback: { strategy: "NONE" as const },
          idempotencyKey: "k2",
        },
      ],
    } as ExecutionPlan;

    expect(() =>
      compiler.compileStep(badTarget.steps[1]!, {
        plan: badTarget,
        workspaceRoot: "/tmp/ws",
        capabilityIdsByAction: new Map([
          ["CREATE_LOCAL_PATCH", "CREATE_LOCAL_PATCH"],
        ]),
      }),
    ).toThrow(/protected/i);

    const badArgs = {
      ...base,
      steps: [
        {
          stepId: "s_rb",
          actionType: "RUN_TESTS",
          description: "bad profile",
          targetIds: ["NOT_A_PROFILE"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW" as const, categories: [] },
          validation: { checks: ["c"] },
          rollback: { strategy: "NONE" as const },
          idempotencyKey: "k",
        },
      ],
    } as ExecutionPlan;
    expect(() =>
      compiler.compileStep(badArgs.steps[0]!, {
        plan: badArgs,
        workspaceRoot: "/tmp/ws",
        capabilityIdsByAction: new Map([["RUN_TESTS", "RUN_TESTS"]]),
      }),
    ).toThrow(/Unregistered test profile/);
  });

  it("same successful rollback cannot execute twice; second autonomous rollback rejected", async () => {
    const repo = new InMemoryStepExecutionRepository();
    const key = rollbackIdempotencyKey({
      planHash: "ph",
      sourceStepId: "s1",
      rollbackPlanId: "rollback_s1",
      compensatingStepId: "s2",
      capabilityId: "CREATE_TASK",
      targetFingerprint: fingerprintValue([]),
      argumentFingerprint: fingerprintValue({ title: "t" }),
    });
    const reserved = await repo.reserve({
      idempotencyKey: key,
      runId: "r1",
      executionAttemptId: "a1",
      stepId: "s2",
      capabilityId: "CREATE_TASK",
      actionType: "CREATE_TASK",
      startedAt: "2026-08-14T12:00:00.000Z",
    });
    await repo.markRunning(key);
    await repo.complete(key, {
      ...reserved.result,
      status: "SUCCEEDED",
      completedAt: "2026-08-14T12:00:01.000Z",
      outputArtifactRefs: ["t1"],
      outputHashes: ["h1"],
      affectedTargets: ["task_1"],
    });
    const replay = await repo.reserve({
      idempotencyKey: key,
      runId: "r1",
      executionAttemptId: "a1",
      stepId: "s2",
      capabilityId: "CREATE_TASK",
      actionType: "CREATE_TASK",
      startedAt: "2026-08-14T12:00:02.000Z",
    });
    expect(replay.outcome).toBe("REPLAY");

    const rollback = new RollbackService();
    const plan = {
      steps: [
        {
          stepId: "s1",
          rollback: {
            strategy: "COMPENSATING_ACTION" as const,
            compensatingStepIds: ["s2"],
          },
        },
        { stepId: "s2", rollback: { strategy: "NONE" as const } },
      ],
    } as ExecutionPlan;
    rollback.assertCanRollback(plan, "s1");
    rollback.recordAutomaticRollback();
    expect(() => rollback.assertCanRollback(plan, "s1")).toThrow(
      /Automatic rollback limit/,
    );
  });

  it("rollback failure contains the run and prevents further automatic steps", async () => {
    const { stack, runId } = await approvedRun();
    stack.actuator.failNextPatch = true;
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_CONTAINED");
    expect((await stack.runs.getById(runId))?.state).toBe("CONTAINED");
    const test = result.stepResults.find((s) => s.stepId === "step_test");
    expect(test?.status).toBe("SKIPPED");
    const second = await stack.execution.execute(runId);
    expect(second.status).toBe("EXECUTION_CONTAINED");
  });

  it("capability runtime bound is enforced on actuator calls", async () => {
    const { stack, runId } = await approvedRun();
    await stack.execution.execute(runId);
    for (const inv of stack.actuator.invocations) {
      const runtime = (inv.input as { runtime?: { timeoutMs: number } })
        .runtime;
      expect(runtime?.timeoutMs).toBeGreaterThan(0);
      expect(runtime?.timeoutMs).toBeLessThanOrEqual(600_000);
    }
    const patch = stack.actuator.invocations.find(
      (i) => i.method === "createLocalPatch",
    );
    expect(
      (patch?.input as { runtime: { timeoutMs: number } }).runtime.timeoutMs,
    ).toBeLessThanOrEqual(120_000);
  });

  it("capability maximumRuntimeSeconds from local-stack construction is enforced", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel(),
      capabilities: EXAMPLE_CAPABILITIES.map((c) =>
        c.capabilityId === "CREATE_LOCAL_PATCH"
          ? { ...c, maximumRuntimeSeconds: 0 }
          : c,
      ),
    });
    expect(stack.capabilities).toBe(stack.controlPlane.capabilityRegistry());
    const resolved = await stack.controlPlane.resolve(
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    expect(
      resolved.availableCapabilities.find(
        (c) => c.capabilityId === "CREATE_LOCAL_PATCH",
      )?.maximumRuntimeSeconds,
    ).toBe(0);

    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
    }
    const nonce = delivery.nonceFor(routed.approvalRequestId);
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce!,
    });

    const ready = await stack.executionReadiness.requireReady(runId);
    const relevant = resolved.availableCapabilities.filter((c) =>
      ["CREATE_LOCAL_PATCH", "RUN_TESTS"].some((a) =>
        c.allowedActions.includes(a),
      ),
    );
    expect(ready.capabilitySetFingerprint).toBe(
      capabilitySetFingerprint(relevant),
    );

    const result = await stack.execution.execute(runId);
    expect(
      result.stepResults.some(
        (s) => s.errorCode === "EXECUTION_RESOURCE_BUDGET_EXCEEDED",
      ),
    ).toBe(true);
    expect(stack.actuator.invocations.length).toBe(0);
  });

  it("validation and execution share one Control Plane capability registry", async () => {
    const custom = EXAMPLE_CAPABILITIES.map((c) =>
      c.capabilityId === "RUN_TESTS"
        ? { ...c, maximumRuntimeSeconds: 42 }
        : c,
    );
    const stack = createLocalExecutionStack({
      planningModel: createExecutionFriendlyPlanningModel(),
      capabilities: custom,
    });
    expect(stack.capabilities).toBe(stack.controlPlane.capabilityRegistry());
    const fromRegistry = await stack.capabilities.getById("RUN_TESTS");
    const fromResolve = (
      await stack.controlPlane.resolve(EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT)
    ).availableCapabilities.find((c) => c.capabilityId === "RUN_TESTS");
    expect(fromRegistry?.maximumRuntimeSeconds).toBe(42);
    expect(fromResolve?.maximumRuntimeSeconds).toBe(42);
    expect(fromResolve?.maximumRuntimeSeconds).toBe(
      fromRegistry?.maximumRuntimeSeconds,
    );
  });

  it("remaining execution-time ceiling can prevent starting a step", async () => {
    const ledger = new ExecutionResourceLedger(
      { ...EXAMPLE_BUDGET, maximumExecutionMinutes: 1 },
      "run_x",
      "att_x",
    );
    await ledger.recordStep({ durationMs: 60_000 });
    expect(ledger.remainingExecutionMs()).toBe(0);
    expect(
      ledger.allowedRuntimeMs({ capabilityMaximumRuntimeSeconds: 120 }),
    ).toBe(0);
    await expect(ledger.reserveDurationMs(1)).rejects.toThrow(
      /Insufficient execution time/,
    );
  });

  it("timed-out test operation fails structured and does not blind re-execute", async () => {
    const { stack, runId } = await approvedRun();
    stack.actuator.simulateTimeout = true;
    // Timeout is on first actuator call (patch); use fail path on tests via profile.
    // Force timeout on the test step instead: succeed patch, timeout tests.
    stack.actuator.simulateTimeout = false;
    const result1 = await stack.execution.execute(runId);
    // Re-run is fence replay; to test timeout on RUN_TESTS, use a fresh run.
    expect(result1.status).toBe("EXECUTION_SUCCEEDED");

    const delivery = new FakeApprovalDeliveryService();
    const stack2 = createLocalExecutionStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel(),
    });
    const admitted = await stack2.admission.admit(exampleAdmissionRequest());
    const runId2 = admitted.runId!;
    await stack2.ingestion.ingest(
      runId2,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await stack2.planning.plan(runId2);
    await stack2.validation.validate(runId2);
    const routed = await stack2.authorizationRouting.route(runId2);
    const nonce = delivery.nonceFor(routed.approvalRequestId!);
    await stack2.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId!,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack2.clock.nowIso(),
      decisionNonce: nonce!,
    });
    // Delay timeout until after patch: failNextPatch unused; set simulateTimeout
    // after patch by wrapping — FakeSafeActuator clears flag on first use.
    // Use a custom sequence: first call (patch) ok, second (tests) times out.
    const original = stack2.actuator.createLocalPatch.bind(stack2.actuator);
    stack2.actuator.createLocalPatch = async (input) => {
      const out = await original(input);
      stack2.actuator.simulateTimeout = true;
      return out;
    };
    const result = await stack2.execution.execute(runId2);
    const test = result.stepResults.find((s) => s.stepId === "step_test");
    expect(test?.status).toBe("FAILED");
    expect(test?.errorMessage).toMatch(/timed out/i);
    expect(
      stack2.actuator.invocations.filter(
        (i) => i.method === "runRegisteredTestProfile",
      ).length,
    ).toBe(1);
  });
});
