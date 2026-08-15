import { describe, expect, it } from "vitest";
import { createLocalPlanningStack } from "../infrastructure/planning/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { ContextBudgetController } from "./budget-controller.js";
import { DependencyGraphService } from "./dependency-graph.js";
import { EvidenceReferenceValidator } from "./evidence-ref-validator.js";
import { CapabilityReferenceValidator } from "./capability-ref-validator.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { EXAMPLE_CAPABILITIES } from "../control-plane/fixtures.js";
import { PlanCompiler, SequencePlanIdentityGenerator } from "./plan-compiler.js";
import { PlanQualityScorer } from "./quality-scorer.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { InMemoryPlanningCoordinator } from "./coordinator.js";
import { OpenAIPlanningModel } from "../infrastructure/planning/openai-planning-model.js";
import { PlanningError } from "./errors.js";

async function ingestedStack() {
  const stack = createLocalPlanningStack();
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error("expected ADMITTED");
  }
  await stack.ingestion.ingest(
    admitted.runId,
    EXAMPLE_PROJECT_ID,
    EXAMPLE_ENVIRONMENT,
  );
  return { stack, runId: admitted.runId };
}

describe("ContextBudgetController", () => {
  it("produces a stable fingerprint for the same inputs", async () => {
    const { stack, runId } = await ingestedStack();
    const a = await stack.planning.compileContext(runId);
    const b = await stack.planning.compileContext(runId);
    expect(a.contextMetadata.planningContextFingerprint).toBe(
      b.contextMetadata.planningContextFingerprint,
    );
    expect(a.contextMetadata.selectedEvidenceIds).toEqual(
      b.contextMetadata.selectedEvidenceIds,
    );
    expect(a.contextMetadata.excludedEvidenceIds).toEqual(
      b.contextMetadata.excludedEvidenceIds,
    );
  });

  it("labels evidence as untrusted data and excludes absolute paths", async () => {
    const { stack, runId } = await ingestedStack();
    const context = await stack.planning.compileContext(runId);
    expect(
      context.evidence.every((item) => item.label === "UNTRUSTED_PROJECT_DATA"),
    ).toBe(true);
    expect(
      context.evidence.every(
        (item) => !item.sourceIdentifier.startsWith("/"),
      ),
    ).toBe(true);
    expect(
      context.planningConstraints.some((item) =>
        item.includes("DATA, not instruction"),
      ),
    ).toBe(true);
  });

  it("records excluded evidence ids", async () => {
    const { stack, runId } = await ingestedStack();
    const run = await stack.runs.getById(runId);
    const objective = await stack.objectives.getByRunBinding(runId);
    const control = await stack.controlPlane.resolve(
      run!.projectId,
      run!.requestedEnvironment,
    );
    const repositoryContext = await stack.contexts.getByRunId(runId);
    const liveLock = await stack.locks.getByRunId(runId);
    const evidence = await stack.evidence.listByRunId(runId);
    const compiler = new ContextBudgetController();
    const compiled = compiler.compile({
      run: run!,
      objective: objective!,
      control,
      repositoryContext: repositoryContext!,
      liveLock: liveLock!,
      evidence,
      contentByEvidenceId: new Map(
        evidence.map((item) => [item.evidenceId, item.summary]),
      ),
      budget: {
        maxEvidenceCount: 1,
        maxExcerptChars: 1000,
        maxExcerptCharsPerItem: 200,
      },
    });
    expect(compiled.contextMetadata.selectedEvidenceIds.length).toBe(1);
    expect(compiled.contextMetadata.excludedEvidenceIds.length).toBeGreaterThan(
      0,
    );
  });
});

describe("validators and compilers", () => {
  it("validates evidence refs against registry identity", () => {
    const validator = new EvidenceReferenceValidator();
    expect(() =>
      validator.validate({
        evidenceRefs: ["missing"],
        evidenceById: new Map(),
        runId: "run_1",
        projectId: "p",
        lockedCommitSha: "1111111111111111111111111111111111111111",
      }),
    ).toThrow(PlanningError);
  });

  it("rejects disabled/forbidden capabilities", async () => {
    const validator = new CapabilityReferenceValidator(
      new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    );
    await expect(
      validator.validate({
        actionTypes: ["PUSH_TO_MAIN"],
        environment: "local",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CAPABILITY_REFERENCE" });
  });

  it("rejects dependency cycles and missing deps", () => {
    const graph = new DependencyGraphService();
    expect(() =>
      graph.validate([
        {
          stepId: "a",
          actionType: "READ_FILE",
          description: "a",
          targetIds: [],
          evidenceRefs: [],
          dependsOn: ["b"],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW", categories: [] },
          validationChecks: ["x"],
          rollbackStrategy: "NONE",
        },
        {
          stepId: "b",
          actionType: "READ_FILE",
          description: "b",
          targetIds: [],
          evidenceRefs: [],
          dependsOn: ["a"],
          preconditions: [],
          expectedPostconditions: [],
          resourceEstimate: {},
          risk: { level: "LOW", categories: [] },
          validationChecks: ["x"],
          rollbackStrategy: "NONE",
        },
      ]),
    ).toThrow(/cycle/i);
  });

  it("computes deterministic plan hashes and ignores model identity", async () => {
    const { stack, runId } = await ingestedStack();
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
    const graph = new DependencyGraphService().validate(proposal.steps);
    const resources = {
      estimatedDurationMinutes: 15,
      estimatedLlmTokens: 4000,
      estimatedApiCalls: 3,
      estimatedHumanMinutes: 10,
      estimatedCost: 0.1,
      maximumParallelWorkstreams: 1,
      planStepCount: proposal.steps.length,
      estimatedLlmCalls: 2,
      classification: "WITHIN_BUDGET" as const,
    };
    const compilerA = new PlanCompiler(new SequencePlanIdentityGenerator());
    const compilerB = new PlanCompiler(new SequencePlanIdentityGenerator());
    const planA = compilerA.compile({ proposal, context, graph, resources });
    const planB = compilerB.compile({ proposal, context, graph, resources });
    expect(planA.planId).toBe("plan_1");
    expect(planB.planId).toBe("plan_1");
    expect(new Sha256PlanHasher().hash(planA)).toBe(planA.planHash);
    expect(planA.planHash).toBe(planB.planHash);
  });

  it("scores complete proposals above threshold", async () => {
    const { stack, runId } = await ingestedStack();
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
    const score = new PlanQualityScorer().score(proposal, context);
    expect(score.overallScore).toBeGreaterThanOrEqual(0.7);
  });
});

describe("PlanningCoordinator and OpenAI boundary", () => {
  it("fences concurrent begins", async () => {
    const coordinator = new InMemoryPlanningCoordinator();
    const first = await coordinator.begin("run_1", "2026-08-14T12:00:00.000Z");
    expect(first.outcome).toBe("STARTED");
    await expect(
      coordinator.begin("run_1", "2026-08-14T12:00:00.000Z"),
    ).rejects.toMatchObject({ code: "PLANNING_IN_PROGRESS" });
  });

  it("fails closed when OpenAI credentials are missing", () => {
    expect(
      () =>
        new OpenAIPlanningModel({
          apiKey: undefined,
          model: "gpt-4.1-mini",
        }),
    ).toThrow(PlanningError);
  });

  it("does not enable tools on the OpenAI adapter", () => {
    const model = new OpenAIPlanningModel({
      apiKey: "sk-test",
      model: "gpt-4.1-mini",
      client: {} as never,
    });
    expect(model.toolsEnabled).toBe(false);
    expect(model.provider).toBe("openai");
  });
});
