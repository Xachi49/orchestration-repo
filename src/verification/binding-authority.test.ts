import { describe, expect, it } from "vitest";
import {
  AcceptanceCriterionIdentityService,
  acceptanceCriterionId,
  criterionTextHash,
} from "../domain/objective/criterion-identity.js";
import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import { PlanCompiler, SequencePlanIdentityGenerator } from "../planning/plan-compiler.js";
import { proposeBindingsForSteps } from "../planning/verification-bindings.js";
import { parsePlanProposal } from "../planning/proposal.js";
import { PlanningError } from "../planning/errors.js";
import { DependencyGraphService } from "../planning/dependency-graph.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { createLocalPlanningStack } from "../infrastructure/planning/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { PlanVerificationBindingValidator } from "../validation/verification-binding-validator.js";
import { OutcomeDecisionEngine } from "../verification/decision-engine.js";
import { heuristicRelevanceSuggestion } from "../verification/binding-fulfillment.js";
import { Sha256DecisionCardHasher } from "../authorization/decision-card-hasher.js";
import { createLocalVerificationStack } from "../infrastructure/verification/local-stack.js";
import { createExecutionFriendlyPlanningModel } from "../execution/friendly-planning-model.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";

const content = {
  requestedOutcome: "Patch and test",
  acceptanceCriteria: [
    "Local patch artifact prepared",
    "Registered test profile executed",
  ],
  nonGoals: ["GitHub pull request creation"],
  constraints: ["Stay within authorized targets"],
  priority: "HIGH" as const,
};

describe("AcceptanceCriterionIdentityService", () => {
  it("same objective produces same criterion IDs", () => {
    const svc = new AcceptanceCriterionIdentityService();
    const a = svc.deriveFromFingerprintContent(content);
    const b = svc.deriveFromFingerprintContent(content);
    expect(a.map((x) => x.criterionId)).toEqual(b.map((x) => x.criterionId));
    const fp = objectiveFingerprint(content);
    expect(a[0]!.criterionId).toBe(
      acceptanceCriterionId({
        objectiveFingerprint: fp,
        index: 0,
        criterionText: content.acceptanceCriteria[0]!,
      }),
    );
  });

  it("material criterion text change changes identity", () => {
    const svc = new AcceptanceCriterionIdentityService();
    const a = svc.deriveFromFingerprintContent(content);
    const b = svc.deriveFromFingerprintContent({
      ...content,
      acceptanceCriteria: [
        "Local patch artifact prepared differently",
        "Registered test profile executed",
      ],
    });
    expect(a[0]!.criterionId).not.toBe(b[0]!.criterionId);
    expect(criterionTextHash(content.acceptanceCriteria[0]!)).not.toBe(
      criterionTextHash("Local patch artifact prepared differently"),
    );
  });
});

describe("plan-bound verification contract", () => {
  it("rejects unbound criteria and invalid step references", async () => {
    const stack = createLocalPlanningStack();
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    await stack.ingestion.ingest(
      admitted.runId!,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    const context = await stack.planning.compileContext(admitted.runId!);
    const steps = [
      {
        stepId: "step_patch",
        actionType: "CREATE_LOCAL_PATCH",
        description: "patch",
        targetIds: ["src/example.ts"],
        evidenceRefs: context.contextMetadata.selectedEvidenceIds.slice(0, 1),
        dependsOn: [],
        preconditions: [],
        expectedPostconditions: ["Local patch artifact prepared"],
        resourceEstimate: { durationMs: 1 },
        risk: { level: "LOW" as const, categories: [] },
        validationChecks: ["ok"],
        rollbackStrategy: "NONE" as const,
      },
    ];
    expect(() =>
      parsePlanProposal({
        gapAnalysis: {
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
        },
        workstreams: [{ workstreamId: "w", name: "w", stepIds: ["step_patch"] }],
        steps,
        successDefinition: ["x"],
        assumptions: [],
        unknowns: [],
        proposedRisks: [],
        proposedVerificationChecks: [],
        proposedRollbackApproach: "none",
        proposedResourceTotals: {
          estimatedDurationMinutes: 1,
          estimatedLlmTokens: 1,
          estimatedApiCalls: 1,
          estimatedHumanMinutes: 1,
          estimatedCost: 0,
          maximumParallelWorkstreams: 1,
        },
        acceptanceCriterionVerificationBindings: [],
        conciseRationale: "test",
      }),
    ).not.toThrow();

    const proposal = parsePlanProposal({
      gapAnalysis: {
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
        acceptanceCriteriaCoverage: context.objective.acceptanceCriteria.map(
          (criterion) => ({ criterion, covered: false }),
        ),
      },
      workstreams: [{ workstreamId: "w", name: "w", stepIds: ["step_patch"] }],
      steps,
      successDefinition: [...context.objective.acceptanceCriteria],
      assumptions: [],
      unknowns: [],
      proposedRisks: [],
      proposedVerificationChecks: [],
      proposedRollbackApproach: "none",
      proposedResourceTotals: {
        estimatedDurationMinutes: 1,
        estimatedLlmTokens: 1,
        estimatedApiCalls: 1,
        estimatedHumanMinutes: 1,
        estimatedCost: 0,
        maximumParallelWorkstreams: 1,
      },
      acceptanceCriterionVerificationBindings: [],
      conciseRationale: "unbound",
    });
    const graph = new DependencyGraphService().validate(proposal.steps);
    const resources = {
      estimatedDurationMinutes: 1,
      estimatedLlmTokens: 1,
      estimatedApiCalls: 1,
      estimatedHumanMinutes: 1,
      estimatedCost: 0,
      maximumParallelWorkstreams: 1,
      planStepCount: 1,
      estimatedLlmCalls: 1,
      classification: "WITHIN_BUDGET" as const,
    };
    expect(() =>
      new PlanCompiler(new SequencePlanIdentityGenerator()).compile({
        proposal,
        context,
        graph,
        resources,
      }),
    ).toThrow(PlanningError);

    expect(() =>
      new PlanCompiler(new SequencePlanIdentityGenerator()).compile({
        proposal: {
          ...proposal,
          acceptanceCriterionVerificationBindings: [
            {
              criterionText: context.objective.acceptanceCriteria[0]!,
              verificationMethod: "STEP_POSTCONDITION",
              stepIds: ["missing_step"],
              postconditionTexts: ["Local patch artifact prepared"],
              requireAll: true,
            },
          ],
        },
        context,
        graph,
        resources,
      }),
    ).toThrow(/nonexistent step/);
  });

  it("changing a binding changes planHash", async () => {
    const stack = createLocalPlanningStack({
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
    await stack.ingestion.ingest(
      admitted.runId!,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    const context = await stack.planning.compileContext(admitted.runId!);
    const gap = (
      await stack.planningModel.analyzeGaps({
        context,
        promptVersion: "1.0.0",
      })
    ).value;
    const proposal = (
      await stack.planningModel.proposePlan({
        context,
        gapAnalysis: gap,
        promptVersion: "1.0.0",
      })
    ).value;
    const graph = new DependencyGraphService().validate(proposal.steps);
    const resources = {
      estimatedDurationMinutes: 12,
      estimatedLlmTokens: 3000,
      estimatedApiCalls: 2,
      estimatedHumanMinutes: 8,
      estimatedCost: 0.08,
      maximumParallelWorkstreams: 1,
      planStepCount: proposal.steps.length,
      estimatedLlmCalls: 2,
      classification: "WITHIN_BUDGET" as const,
    };
    const compiler = new PlanCompiler(new SequencePlanIdentityGenerator());
    const planA = compiler.compile({ proposal, context, graph, resources });
    const altered = {
      ...proposal,
      acceptanceCriterionVerificationBindings: proposal
        .acceptanceCriterionVerificationBindings.map((b, i) =>
          i === 0
            ? {
                ...b,
                verificationMethod: "EXECUTION_ARTIFACT" as const,
                artifactTypes: ["PATCH"],
              }
            : b,
        ),
    };
    const compiler2 = new PlanCompiler(new SequencePlanIdentityGenerator());
    const planB = compiler2.compile({
      proposal: altered,
      context,
      graph,
      resources,
    });
    expect(planA.planHash).not.toBe(planB.planHash);
    expect(new Sha256PlanHasher().hash(planA)).toBe(planA.planHash);
  });
});

describe("Phase 5 binding validation", () => {
  it("missing binding produces deterministic finding", async () => {
    const stack = createLocalPlanningStack({
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
    await stack.ingestion.ingest(
      admitted.runId!,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await stack.planning.plan(admitted.runId!);
    const record = (await stack.plans.getByRunId(admitted.runId!))!;
    const objective = (await stack.objectives.getById(
      (await stack.runs.getById(admitted.runId!))!.objectiveId,
      (await stack.runs.getById(admitted.runId!))!.objectiveVersion,
    ))!;
    const findings = new PlanVerificationBindingValidator().validate({
      plan: {
        ...record.plan,
        acceptanceCriterionVerificationBindings: [],
      },
      objective,
    });
    expect(
      findings.some((f) => f.ruleId === "ACCEPTANCE_CRITERION_UNBOUND"),
    ).toBe(true);
    expect(findings.every((f) => f.blocking)).toBe(true);
  });
});

describe("Phase 6 verification coverage on decision card", () => {
  it("decision card includes verificationCoverageSummary in hash", async () => {
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalVerificationStack({
      approvalDelivery: delivery,
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
    const runId = admitted.runId!;
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);
    await stack.validation.validate(runId);
    const routed = await stack.authorizationRouting.route(runId);
    const card = await stack.decisionCards.get(routed.approvalRequestId!);
    expect(card?.verificationCoverageSummary.length).toBe(2);
    const hasher = new Sha256DecisionCardHasher();
    const hash = hasher.hash(card!);
    expect(hash).toBe(routed.decisionCardHash);
    const mutated = {
      ...card!,
      verificationCoverageSummary: [
        {
          ...card!.verificationCoverageSummary[0]!,
          howVerified: "tampered",
        },
        ...card!.verificationCoverageSummary.slice(1),
      ],
    };
    expect(hasher.hash(mutated)).not.toBe(hash);
  });
});

describe("heuristic vs binding authority", () => {
  it("heuristic relevance never equals verification binding", () => {
    expect(heuristicRelevanceSuggestion("create a local patch")).toBe(
      "CREATE_LOCAL_PATCH",
    );
    const engine = new OutcomeDecisionEngine();
    const decision = engine.decide({
      contained: false,
      unresolvedSideEffectUncertainty: false,
      criterionResults: [
        {
          criterionId: "c1",
          criterionText: "create a local patch",
          verdict: "SATISFIED",
          evidenceRefs: ["e1"],
          stepRefs: ["s1"],
          findingRefs: [],
          conciseRationale: "keyword coincidence",
          verificationMethod: "KEYWORD_ACTION_CREATE_LOCAL_PATCH",
        },
      ],
      postconditionResults: [
        {
          stepId: "s1",
          postconditionId: "p1",
          expected: "x",
          observed: "x",
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
      allCriteriaHaveApprovedBindings: false,
      allBindingsFulfilled: false,
    });
    expect(decision.outcome).not.toBe("VERIFIED_SUCCESS");
  });

  it("model cannot upgrade unfulfilled binding to VERIFIED_SUCCESS", () => {
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
          conciseRationale: "unfulfilled binding",
          verificationMethod: "STEP_POSTCONDITION",
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
      allBindingsFulfilled: false,
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
});

describe("proposeBindingsForSteps", () => {
  it("omits unsupported criteria rather than inventing evidence", () => {
    const bindings = proposeBindingsForSteps({
      acceptanceCriteria: ["Deploy to production cluster"],
      steps: [
        {
          stepId: "step_patch",
          actionType: "CREATE_LOCAL_PATCH",
          description: "p",
          targetIds: ["a"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: ["Local patch artifact prepared"],
          resourceEstimate: {},
          risk: { level: "LOW", categories: [] },
          validationChecks: ["ok"],
          rollbackStrategy: "NONE",
        },
      ],
    });
    expect(bindings).toHaveLength(0);
  });
});
