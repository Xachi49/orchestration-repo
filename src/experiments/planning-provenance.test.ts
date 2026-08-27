import { describe, expect, it } from "vitest";
import { FakePlanningModel } from "../planning/fake-planning-model.js";
import type { PlanningContext } from "../planning/context.js";
import { compileAcceptanceCriterionVerificationBindings } from "../planning/verification-bindings.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import {
  compileExperimentAcceptanceCriteria,
  compileExperimentExecutionSteps,
  compileExperimentVerificationBindings,
  createExperimentAwarePlanningModel,
  EXPERIMENT_MEASUREMENT_CRITERION,
} from "./planning-proposal.js";
import { resolveVerifiedExperimentPlanningOrigin } from "./planning-provenance.js";
import {
  buildExperimentService,
  ladderToAuthorized,
} from "./test-fixtures.js";

const emptyGapAnalysis = {
  existingCapabilities: [],
  missingCapabilities: [],
  brokenOrInsufficientCapabilities: [],
  requiredDependencies: [],
  constraints: [],
  unknowns: [],
  assumptions: [],
  contradictions: [],
  blockedPrerequisites: [],
  evidenceRefs: [],
  acceptanceCriteriaCoverage: [],
};

function minimalPlanningContext(input: {
  runId: string;
  objectiveId: string;
  objectiveVersion?: number;
  acceptanceCriteria?: readonly string[];
  constraints?: readonly string[];
  projectId?: string;
}): PlanningContext {
  return {
    run: {
      runId: input.runId,
      projectId: input.projectId ?? EXAMPLE_PROJECT_ID,
      objectiveId: input.objectiveId,
      objectiveVersion: input.objectiveVersion ?? 1,
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      correlationId: "corr_test",
      traceId: "trace_test",
    },
    objective: {
      requestedOutcome: "Test objective",
      acceptanceCriteria: [...(input.acceptanceCriteria ?? ["Local patch artifact prepared"])],
      nonGoals: [],
      constraints: [...(input.constraints ?? [])],
      priority: "MEDIUM",
    },
    controlPlane: {
      projectId: input.projectId ?? EXAMPLE_PROJECT_ID,
      executionMode: "LOCAL",
      policyBundleId: "policy_test",
      policyBundleVersion: "1",
      policyBundleHash: "hash_test",
      policyRules: [],
      availableCapabilities: [],
      resourceBudget: {
        budgetProfileId: "budget_test",
        maximumLlmCalls: 10,
        maximumTotalTokens: 10_000,
        maximumApiCalls: 10,
        maximumExecutionMinutes: 60,
      },
    },
    contextMetadata: {
      selectedEvidenceIds: [],
      compilerVersion: "1.0.0",
    },
    evidenceExcerpts: [],
    precedentContext: {
      retrievedPrecedents: [],
      retrievalQueryHash: "rq_test",
    },
  } as PlanningContext;
}

describe("Experiment planning provenance", () => {
  it("A: compiled experiment objective with durable lineage selects experiment proposal with explicit bindings", async () => {
    const { service, plans, lineage, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    const plan = (await plans.getLatest(id))!;
    const runId = compiled.lineage.compiledRunId!;
    const acceptanceCriteria = compileExperimentAcceptanceCriteria(plan);
    const delegate = new FakePlanningModel();

    const model = createExperimentAwarePlanningModel(delegate, {
      lineage,
      plans,
      experiments,
    });

    const context = minimalPlanningContext({
      runId,
      objectiveId: compiled.compiled.objectiveId,
      objectiveVersion: compiled.compiled.objectiveVersion,
      acceptanceCriteria,
      constraints: [
        `experimentId=${id}`,
        `experimentPlanHash=${plan.experimentPlanHash}`,
      ],
    });

    const output = await model.proposePlan({
      context,
      gapAnalysis: emptyGapAnalysis,
      promptVersion: "1.0.0",
    });

    expect(delegate.callCount).toBe(0);
    expect(
      output.value.acceptanceCriterionVerificationBindings,
    ).toHaveLength(2);
    expect(output.value.steps.some((step) => step.stepId.includes("step_exp_"))).toBe(
      true,
    );

    const compiledBindings = compileAcceptanceCriterionVerificationBindings({
      objective: context.objective,
      proposal: output.value,
      steps: output.value.steps,
    });
    expect(compiledBindings).toHaveLength(2);
    expect(
      compiledBindings.some(
        (binding) =>
          binding.verificationMethod === "STEP_POSTCONDITION" &&
          binding.stepIds.length > 0,
      ),
    ).toBe(true);
  });

  it("B: spoofed experiment constraint strings without lineage delegate to inner model", async () => {
    const { lineage, plans, experiments } = buildExperimentService();
    const delegate = new FakePlanningModel();
    const model = createExperimentAwarePlanningModel(delegate, {
      lineage,
      plans,
      experiments,
    });

    const context = minimalPlanningContext({
      runId: "run_spoof_no_lineage",
      objectiveId: "obj_spoof",
      acceptanceCriteria: [
        EXPERIMENT_MEASUREMENT_CRITERION,
        "Phase 8 verification required before authoritative evidence",
      ],
      constraints: [
        "experimentId=fake",
        "experimentPlanHash=fake_hash",
      ],
    });

    const output = await model.proposePlan({
      context,
      gapAnalysis: emptyGapAnalysis,
      promptVersion: "1.0.0",
    });

    expect(delegate.callCount).toBe(1);
    expect(output.value.steps.some((step) => step.stepId.includes("step_exp_"))).toBe(
      false,
    );
  });

  it("C: durable lineage with tampered plan hash constraint fails closed", async () => {
    const { service, plans, lineage, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    const plan = (await plans.getLatest(id))!;
    const runId = compiled.lineage.compiledRunId!;
    const delegate = new FakePlanningModel();
    const model = createExperimentAwarePlanningModel(delegate, {
      lineage,
      plans,
      experiments,
    });

    await expect(
      model.proposePlan({
        context: minimalPlanningContext({
          runId,
          objectiveId: compiled.compiled.objectiveId,
          objectiveVersion: compiled.compiled.objectiveVersion,
          acceptanceCriteria: compileExperimentAcceptanceCriteria(plan),
          constraints: [
            `experimentId=${id}`,
            "experimentPlanHash=tampered_hash",
          ],
        }),
        gapAnalysis: emptyGapAnalysis,
        promptVersion: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "PLANNING_CONTEXT_MISMATCH" });
    expect(delegate.callCount).toBe(0);
  });

  it("D: durable lineage with wrong objective identity fails closed", async () => {
    const { service, plans, lineage, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    const plan = (await plans.getLatest(id))!;
    const runId = compiled.lineage.compiledRunId!;
    const delegate = new FakePlanningModel();
    const model = createExperimentAwarePlanningModel(delegate, {
      lineage,
      plans,
      experiments,
    });

    await expect(
      model.proposePlan({
        context: minimalPlanningContext({
          runId,
          objectiveId: "obj_wrong_identity",
          objectiveVersion: compiled.compiled.objectiveVersion,
          acceptanceCriteria: compileExperimentAcceptanceCriteria(plan),
          constraints: [
            `experimentId=${id}`,
            `experimentPlanHash=${plan.experimentPlanHash}`,
          ],
        }),
        gapAnalysis: emptyGapAnalysis,
        promptVersion: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "PLANNING_CONTEXT_MISMATCH" });
    expect(delegate.callCount).toBe(0);
  });

  it("E: ordinary non-experiment objective keeps delegate behavior unchanged", async () => {
    const { lineage, plans, experiments } = buildExperimentService();
    const delegate = new FakePlanningModel();
    const model = createExperimentAwarePlanningModel(delegate, {
      lineage,
      plans,
      experiments,
    });

    const context = minimalPlanningContext({
      runId: "run_ordinary",
      objectiveId: "obj_ordinary",
      acceptanceCriteria: ["Local patch artifact prepared", "Tests executed"],
      constraints: ["No external side effects"],
    });

    const output = await model.proposePlan({
      context,
      gapAnalysis: emptyGapAnalysis,
      promptVersion: "1.0.0",
    });

    expect(delegate.callCount).toBe(1);
    expect(output.value.steps.some((step) => step.stepId === "step_patch")).toBe(
      true,
    );
    expect(output.value.steps.some((step) => step.stepId.includes("step_exp_"))).toBe(
      false,
    );
  });

  it("authoritative plan hash drives steps even when constraint strings are absent", async () => {
    const { service, plans, lineage, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    const plan = (await plans.getLatest(id))!;
    const runId = compiled.lineage.compiledRunId!;
    const delegate = new FakePlanningModel();
    const model = createExperimentAwarePlanningModel(delegate, {
      lineage,
      plans,
      experiments,
    });

    const output = await model.proposePlan({
      context: minimalPlanningContext({
        runId,
        objectiveId: compiled.compiled.objectiveId,
        objectiveVersion: compiled.compiled.objectiveVersion,
        acceptanceCriteria: compileExperimentAcceptanceCriteria(plan),
        constraints: [],
      }),
      gapAnalysis: emptyGapAnalysis,
      promptVersion: "1.0.0",
    });

    const expectedSteps = compileExperimentExecutionSteps(plan.experimentPlanHash);
    expect(output.value.steps.map((step) => step.stepId)).toEqual(
      expectedSteps.map((step) => step.stepId),
    );
    expect(
      compileExperimentVerificationBindings({
        acceptanceCriteria: compileExperimentAcceptanceCriteria(plan),
        steps: output.value.steps,
      }),
    ).toHaveLength(2);
  });
});

describe("resolveVerifiedExperimentPlanningOrigin", () => {
  it("rejects lineage whose experiment belongs to another project", async () => {
    const { service, plans, lineage, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    const plan = (await plans.getLatest(id))!;
    const runId = compiled.lineage.compiledRunId!;

    await expect(
      resolveVerifiedExperimentPlanningOrigin(
        { lineage, plans, experiments },
        {
          runId,
          projectId: "other_project",
          objectiveId: compiled.compiled.objectiveId,
          objectiveVersion: compiled.compiled.objectiveVersion,
          constraints: [
            `experimentId=${id}`,
            `experimentPlanHash=${plan.experimentPlanHash}`,
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "PLANNING_CONTEXT_MISMATCH" });
  });
});
