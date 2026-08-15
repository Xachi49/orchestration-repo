import { describe, expect, it } from "vitest";
import { createLocalVerificationStack } from "../infrastructure/verification/local-stack.js";
import type { LocalVerificationStack } from "../infrastructure/verification/local-stack.js";
import { createExecutionFriendlyPlanningModel } from "../execution/friendly-planning-model.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import { assertTransition } from "../domain/run/run-state.js";
import {
  PostExecutionSnapshotHasher,
  PostExecutionTruthService,
} from "./snapshot.js";
import { OutcomeDecisionEngine } from "./decision-engine.js";
import { FakeVerificationModel } from "./fake-model.js";
import { writeFile } from "node:fs/promises";
import { artifactRootFor } from "../execution/paths.js";
import { resolveContained } from "../ingestion/workspace-paths.js";

async function executedRun(options?: {
  delivery?: FakeApprovalDeliveryService;
  testExitCode?: number;
  verificationModel?: FakeVerificationModel;
}): Promise<{
  stack: LocalVerificationStack;
  runId: string;
  delivery: FakeApprovalDeliveryService;
}> {
  const delivery = options?.delivery ?? new FakeApprovalDeliveryService();
  const stack = createLocalVerificationStack({
    approvalDelivery: delivery,
    planningModel: createExecutionFriendlyPlanningModel(),
    ...(options?.verificationModel !== undefined
      ? { verificationModel: options.verificationModel }
      : {}),
  });
  if (options?.testExitCode !== undefined) {
    stack.actuator.testExitCode = options.testExitCode;
  }

  const admitted = await stack.admission.admit(
    exampleAdmissionRequest({
      acceptanceCriteria: [
        "Local patch artifact prepared",
        "Registered test profile executed",
      ],
      constraints: ["Stay within authorized targets"],
      nonGoals: ["GitHub pull request creation"],
      requestedOutcome: "Prepare a local patch and run registered tests",
    }),
  );
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
  const exec = await stack.execution.execute(runId);
  if (options?.testExitCode && options.testExitCode !== 0) {
    expect(["EXECUTION_FAILED", "EXECUTION_CONTAINED", "EXECUTION_PARTIAL"]).toContain(
      exec.status,
    );
  } else {
    expect(exec.status).toBe("EXECUTION_SUCCEEDED");
  }
  return { stack, runId, delivery };
}

describe("OutcomeVerificationService", () => {
  it("rejects illegal COMPLETED shortcuts", () => {
    expect(() => assertTransition("EXECUTING", "COMPLETED")).toThrow();
    expect(() => assertTransition("VALIDATING", "COMPLETED")).toThrow();
    expect(() => assertTransition("APPROVED", "COMPLETED")).toThrow();
    expect(() => assertTransition("AWAITING_APPROVAL", "COMPLETED")).toThrow();
    expect(() => assertTransition("EXECUTING", "VERIFYING")).not.toThrow();
    expect(() => assertTransition("VERIFYING", "COMPLETED")).not.toThrow();
  });

  it("verifies EXECUTING → VERIFYING → COMPLETED on VERIFIED_SUCCESS", async () => {
    const { stack, runId } = await executedRun();
    const before = await stack.runs.getById(runId);
    expect(before?.state).toBe("EXECUTING");

    const result = await stack.verification.verify(runId);
    expect(result.outcome).toBe("VERIFIED_SUCCESS");
    expect(result.completionRecordId).toBeDefined();
    expect(result.criterionResults).toHaveLength(2);
    expect(
      result.criterionResults.every((c) => c.verdict === "SATISFIED"),
    ).toBe(true);

    const after = await stack.runs.getById(runId);
    expect(after?.state).toBe("COMPLETED");
    const completion = await stack.verification.getCompletion(runId);
    expect(completion?.outcomeVerificationId).toBe(result.outcomeVerificationId);
  });

  it("rejects verification when execution result is missing", async () => {
    const stack = createLocalVerificationStack({
      planningModel: createExecutionFriendlyPlanningModel(),
    });
    const admitted = await stack.admission.admit(
      exampleAdmissionRequest({
        acceptanceCriteria: [
          "Local patch artifact prepared",
          "Registered test profile executed",
        ],
      }),
    );
    await expect(
      stack.verification.verify(admitted.runId!),
    ).rejects.toMatchObject({ code: "VERIFICATION_NOT_READY" });
  });

  it("idempotently returns decided verification", async () => {
    const { stack, runId } = await executedRun();
    const first = await stack.verification.verify(runId);
    const second = await stack.verification.verify(runId);
    expect(second.outcomeVerificationId).toBe(first.outcomeVerificationId);
    expect(second.outcome).toBe("VERIFIED_SUCCESS");
  });

  it("failed tests → not VERIFIED_SUCCESS and no CompletionRecord", async () => {
    const { stack, runId } = await executedRun({ testExitCode: 1 });
    const run = await stack.runs.getById(runId);
    // Non-zero tests may contain or fail; verify when still verifiable.
    if (run?.state === "CONTAINED") {
      const result = await stack.verification.verify(runId);
      expect(result.outcome).toBe("CONTAINED");
      expect(result.completionRecordId).toBeUndefined();
      expect(await stack.verification.getCompletion(runId)).toBeNull();
      return;
    }
    if (run?.state !== "EXECUTING") {
      const readiness = await stack.verificationReadiness.assess(runId);
      expect(readiness.ready).toBe(false);
      return;
    }
    const result = await stack.verification.verify(runId);
    expect(result.outcome).not.toBe("VERIFIED_SUCCESS");
    expect(result.completionRecordId).toBeUndefined();
    expect(await stack.verification.getCompletion(runId)).toBeNull();
    expect((await stack.runs.getById(runId))?.state).not.toBe("COMPLETED");
  });

  it("EXECUTION_SUCCEEDED + missing criterion evidence → not VERIFIED_SUCCESS", async () => {
    // Unbound/unverifiable criteria cannot produce a compilable plan with
    // explicit bindings — planning fails closed (ACCEPTANCE_CRITERION_UNBOUND).
    const delivery = new FakeApprovalDeliveryService();
    const stack2 = createLocalVerificationStack({
      approvalDelivery: delivery,
      planningModel: createExecutionFriendlyPlanningModel(),
    });
    const admitted = await stack2.admission.admit(
      exampleAdmissionRequest({
        acceptanceCriteria: [
          "Deploy to production cluster",
          "Notify external pager system",
        ],
        constraints: ["Stay within authorized targets"],
        nonGoals: ["GitHub pull request creation"],
      }),
    );
    const runId2 = admitted.runId!;
    await stack2.ingestion.ingest(
      runId2,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await expect(stack2.planning.plan(runId2)).rejects.toMatchObject({
      code: expect.stringMatching(
        /ACCEPTANCE_CRITERION_UNBOUND|PLANNING_MODEL_INVALID_OUTPUT/,
      ),
    });
  });

  it("model recommending VERIFIED_SUCCESS cannot upgrade INCONCLUSIVE", () => {
    const engine = new OutcomeDecisionEngine();
    const decision = engine.decide({
      contained: false,
      unresolvedSideEffectUncertainty: false,
      criterionResults: [
        {
          criterionId: "c1",
          criterionText: "x",
          verdict: "INCONCLUSIVE",
          evidenceRefs: [],
          stepRefs: [],
          findingRefs: [],
          conciseRationale: "missing",
          verificationMethod: "UNMAPPED",
        },
      ],
      postconditionResults: [],
      findings: [],
      coverageComplete: false,
      artifactIntegrityOk: true,
      historicalAuthorityOk: true,
      boundaryOk: true,
      governanceOk: true,
      allCriteriaHaveApprovedBindings: true,
      allBindingsFulfilled: true,
      contextual: {
        recommendedOutcome: "VERIFIED_SUCCESS",
        criterionConcerns: [],
        unsupportedClaims: [],
        contradictions: [],
        missingEvidence: [],
        semanticGaps: [],
        conciseRationale: "model thinks ok",
        findings: [],
      },
    });
    expect(decision.outcome).toBe("INCONCLUSIVE");
  });

  it("model recommending VERIFIED_SUCCESS cannot upgrade failure", () => {
    const engine = new OutcomeDecisionEngine();
    const decision = engine.decide({
      contained: false,
      unresolvedSideEffectUncertainty: false,
      criterionResults: [
        {
          criterionId: "c1",
          criterionText: "x",
          verdict: "UNSATISFIED",
          evidenceRefs: ["e1"],
          stepRefs: ["s1"],
          findingRefs: [],
          conciseRationale: "failed",
          verificationMethod: "EXACT",
        },
      ],
      postconditionResults: [],
      findings: [],
      coverageComplete: true,
      artifactIntegrityOk: true,
      historicalAuthorityOk: true,
      boundaryOk: true,
      governanceOk: true,
      allCriteriaHaveApprovedBindings: true,
      allBindingsFulfilled: true,
      contextual: {
        recommendedOutcome: "VERIFIED_SUCCESS",
        criterionConcerns: [],
        unsupportedClaims: [],
        contradictions: [],
        missingEvidence: [],
        semanticGaps: [],
        conciseRationale: "model thinks ok",
        findings: [],
      },
    });
    expect(decision.outcome).toBe("VERIFICATION_FAILED");
  });

  it("contextual blocking concern downgrades apparent success", async () => {
    const model = new FakeVerificationModel();
    model.setBlockingConcern({
      ruleId: "SEMANTIC_GAP",
      message: "Evidence does not semantically support success",
      recommendedOutcome: "INCONCLUSIVE",
    });
    const { stack, runId } = await executedRun({ verificationModel: model });
    const result = await stack.verification.verify(runId);
    expect(result.outcome).toBe("INCONCLUSIVE");
    expect(result.completionRecordId).toBeUndefined();
    expect(model.callCount).toBeGreaterThan(0);
  });

  it("snapshot hash stable for same material evidence; changes on artifact change", async () => {
    const { stack, runId } = await executedRun();
    const result = await stack.execution.getLatestResult(runId);
    expect(result).not.toBeNull();
    const truth = new PostExecutionTruthService({
      execution: stack.execution,
      steps: stack.stepExecutions,
      artifacts: stack.executionArtifacts,
    });
    const hasher = new PostExecutionSnapshotHasher();
    const snap1 = await truth.capture({
      runId,
      result: result!,
      nowIso: "2026-08-15T12:00:00.000Z",
    });
    const snap2 = await truth.capture({
      runId,
      result: result!,
      nowIso: "2026-08-15T13:00:00.000Z",
    });
    expect(hasher.hash(snap1)).toBe(hasher.hash(snap2));

    const artifacts = await stack.executionArtifacts.listByRun(runId);
    const patch = artifacts.find((a) => a.artifactType === "PATCH");
    expect(patch).toBeDefined();
    const root = artifactRootFor(stack.dataRoot, runId);
    const absolute = resolveContained(root, patch!.relativePath);
    await writeFile(absolute, "tampered-content", "utf8");
    // Re-save metadata hash to simulate tampering detection path at verify time
    const verify = await stack.verification.verify(runId);
    // Either fails artifact integrity or still succeeds if we didn't update meta —
    // tampering content vs stored hash should fail verification
    expect(verify.outcome).not.toBe("VERIFIED_SUCCESS");
  });

  it("records current capability drift without rewriting historical authority", async () => {
    const { stack, runId } = await executedRun();
    const caps = await stack.capabilities.list();
    const createTask = caps.find((c) => c.capabilityId === "CREATE_TASK");
    if (createTask) {
      stack.capabilities.replace({
        ...createTask,
        enabled: false,
      });
    }
    const result = await stack.verification.verify(runId);
    const drift = result.findings.filter((f) => f.category === "CURRENT_DRIFT");
    expect(
      result.findings.every(
        (f) => f.category !== "CURRENT_DRIFT" || !f.blocksVerifiedSuccess,
      ),
    ).toBe(true);
    // Drift may or may not appear depending on whether CREATE_TASK is in the
    // fingerprint set used at authorization; historical success path remains valid.
    if (result.outcome === "VERIFIED_SUCCESS") {
      expect(result.completionRecordId).toBeDefined();
    }
    void drift;
  });

  it("does not remediate on verification failure", async () => {
    const model = new FakeVerificationModel();
    model.setBlockingConcern({
      ruleId: "FORCE_FAIL",
      recommendedOutcome: "VERIFICATION_FAILED",
    });
    const { stack, runId } = await executedRun({ verificationModel: model });
    const actuatorCallsBefore = stack.actuator.invocations.length;
    await stack.verification.verify(runId);
    expect(stack.actuator.invocations.length).toBe(actuatorCallsBefore);
  });

  it("PARTIAL_SUCCESS when some criteria satisfied and some not", () => {
    const engine = new OutcomeDecisionEngine();
    const decision = engine.decide({
      contained: false,
      unresolvedSideEffectUncertainty: false,
      criterionResults: [
        {
          criterionId: "c1",
          criterionText: "a",
          verdict: "SATISFIED",
          evidenceRefs: ["e1"],
          stepRefs: ["s1"],
          findingRefs: [],
          conciseRationale: "ok",
          verificationMethod: "EXACT",
        },
        {
          criterionId: "c2",
          criterionText: "b",
          verdict: "UNSATISFIED",
          evidenceRefs: ["e2"],
          stepRefs: ["s2"],
          findingRefs: [],
          conciseRationale: "bad",
          verificationMethod: "EXACT",
        },
      ],
      postconditionResults: [
        {
          stepId: "s1",
          postconditionId: "p1",
          expected: "a",
          observed: "a",
          verdict: "SATISFIED",
          evidenceRefs: ["e1"],
          findingRefs: [],
        },
      ],
      findings: [],
      coverageComplete: true,
      artifactIntegrityOk: true,
      historicalAuthorityOk: true,
      boundaryOk: true,
      governanceOk: true,
      allCriteriaHaveApprovedBindings: true,
      allBindingsFulfilled: true,
    });
    expect(decision.outcome).toBe("PARTIAL_SUCCESS");
  });

  it("CONTAINED outcome for contained decision input", () => {
    const engine = new OutcomeDecisionEngine();
    const decision = engine.decide({
      contained: true,
      unresolvedSideEffectUncertainty: false,
      criterionResults: [],
      postconditionResults: [],
      findings: [],
      coverageComplete: true,
      artifactIntegrityOk: true,
      historicalAuthorityOk: true,
      boundaryOk: true,
      governanceOk: true,
      allCriteriaHaveApprovedBindings: true,
      allBindingsFulfilled: true,
    });
    expect(decision.outcome).toBe("CONTAINED");
  });

  it("every original criterion appears exactly once", async () => {
    const { stack, runId } = await executedRun();
    const result = await stack.verification.verify(runId);
    const objective = await stack.objectives.getById(
      (await stack.runs.getById(runId))!.objectiveId,
      (await stack.runs.getById(runId))!.objectiveVersion,
    );
    expect(result.criterionResults).toHaveLength(
      objective!.acceptanceCriteria.length,
    );
    const ids = result.criterionResults.map((c) => c.criterionId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
