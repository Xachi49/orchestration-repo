import { describe, expect, it } from "vitest";
import { createLocalPlanningStack } from "../infrastructure/planning/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { EXAMPLE_ENVIRONMENT, EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";
import { EXAMPLE_COMMIT_SHA, EXAMPLE_DRIFT_SHA } from "../ingestion/fixtures.js";

async function admitAndIngest() {
  const stack = createLocalPlanningStack();
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  await stack.ingestion.ingest(
    admitted.runId,
    EXAMPLE_PROJECT_ID,
    EXAMPLE_ENVIRONMENT,
  );
  return { stack, runId: admitted.runId };
}

describe("PlanningReadinessService", () => {
  it("is ready for INGESTING + VERIFIED context + VERIFIED live lock", async () => {
    const { stack, runId } = await admitAndIngest();
    const result = await stack.readiness.assess(runId);
    expect(result).toEqual({ ready: true, code: "READY" });
  });

  it("denies STALE live locks", async () => {
    const { stack, runId } = await admitAndIngest();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });
    const result = await stack.readiness.assess(runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("REPOSITORY_DRIFTED");
    }
  });

  it("denies INVALID live locks", async () => {
    const { stack, runId } = await admitAndIngest();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "INVALID" });
    const result = await stack.readiness.assess(runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("REPOSITORY_STATE_NOT_VERIFIED");
    }
  });

  it("denies missing context", async () => {
    const stack = createLocalPlanningStack();
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    const run = await stack.runs.getById(admitted.runId);
    await stack.runs.save({ ...run!, state: "INGESTING" });
    const result = await stack.readiness.assess(admitted.runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("CONTEXT_NOT_VERIFIED");
    }
  });

  it("denies non-INGESTING runs", async () => {
    const { stack, runId } = await admitAndIngest();
    const run = await stack.runs.getById(runId);
    await stack.runs.save({ ...run!, state: "ADMITTED" });
    const result = await stack.readiness.assess(runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("RUN_NOT_INGESTING");
    }
  });
});

describe("PlanningService", () => {
  it("plans successfully and transitions INGESTING → PLANNING → VALIDATING", async () => {
    const { stack, runId } = await admitAndIngest();
    const result = await stack.planning.plan(runId);
    expect(result.outcome).toBe("PLANNED");
    expect(result.status).toBe("READY_FOR_VALIDATION");
    expect(result.planVersion).toBe(1);
    expect(result.runState).toBe("VALIDATING");
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("VALIDATING");
    const plan = await stack.plans.getByRunId(runId);
    expect(plan?.plan.repositoryCommitSha).toBe(EXAMPLE_COMMIT_SHA);
    expect(plan?.plan.planHash).toBe(result.planHash);
    expect((stack.planningModel as { callCount: number }).callCount).toBeGreaterThan(
      0,
    );
  });

  it("reuses a completed plan without another model call", async () => {
    const { stack, runId } = await admitAndIngest();
    const first = await stack.planning.plan(runId);
    const callsAfterFirst = (stack.planningModel as { callCount: number }).callCount;
    const second = await stack.planning.plan(runId);
    expect(second.planId).toBe(first.planId);
    expect(second.planHash).toBe(first.planHash);
    expect((stack.planningModel as { callCount: number }).callCount).toBe(
      callsAfterFirst,
    );
  });

  it("rejects concurrent planning with PLANNING_IN_PROGRESS", async () => {
    const { stack, runId } = await admitAndIngest();
    await stack.planningCoordinator.begin(runId, stack.clock.nowIso());
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLANNING_IN_PROGRESS",
    });
  });

  it("allows explicit retry after FAILED and increments attempt", async () => {
    const { stack, runId } = await admitAndIngest();
    const model = stack.planningModel as {
      failNextCall: (error: Error) => void;
      callCount: number;
    };
    model.failNextCall(new Error("simulated model failure"));
    await expect(stack.planning.plan(runId)).rejects.toBeTruthy();
    const failed = await stack.planningCoordinator.get(runId);
    expect(failed?.status).toBe("FAILED");
    expect(failed?.attempt).toBe(1);
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("PLANNING");
    expect(await stack.plans.getByRunId(runId)).toBeNull();

    const result = await stack.planning.plan(runId);
    expect(result.status).toBe("READY_FOR_VALIDATION");
    const fence = await stack.planningCoordinator.get(runId);
    expect(fence?.status).toBe("PLANNED");
    expect(fence?.attempt).toBe(2);
  });

  it("reconciles after crash when plan exists but fence lagged", async () => {
    const { stack, runId } = await admitAndIngest();
    const result = await stack.planning.plan(runId);
    const fences = (
      stack.planningCoordinator as unknown as {
        byRun: Map<string, { status: string; attempt: number; runId: string; lastUpdatedAt: string; ownerToken?: string }>;
      }
    ).byRun;
    fences.set(runId, {
      runId,
      status: "IN_PROGRESS",
      attempt: 1,
      ownerToken: "stale",
      lastUpdatedAt: stack.clock.nowIso(),
    });
    const again = await stack.planning.plan(runId);
    expect(again.planId).toBe(result.planId);
    expect((await stack.planningCoordinator.get(runId))?.status).toBe("PLANNED");
  });

  it("fails closed when live lock becomes STALE before planning", async () => {
    const { stack, runId } = await admitAndIngest();
    stack.remote.setBranchHead("main", EXAMPLE_DRIFT_SHA);
    await stack.ingestion.detectDrift(runId);
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "REPOSITORY_CONTEXT_STALE",
    });
  });

  it("rejects invented evidence references", async () => {
    const { stack, runId } = await admitAndIngest();
    const model = stack.planningModel as {
      setProposal: (proposal: unknown) => void;
      proposePlan: () => Promise<unknown>;
    };
    const gap = await (
      stack.planningModel as {
        analyzeGaps: (input: {
          context: Awaited<ReturnType<typeof stack.planning.compileContext>>;
          promptVersion: string;
        }) => Promise<{ value: unknown }>;
      }
    ).analyzeGaps({
      context: await stack.planning.compileContext(runId),
      promptVersion: "1.0.0",
    });
    const proposal = await (
      stack.planningModel as {
        proposePlan: (input: {
          context: Awaited<ReturnType<typeof stack.planning.compileContext>>;
          gapAnalysis: unknown;
          promptVersion: string;
        }) => Promise<{
          value: {
            steps: Array<{ evidenceRefs: string[] }>;
            gapAnalysis: { evidenceRefs: string[] };
          };
        }>;
      }
    ).proposePlan({
      context: await stack.planning.compileContext(runId),
      gapAnalysis: gap.value as never,
      promptVersion: "1.0.0",
    });
    proposal.value.steps[0]!.evidenceRefs = ["does-not-exist"];
    model.setProposal(proposal.value);
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "INVALID_EVIDENCE_REFERENCE",
    });
  });

  it("rejects unknown action types", async () => {
    const { stack, runId } = await admitAndIngest();
    const context = await stack.planning.compileContext(runId);
    const gap = (await stack.planningModel.analyzeGaps({
      context,
      promptVersion: "1.0.0",
    })).value;
    const proposal = (await stack.planningModel.proposePlan({
      context,
      gapAnalysis: gap,
      promptVersion: "1.0.0",
    })).value;
    proposal.steps[0]!.actionType = "DEPLOY_PRODUCTION";
    (stack.planningModel as { setProposal: (p: unknown) => void }).setProposal(
      proposal,
    );
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "INVALID_CAPABILITY_REFERENCE",
    });
  });

  it("rejects dependency cycles", async () => {
    const { stack, runId } = await admitAndIngest();
    const context = await stack.planning.compileContext(runId);
    const gap = (await stack.planningModel.analyzeGaps({
      context,
      promptVersion: "1.0.0",
    })).value;
    const proposal = (await stack.planningModel.proposePlan({
      context,
      gapAnalysis: gap,
      promptVersion: "1.0.0",
    })).value;
    proposal.steps[0]!.dependsOn = ["step_test"];
    proposal.steps[2]!.dependsOn = ["step_read"];
    (stack.planningModel as { setProposal: (p: unknown) => void }).setProposal(
      proposal,
    );
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLAN_DEPENDENCY_CYCLE",
    });
  });

  it("fails hard when resource budget is exceeded", async () => {
    const { stack, runId } = await admitAndIngest();
    const context = await stack.planning.compileContext(runId);
    const gap = (await stack.planningModel.analyzeGaps({
      context,
      promptVersion: "1.0.0",
    })).value;
    const proposal = (await stack.planningModel.proposePlan({
      context,
      gapAnalysis: gap,
      promptVersion: "1.0.0",
    })).value;
    proposal.proposedResourceTotals.estimatedLlmTokens = 10_000_000;
    (stack.planningModel as { setProposal: (p: unknown) => void }).setProposal(
      proposal,
    );
    await expect(stack.planning.plan(runId)).rejects.toMatchObject({
      code: "PLAN_RESOURCE_BUDGET_EXCEEDED",
    });
    expect(await stack.plans.getByRunId(runId)).toBeNull();
  });

  it("assigns authoritative plan hash outside the model", async () => {
    const { stack, runId } = await admitAndIngest();
    const result = await stack.planning.plan(runId);
    const plan = await stack.plans.getByRunId(runId);
    expect(plan?.plan.planHash).toBe(result.planHash);
    expect(plan?.plan.planId.startsWith("plan_")).toBe(true);
    expect(plan?.plan.planVersion).toBe(1);
  });
});
