import { describe, expect, it } from "vitest";
import { ControlPlaneService } from "../control-plane/service.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { FixedClock } from "../infrastructure/index.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";
import { SequenceDecisionNonceGenerator } from "../authorization/decision-nonce.js";
import { InMemoryApproverAuthorizationService } from "../authorization/approver-authorization.js";
import {
  InMemorySchedulerProjectConfigRepository,
  InMemorySchedulerWorkItemRepository,
} from "../scheduling/index.js";
import {
  assumptionSetHash,
  withAssumptionSetHash,
  type ScenarioAssumption,
} from "../scenarios/assumptions.js";
import type { OutcomeVerificationRecord } from "../domain/verification/index.js";
import {
  ExperimentOrchestrationService,
  ExperimentProgressionLoop,
  ExperimentWorkMaterializer,
  FakeExperimentDesignModel,
  FakeExperimentObjectiveAdmissionPort,
  FakeExperimentOutcomeVerificationPort,
  Phase2ExperimentObjectiveAdmissionPort,
  EXPERIMENT_TRANSITIONS,
  EXPERIMENT_DOCTRINE,
  EXPERIMENT_SPONSOR_AUTHORITY_BOUNDARIES,
  EXPERIMENT_AUTHORITY_BOUNDARIES,
  assertExperimentAuthoritySeparation,
  canTransitionExperiment,
  assertCompatibleUnits,
  validateHypothesisMeasurability,
  analyzeValueOfInformation,
  rankActiveLearningCandidates,
  withExperimentPlanHash,
  computeExperimentPlanHash,
  fakeAssumptionBindingsFor,
  reserveExperimentUsage,
  sampleCountDelta,
  hydrateExperimentUsageLedger,
  isExperimentError,
  type ExperimentHypothesis,
  InMemoryExperimentRepository,
  InMemoryExperimentPlanRepository,
  InMemoryExperimentAuthorizationRequestRepository,
  InMemoryExperimentAuthorizationRecordRepository,
  InMemoryExperimentResultRepository,
  InMemoryExperimentEvidenceBundleRepository,
  InMemoryAssumptionEvidenceUpdateCandidateRepository,
  InMemoryExperimentCompletionRecordRepository,
  InMemoryExperimentExecutionLineageRepository,
  InMemoryExperimentUsageLedgerRepository,
} from "./index.js";
import { compileExperimentToObjective } from "./execution-compiler.js";
import {
  compileExperimentAcceptanceCriteria,
  compileExperimentExecutionSteps,
  compileExperimentVerificationBindings,
  EXPERIMENT_MEASUREMENT_CRITERION,
  EXPERIMENT_PHASE8_CRITERION,
} from "./planning-proposal.js";
import { compileAcceptanceCriterionVerificationBindings } from "../planning/verification-bindings.js";
import { acceptanceCriterionIdentity } from "../domain/objective/criterion-identity.js";
import { PlanningError } from "../planning/errors.js";
import { parsePlanProposal } from "../planning/proposal.js";

import {
  admitSampleExperiment,
  buildExperimentService,
  buildExperimentSponsorChecker,
  EXPERIMENT_TEST_NOW,
  ladderToAuthorized,
} from "./test-fixtures.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");
const NOW = EXPERIMENT_TEST_NOW;

const DEFAULT_BUDGET = {
  maximumActions: 10,
  maximumDurationHours: 24,
  maximumModelCalls: 5,
  maximumTotalTokens: 10_000,
  maximumSampleSize: 100,
  maximumEstimatedCost: 50,
  maximumExternalSideEffects: 0,
} as const;

const SAMPLE_ASSUMPTIONS: ScenarioAssumption[] = [
  {
    assumptionId: "asm_latency",
    name: "Latency bound",
    description: "p95 latency stays under 200ms",
    value: 1,
    unit: "RATIO",
    sourceClass: "ASSUMPTION",
    confidenceClassification: "MEDIUM",
    sensitivityEligible: true,
    materiality: "HIGH",
  },
];

function sampleHypothesis(
  overrides?: Partial<ExperimentHypothesis>,
): ExperimentHypothesis {
  return {
    hypothesisId: "hyp_sample",
    statement: "Learning asm_a changes preferred scenario",
    nullHypothesis: "No material decision change from learning asm_a",
    alternativeHypothesis: "Learning asm_a flips preferred scenario",
    sourceAssumptionId: "asm_a",
    expectedDirection: "UNKNOWN",
    materiality: "HIGH",
    decisionImpact: "HIGH",
    successCriterion: "Observed effect exceeds MDE with VALIDATED quality",
    failureCriterion: "Observed effect opposite direction with VALIDATED quality",
    inconclusiveCriterion: "UNKNOWN quality or effect within noise",
    ...overrides,
  };
}

function seedPhase8Record(input: {
  outcomeVerificationId: string;
  runId: string;
  outcome?: OutcomeVerificationRecord["outcome"];
}): OutcomeVerificationRecord {
  return {
    outcomeVerificationId: input.outcomeVerificationId,
    verificationAttemptId: `va_${input.outcomeVerificationId}`,
    runId: input.runId,
    executionAttemptId: `ea_${input.outcomeVerificationId}`,
    planId: "pl_exp_1",
    planVersion: 1,
    planHash: "ph_exp_1",
    authorizationRecordId: "ar_exp_1",
    postExecutionSnapshotHash: "pe_exp_1",
    verificationSpecificationHash: "vs_exp_1",
    outcome: input.outcome ?? "VERIFIED_SUCCESS",
    criterionResults: [],
    postconditionResults: [],
    findings: [],
    evidenceRefs: [`ev_${input.outcomeVerificationId}`],
    createdAt: NOW,
  };
}

async function forceExecuting(
  experiments: InMemoryExperimentRepository,
  id: string,
) {
  let experiment = (await experiments.getById(id))!;
  return experiments.transition(
    id,
    experiment.status,
    experiment.recordRevision,
    "EXECUTING",
    "2026-01-01T02:00:00.000Z",
  );
}

describe("Phase 17 governed experimentation", () => {
  it("allows legal experiment transitions and rejects illegal ones", () => {
    expect(canTransitionExperiment("ADMITTED", "DESIGNING")).toBe(true);
    expect(canTransitionExperiment("AWAITING_AUTHORIZATION", "AUTHORIZED")).toBe(
      true,
    );
    expect(
      canTransitionExperiment("AUTHORIZED", "AWAITING_EXECUTION_AUTHORIZATION"),
    ).toBe(true);
    expect(canTransitionExperiment("VERIFYING", "COMPLETED")).toBe(true);
    expect(canTransitionExperiment("VERIFYING", "INCONCLUSIVE")).toBe(true);
    expect(canTransitionExperiment("ADMITTED", "COMPLETED")).toBe(false);
    expect(canTransitionExperiment("COMPLETED", "ADMITTED")).toBe(false);
    expect(canTransitionExperiment("CANCELLED", "DESIGNING")).toBe(false);

    for (const [from, targets] of Object.entries(EXPERIMENT_TRANSITIONS)) {
      for (const to of targets) {
        expect(
          canTransitionExperiment(
            from as keyof typeof EXPERIMENT_TRANSITIONS,
            to,
          ),
        ).toBe(true);
      }
    }
  });

  it("asserts authority separation constants", () => {
    assertExperimentAuthoritySeparation();
    expect(EXPERIMENT_DOCTRINE.experimentsProduceEvidenceNotAuthority).toContain(
      "evidence",
    );
    expect(EXPERIMENT_SPONSOR_AUTHORITY_BOUNDARIES).toBeTruthy();
    expect(EXPERIMENT_AUTHORITY_BOUNDARIES.compilation).toContain("Phase 6");
  });

  it("validates hypothesis measurability and unit compatibility", () => {
    expect(() =>
      assertCompatibleUnits("RATIO", "RATIO", "compare"),
    ).not.toThrow();
    expect(() => assertCompatibleUnits("RATIO", "COUNT", "compare")).toThrow();
    const hyp = sampleHypothesis();
    expect(() => validateHypothesisMeasurability(hyp)).not.toThrow();
  });

  it("ranks VOI candidates deterministically", () => {
    const ranked = rankActiveLearningCandidates([
      {
        assumptionId: "a",
        decisionProblemId: "dp_1",
        sensitivityRank: 1,
        decisionFlipRisk: "HIGH",
        evidenceGap: "HIGH",
        candidateExperimentIds: [],
      },
      {
        assumptionId: "b",
        decisionProblemId: "dp_1",
        sensitivityRank: 2,
        decisionFlipRisk: "LOW",
        evidenceGap: "LOW",
        candidateExperimentIds: [],
      },
    ]);
    expect(ranked[0]?.assumptionId).toBe("a");
    const voi = analyzeValueOfInformation({
      assumptionId: "a",
      assumptionMateriality: "HIGH",
      sensitivityRank: 1,
      experimentCostClass: "LOW",
      timeClass: "LOW",
      riskClass: "LOW",
      evidenceQualityExpected: "HIGH",
    });
    expect(voi.recommended).toBe(true);
  });

  it("admits, designs, validates, and binds assumptions", async () => {
    const { service, experiments, plans } = buildExperimentService();
    const admitted = await admitSampleExperiment(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.experiment.experimentId;
    const { experiment, plan } = await service.design(id);
    expect(experiment.status).toBe("PLANNED");
    expect(experiment.assumptionBindings.length).toBeGreaterThan(0);
    expect(plan.assumptionBindings[0]?.assumptionId).toBe("asm_latency");
    expect(fakeAssumptionBindingsFor(experiment)[0]?.assumptionId).toBe(
      "asm_latency",
    );
    const stored = await plans.getLatest(id);
    expect(stored?.assumptionBindings[0]?.assumptionId).toBe("asm_latency");
    expect(computeExperimentPlanHash(withExperimentPlanHash(plan))).toBe(
      plan.experimentPlanHash,
    );
    expect((await experiments.getById(id))?.status).toBe("PLANNED");
  });

  it("sponsor approval does not create Phase 6 auth or execution attempts", async () => {
    const { service, lineage } = buildExperimentService();
    const { id, decided } = await ladderToAuthorized(service);
    expect(decided.experiment.status).toBe("AUTHORIZED");
    const compiled = await service.compileExecution(id);
    expect(compiled.experiment.status).toBe("AWAITING_EXECUTION_AUTHORIZATION");
    expect(compiled.lineage.compiledRunId).toBeTruthy();
    expect(compiled.lineage.phase6AuthorizationRecordId).toBeUndefined();
    expect(compiled.lineage.executionAttemptId).toBeUndefined();
    expect((await lineage.listByExperiment(id)).length).toBe(1);
  });

  it("rejects non-sponsor authorization decisions", async () => {
    const { service, authRecords } = buildExperimentService();
    const admitted = await admitSampleExperiment(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.experiment.experimentId;
    await service.design(id);
    await service.validate(id);
    const routed = await service.routeAuthorization(id);
    await expect(
      service.decideAuthorization({
        authorizationId: routed.request.authorizationId,
        sponsorId: "approver_only",
        decision: "APPROVE_EXPERIMENT",
        decisionNonce: routed.decisionNonce,
        submittedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "EXPERIMENT_SPONSOR_SCOPE_INSUFFICIENT" });
    expect(await authRecords.getLatest(id)).toBeNull();
  });

  it("rejects nonce mismatch and expired authorization decisions", async () => {
    const { service, authRecords } = buildExperimentService();
    const admitted = await admitSampleExperiment(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.experiment.experimentId;
    await service.design(id);
    await service.validate(id);
    const routed = await service.routeAuthorization(id);

    await expect(
      service.decideAuthorization({
        authorizationId: routed.request.authorizationId,
        sponsorId: "sponsor_full",
        decision: "APPROVE_EXPERIMENT",
        decisionNonce: "definitely-wrong-nonce",
        submittedAt: "2026-01-01T01:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "EXPERIMENT_AUTHORIZATION_INVALID" });
    expect(await authRecords.getLatest(id)).toBeNull();

    await expect(
      service.decideAuthorization({
        authorizationId: routed.request.authorizationId,
        sponsorId: "sponsor_full",
        decision: "APPROVE_EXPERIMENT",
        decisionNonce: routed.decisionNonce,
        submittedAt: "2099-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "EXPERIMENT_AUTHORIZATION_EXPIRED" });
    expect(await authRecords.getLatest(id)).toBeNull();
  });

  it("A: measurement success without Phase 8 cannot create authoritative SUPPORTED evidence", async () => {
    const { service, experiments, updateCandidates } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    await service.compileExecution(id);
    await forceExecuting(experiments, id);

    const completed = await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.12,
          unit: "RATIO",
          sampleCount: 10,
          quality: "VALIDATED",
          evidenceRefs: ["caller-claimed"],
          limitations: [],
        },
      ],
    });

    expect(completed.experiment.status).toBe("INCONCLUSIVE");
    expect(completed.evidenceBundle.qualityClassification).toBe("UNKNOWN");
    expect(
      completed.result.hypothesisResults.every((h) => h.outcome === "INCONCLUSIVE"),
    ).toBe(true);
    expect(
      completed.updateCandidates.every(
        (c) =>
          c.revisionKind === "INSUFFICIENT_EVIDENCE" &&
          c.proposedValue === undefined,
      ),
    ).toBe(true);
    expect((await updateCandidates.listByExperiment(id)).length).toBeGreaterThan(
      0,
    );
  });

  it("B: unrelated Phase 8 verification fails closed", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_other",
        runId: "run_unrelated",
        outcome: "VERIFIED_SUCCESS",
      }),
    );
    const { service, experiments } = buildExperimentService({
      outcomeVerificationPort: verificationPort,
    });
    const { id } = await ladderToAuthorized(service);
    await service.compileExecution(id);
    await forceExecuting(experiments, id);

    await expect(
      service.verifyAndComplete(id, {
        measurementResults: [
          {
            measurementId: `meas_${id}_primary`,
            observedValue: 1.12,
            unit: "RATIO",
            sampleCount: 10,
            quality: "VALIDATED",
            evidenceRefs: [],
            limitations: [],
          },
        ],
        outcomeVerificationIds: ["ov_other"],
      }),
    ).rejects.toMatchObject({ code: "PHASE8_VERIFICATION_RUN_MISMATCH" });
  });

  it("C: correct run + Phase 8 verified evidence resolves hypothesis", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    const { service, experiments, lineage } = buildExperimentService({
      outcomeVerificationPort: verificationPort,
    });
    const asmSet = withAssumptionSetHash(SAMPLE_ASSUMPTIONS);
    const { id } = await ladderToAuthorized(service, {
      sourceAssumptionSetHash: asmSet.assumptionSetHash,
    });
    const compiled = await service.compileExecution(id);
    const runId = compiled.lineage.compiledRunId!;
    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_ok",
        runId,
        outcome: "VERIFIED_SUCCESS",
      }),
    );
    await forceExecuting(experiments, id);

    const completed = await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.12,
          unit: "RATIO",
          sampleCount: 10,
          quality: "UNKNOWN",
          evidenceRefs: [],
          limitations: [],
        },
      ],
      outcomeVerificationIds: ["ov_ok"],
    });

    expect(completed.experiment.status).toBe("COMPLETED");
    expect(completed.evidenceBundle.qualityClassification).toBe("VALIDATED");
    expect(
      completed.result.hypothesisResults.some((h) => h.outcome === "SUPPORTED"),
    ).toBe(true);
    expect(completed.updateCandidates[0]?.revisionKind).toBe("NUMERIC_PROMOTION");
    expect(completed.updateCandidates[0]?.proposedValue).toBe(1.12);
    expect(completed.updateCandidates[0]?.evidenceBundleHash).toBe(
      completed.evidenceBundle.evidenceBundleHash,
    );
    expect(completed.updateCandidates[0]?.outcomeVerificationIds).toEqual([
      "ov_ok",
    ]);
    expect(completed.completion.evidenceBundleHash).toBe(
      completed.evidenceBundle.evidenceBundleHash,
    );
    expect(completed.completion.executionLineageId).toBe(
      (await lineage.listByExperiment(id))[0]?.lineageId,
    );
  });

  it("D: DEGRADED Phase 8 quality cannot silently become SUPPORTED", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    const { service, experiments } = buildExperimentService({
      outcomeVerificationPort: verificationPort,
    });
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_fail",
        runId: compiled.lineage.compiledRunId!,
        outcome: "VERIFICATION_FAILED",
      }),
    );
    await forceExecuting(experiments, id);

    const completed = await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.2,
          unit: "RATIO",
          sampleCount: 10,
          quality: "VALIDATED",
          evidenceRefs: [],
          limitations: [],
        },
      ],
      outcomeVerificationIds: ["ov_fail"],
    });

    expect(completed.experiment.status).toBe("INCONCLUSIVE");
    expect(completed.evidenceBundle.qualityClassification).toBe("DEGRADED");
    expect(
      completed.updateCandidates.every(
        (c) =>
          c.revisionKind === "INSUFFICIENT_EVIDENCE" &&
          c.proposedValue === undefined,
      ),
    ).toBe(true);
  });

  it("E: verified insufficient sample yields INCONCLUSIVE without numeric promotion", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    const { service, experiments } = buildExperimentService({
      outcomeVerificationPort: verificationPort,
    });
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_empty",
        runId: compiled.lineage.compiledRunId!,
        outcome: "VERIFIED_SUCCESS",
      }),
    );
    await forceExecuting(experiments, id);

    const completed = await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.2,
          unit: "RATIO",
          sampleCount: 0,
          quality: "VALIDATED",
          evidenceRefs: [],
          limitations: [],
        },
      ],
      outcomeVerificationIds: ["ov_empty"],
    });

    expect(completed.experiment.status).toBe("INCONCLUSIVE");
    expect(
      completed.updateCandidates.every((c) => c.proposedValue === undefined),
    ).toBe(true);
  });

  it("fabricated Phase 8 refs fail closed", async () => {
    const { service, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    await service.compileExecution(id);
    await forceExecuting(experiments, id);
    await expect(
      service.verifyAndComplete(id, {
        measurementResults: [
          {
            measurementId: `meas_${id}_primary`,
            observedValue: 1.1,
            unit: "RATIO",
            sampleCount: 5,
            quality: "VALIDATED",
            evidenceRefs: [],
            limitations: [],
          },
        ],
        outcomeVerificationIds: ["ov_does_not_exist"],
      }),
    ).rejects.toMatchObject({ code: "PHASE8_VERIFICATION_INVALID" });
  });

  it("missing Phase 2 admission port fails closed and leaves AUTHORIZED", async () => {
    const { service, experiments, lineage } = buildExperimentService({
      objectiveAdmissionPort: null,
    });
    const { id } = await ladderToAuthorized(service);
    await expect(service.compileExecution(id)).rejects.toMatchObject({
      code: "OBJECTIVE_ADMISSION_UNAVAILABLE",
    });
    expect((await experiments.getById(id))?.status).toBe("AUTHORIZED");
    expect((await lineage.listByExperiment(id)).length).toBe(0);
  });

  it("crash after Phase 2 admit before lineage reuses deterministic objective", async () => {
    const port = new FakeExperimentObjectiveAdmissionPort();
    let crashed = false;
    const { service, lineage, experiments } = buildExperimentService({
      objectiveAdmissionPort: port,
      compileFailpoint: {
        afterAdmit: async () => {
          if (!crashed) {
            crashed = true;
            throw new Error("simulated crash after admit");
          }
        },
      },
    });
    const { id } = await ladderToAuthorized(service);
    await expect(service.compileExecution(id)).rejects.toThrow(/simulated crash/);
    expect((await lineage.listByExperiment(id)).length).toBe(0);
    expect((await experiments.getById(id))?.status).toBe("AUTHORIZED");

    const resumed = await service.compileExecution(id);
    expect(resumed.experiment.status).toBe("AWAITING_EXECUTION_AUTHORIZATION");
    expect(port.admitCallCount).toBe(2);
    expect(resumed.lineage.phase2AdmissionOutcome).toBe("DUPLICATE_REUSED");
    expect((await lineage.listByExperiment(id)).length).toBe(1);
  });

  it("crash after lineage before status transition reuses lineage once", async () => {
    const port = new FakeExperimentObjectiveAdmissionPort();
    let crashed = false;
    const { service, lineage, experiments } = buildExperimentService({
      objectiveAdmissionPort: port,
      compileFailpoint: {
        afterLineage: async () => {
          if (!crashed) {
            crashed = true;
            throw new Error("simulated crash after lineage");
          }
        },
      },
    });
    const { id } = await ladderToAuthorized(service);
    await expect(service.compileExecution(id)).rejects.toThrow(/simulated crash/);
    expect((await lineage.listByExperiment(id)).length).toBe(1);
    expect((await experiments.getById(id))?.status).toBe("AUTHORIZED");

    const resumed = await service.compileExecution(id);
    expect(resumed.experiment.status).toBe("AWAITING_EXECUTION_AUTHORIZATION");
    expect(port.admitCallCount).toBe(1);
    expect((await lineage.listByExperiment(id)).length).toBe(1);
  });

  it("assumption set hash is unchanged after evidence and candidates", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    const asmSet = withAssumptionSetHash(SAMPLE_ASSUMPTIONS);
    const before = assumptionSetHash(SAMPLE_ASSUMPTIONS);
    const { service, experiments } = buildExperimentService({
      outcomeVerificationPort: verificationPort,
    });
    const { id } = await ladderToAuthorized(service, {
      sourceAssumptionSetHash: asmSet.assumptionSetHash,
    });
    const compiled = await service.compileExecution(id);
    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_imm",
        runId: compiled.lineage.compiledRunId!,
      }),
    );
    await forceExecuting(experiments, id);
    await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.15,
          unit: "RATIO",
          sampleCount: 8,
          quality: "VALIDATED",
          evidenceRefs: [],
          limitations: [],
        },
      ],
      outcomeVerificationIds: ["ov_imm"],
    });
    expect(assumptionSetHash(SAMPLE_ASSUMPTIONS)).toBe(before);
    expect(asmSet.assumptionSetHash).toBe(before);
  });

  it("hydrates usage ledger preserving persisted reserved/committed values", () => {
    expect(
      hydrateExperimentUsageLedger({
        payload: {
          experimentId: "e1",
          designCalls: 1,
          modelCalls: 2,
          sampleCount: 3,
          reservedActions: 3,
          committedActions: 0,
          updatedAt: NOW,
        },
        recordRevision: 2,
      }).reservedActions,
    ).toBe(3);

    expect(
      hydrateExperimentUsageLedger({
        payload: {
          experimentId: "e1",
          designCalls: 0,
          modelCalls: 0,
          sampleCount: 0,
          reservedActions: 0,
          committedActions: 2,
          updatedAt: NOW,
        },
        recordRevision: 1,
      }).committedActions,
    ).toBe(2);

    const legacy = hydrateExperimentUsageLedger({
      payload: {
        experimentId: "e_legacy",
        designCalls: 1,
        modelCalls: 1,
        sampleCount: 5,
        updatedAt: NOW,
      },
      recordRevision: 4,
    });
    expect(legacy.reservedActions).toBe(0);
    expect(legacy.committedActions).toBe(0);

    expect(
      hydrateExperimentUsageLedger({
        payload: {
          experimentId: "e0",
          designCalls: 0,
          modelCalls: 0,
          sampleCount: 0,
          reservedActions: 0,
          committedActions: 0,
          updatedAt: NOW,
        },
        recordRevision: 1,
      }),
    ).toMatchObject({ reservedActions: 0, committedActions: 0 });
  });

  it("concurrent last sample reservation admits only one winner", async () => {
    const usageLedger = new InMemoryExperimentUsageLedgerRepository();
    await usageLedger.create({
      experimentId: "exp_budget",
      designCalls: 0,
      modelCalls: 0,
      sampleCount: 99,
      reservedActions: 0,
      committedActions: 0,
      recordRevision: 1,
      updatedAt: NOW,
    });
    const budget = { ...DEFAULT_BUDGET, maximumSampleSize: 100 };
    const results = await Promise.allSettled([
      reserveExperimentUsage({
        usageLedger,
        experimentId: "exp_budget",
        budget,
        delta: { sampleCount: 1 },
        nowIso: NOW,
      }),
      reserveExperimentUsage({
        usageLedger,
        experimentId: "exp_budget",
        budget,
        delta: { sampleCount: 1 },
        nowIso: NOW,
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(
      isExperimentError((rejected[0] as PromiseRejectedResult).reason) &&
        (rejected[0] as PromiseRejectedResult).reason.code ===
          "EXPERIMENT_BUDGET_EXCEEDED",
    ).toBe(true);
    expect((await usageLedger.get("exp_budget"))?.sampleCount).toBe(100);
  });

  it("crash/retry measurement usage conserves sample count", async () => {
    const { service, experiments, usageLedger } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    await service.compileExecution(id);
    await forceExecuting(experiments, id);

    const firstThree = [1, 2, 3].map((n) => ({
      measurementId: `meas_${id}_${n}`,
      observedValue: 1.0,
      unit: "RATIO" as const,
      sampleCount: 1,
      quality: "UNKNOWN" as const,
      evidenceRefs: [],
      limitations: [],
    }));
    await service.recordVerifiedMeasurements(id, firstThree);
    expect((await usageLedger.get(id))?.sampleCount).toBe(3);

    // Crash replay of same measurements must not double-charge.
    await service.recordVerifiedMeasurements(id, firstThree);
    expect((await usageLedger.get(id))?.sampleCount).toBe(3);

    const remaining = [4, 5].map((n) => ({
      measurementId: `meas_${id}_${n}`,
      observedValue: 1.0,
      unit: "RATIO" as const,
      sampleCount: 1,
      quality: "UNKNOWN" as const,
      evidenceRefs: [],
      limitations: [],
    }));
    await service.recordVerifiedMeasurements(id, remaining);
    expect((await usageLedger.get(id))?.sampleCount).toBe(5);
    expect(sampleCountDelta({ existing: firstThree, incoming: firstThree })).toBe(
      0,
    );
  });

  it("live authority ladder: real Phase 2 admit, Phase 6 barrier, Phase 8 evidence", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    const asmSet = withAssumptionSetHash(SAMPLE_ASSUMPTIONS);
    const {
      service,
      experiments,
      lineage,
      admissionStack,
      controlPlane,
      updateCandidates,
    } = buildExperimentService({
      useRealPhase2: true,
      outcomeVerificationPort: verificationPort,
    });
    expect(admissionStack).toBeTruthy();

    const { id, decided } = await ladderToAuthorized(service, {
      sourceAssumptionSetHash: asmSet.assumptionSetHash,
    });
    expect(decided.record?.decision).toBe("APPROVE_EXPERIMENT");

    const compiled = await service.compileExecution(id);
    expect(compiled.experiment.status).toBe("AWAITING_EXECUTION_AUTHORIZATION");
    expect(compiled.lineage.compiledRunId).toBeTruthy();
    expect(compiled.lineage.phase2AdmissionOutcome).toBe("ADMITTED");
    expect(compiled.lineage.phase6AuthorizationRecordId).toBeUndefined();
    expect(compiled.lineage.executionAttemptId).toBeUndefined();

    const run = await admissionStack!.runs.getById(
      compiled.lineage.compiledRunId!,
    );
    expect(run).toBeTruthy();
    expect(run?.projectId).toBe(EXAMPLE_PROJECT_ID);

    const approvers = new InMemoryApproverAuthorizationService(
      controlPlane,
      new Set(["real_approver"]),
    );
    const sponsorPhase6 = await approvers.authorize({
      approverId: "sponsor_full",
      projectId: EXAMPLE_PROJECT_ID,
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      approvalRequest: {
        approvalRequestId: "apr_barrier",
        runId: compiled.lineage.compiledRunId!,
        projectId: EXAMPLE_PROJECT_ID,
        objectiveId: compiled.compiled.objectiveId,
        objectiveVersion: compiled.compiled.objectiveVersion,
        planId: "pl_barrier",
        planVersion: 1,
        planHash: "ph_barrier",
        repositoryCommitSha: "sha_barrier",
        repositoryFingerprint: "fp_barrier",
        policyBundleId: EXAMPLE_POLICY_BUNDLE.policyBundleId,
        policyBundleHash: EXAMPLE_POLICY_BUNDLE.policyHash,
        validationDecisionId: "vd_barrier",
        validationDecision: "HUMAN_APPROVAL_REQUIRED",
        requestReason: "EXECUTION_AUTHORIZATION",
        requestedApproverIds: ["real_approver"],
        createdAt: NOW,
        expiresAt: "2099-01-01T00:00:00.000Z",
        status: "PENDING",
        decisionCardHash: "dch_barrier",
        capabilitySetFingerprint: "cap_barrier",
        decisionNonceHash: "nonce_barrier",
      },
    });
    expect(sponsorPhase6.outcome).toBe("UNKNOWN_APPROVER");
    expect((await lineage.listByExperiment(id))[0]?.executionAttemptId).toBeUndefined();

    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_live",
        runId: compiled.lineage.compiledRunId!,
        outcome: "VERIFIED_SUCCESS",
      }),
    );
    await forceExecuting(experiments, id);
    const completed = await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.2,
          unit: "RATIO",
          sampleCount: 12,
          quality: "UNKNOWN",
          evidenceRefs: [],
          limitations: [],
        },
      ],
      outcomeVerificationIds: ["ov_live"],
    });

    expect(completed.experiment.status).toBe("COMPLETED");
    expect(completed.evidenceBundle.qualityClassification).toBe("VALIDATED");
    expect(completed.updateCandidates[0]?.requiresPhase16Reanalysis).toBe(true);
    expect(completed.updateCandidates[0]?.sourceAssumptionSetHash).toBe(
      asmSet.assumptionSetHash,
    );
    expect(assumptionSetHash(SAMPLE_ASSUMPTIONS)).toBe(asmSet.assumptionSetHash);
    expect((await updateCandidates.listByExperiment(id)).length).toBe(1);
    expect(completed.completion.terminalStatus).toBe("COMPLETED");
  });

  it("PARTIAL verified evidence widens interval without strong numeric promotion", async () => {
    const verificationPort = new FakeExperimentOutcomeVerificationPort();
    const { service, experiments } = buildExperimentService({
      outcomeVerificationPort: verificationPort,
    });
    const { id } = await ladderToAuthorized(service);
    const compiled = await service.compileExecution(id);
    verificationPort.seed(
      seedPhase8Record({
        outcomeVerificationId: "ov_partial",
        runId: compiled.lineage.compiledRunId!,
        outcome: "PARTIAL_SUCCESS",
      }),
    );
    await forceExecuting(experiments, id);
    const completed = await service.verifyAndComplete(id, {
      measurementResults: [
        {
          measurementId: `meas_${id}_primary`,
          observedValue: 1.12,
          unit: "RATIO",
          sampleCount: 10,
          quality: "VALIDATED",
          evidenceRefs: [],
          limitations: [],
        },
      ],
      outcomeVerificationIds: ["ov_partial"],
    });
    expect(completed.evidenceBundle.qualityClassification).toBe("PARTIAL");
    expect(completed.updateCandidates[0]?.revisionKind).toBe("WIDEN_INTERVAL");
    expect(completed.updateCandidates[0]?.proposedValue).toBeUndefined();
    expect(completed.updateCandidates[0]?.proposedLowerBound).toBeCloseTo(1.008);
  });

  it("ExperimentProgressionLoop is producer-only and never designs/validates", async () => {
    const { service, experiments, progression, materializer, workItems } =
      buildExperimentService();
    const admitted = await admitSampleExperiment(service);
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    const id = admitted.experiment.experimentId;
    const before = (await experiments.getById(id))!;

    await progression.tick();
    const afterTick = (await experiments.getById(id))!;
    expect(afterTick.status).toBe(before.status);
    expect(afterTick.recordRevision).toBe(before.recordRevision);
    expect(afterTick.hypotheses).toEqual([]);

    const discovered = await materializer.discoverForExperiment(id);
    const designWork = [...discovered.created, ...discovered.reused].filter(
      (w) => w.workKind === "DESIGN_EXPERIMENT",
    );
    expect(designWork.length).toBeGreaterThan(0);

    const items = await workItems.listByRun(id);
    expect(items.some((w) => w.workKind === "DESIGN_EXPERIMENT")).toBe(true);
    expect(items.every((w) => w.workKind !== "VALIDATE_EXPERIMENT")).toBe(true);

    const still = (await experiments.getById(id))!;
    expect(still.status).toBe("ADMITTED");
  });
});

describe("ExperimentExecutionCompiler verification bindings", () => {
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

  function experimentObjectiveForBindings(input: {
    compiled: ReturnType<typeof compileExperimentToObjective>["compiled"];
    experimentId: string;
    experimentPlanHash: string;
    acceptanceCriteria: readonly string[];
  }) {
    return {
      requestedOutcome: input.compiled.requestedOutcome,
      acceptanceCriteria: input.acceptanceCriteria,
      nonGoals: ["Phase 6 self-authorization", "AssumptionSet mutation"],
      constraints: [
        `experimentId=${input.experimentId}`,
        `experimentPlanHash=${input.experimentPlanHash}`,
      ],
      priority: "MEDIUM" as const,
    };
  }

  it("authorized plan compiles objective criteria with explicit bindings accepted by PlanCompiler", async () => {
    const { service, plans, authRecords, experiments } = buildExperimentService();
    const { id, decided } = await ladderToAuthorized(service);
    const plan = (await plans.getLatest(id))!;
    const authorization = (await authRecords.getLatest(id))!;
    const experiment = (await experiments.getById(id))!;

    const { compiled } = compileExperimentToObjective({
      experiment,
      plan,
      authorization: authorization!,
      compiledAt: NOW,
    });

    const acceptanceCriteria = compileExperimentAcceptanceCriteria(plan);
    expect(acceptanceCriteria).toEqual([
      EXPERIMENT_MEASUREMENT_CRITERION,
      EXPERIMENT_PHASE8_CRITERION,
    ]);

    const steps = compileExperimentExecutionSteps(plan.experimentPlanHash);
    const proposedBindings = compileExperimentVerificationBindings({
      acceptanceCriteria,
      steps,
    });
    expect(proposedBindings).toHaveLength(2);

    const objectiveForBindings = experimentObjectiveForBindings({
      compiled,
      experimentId: experiment.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
      acceptanceCriteria,
    });

    const identities =
      acceptanceCriterionIdentity.deriveFromFingerprintContent(objectiveForBindings);
    for (const binding of proposedBindings) {
      const identity = identities.find(
        (item) => item.criterionText === binding.criterionText,
      );
      expect(identity).toBeTruthy();
    }

    const proposal = parsePlanProposal({
      gapAnalysis: emptyGapAnalysis,
      workstreams: [
        {
          workstreamId: "ws_exp_test",
          name: "Bounded experiment execution",
          stepIds: steps.map((step) => step.stepId),
        },
      ],
      steps,
      successDefinition: [...acceptanceCriteria],
      assumptions: [],
      unknowns: [],
      proposedRisks: [],
      proposedVerificationChecks: [],
      proposedRollbackApproach: "Discard experiment measurement artifacts",
      proposedResourceTotals: {
        estimatedDurationMinutes: 12,
        estimatedLlmTokens: 3_000,
        estimatedApiCalls: 2,
        estimatedHumanMinutes: 8,
        estimatedCost: 0.08,
        maximumParallelWorkstreams: 1,
        estimatedLlmCalls: 2,
      },
      acceptanceCriterionVerificationBindings: proposedBindings,
      conciseRationale: "Experiment verification binding contract",
    });

    const compiledBindings = compileAcceptanceCriterionVerificationBindings({
      objective: objectiveForBindings,
      proposal,
      steps,
    });
    expect(compiledBindings).toHaveLength(2);
    expect(compiledBindings.map((b) => b.criterionId).sort()).toEqual(
      identities.map((i) => i.criterionId).sort(),
    );
    expect(
      compiledBindings.every((b) => b.verificationMethod === "STEP_POSTCONDITION"),
    ).toBe(true);
    expect(decided.record?.decision).toBe("APPROVE_EXPERIMENT");
  });

  it("criterion without binding is rejected with ACCEPTANCE_CRITERION_UNBOUND", async () => {
    const { service, plans, authRecords, experiments } = buildExperimentService();
    const { id } = await ladderToAuthorized(service);
    const plan = (await plans.getLatest(id))!;
    const authorization = (await authRecords.getLatest(id))!;
    const experiment = (await experiments.getById(id))!;

    const { compiled } = compileExperimentToObjective({
      experiment,
      plan,
      authorization: authorization!,
      compiledAt: NOW,
    });

    const acceptanceCriteria = compileExperimentAcceptanceCriteria(plan);
    const steps = compileExperimentExecutionSteps(plan.experimentPlanHash);
    const proposal = parsePlanProposal({
      gapAnalysis: emptyGapAnalysis,
      workstreams: [
        {
          workstreamId: "ws_exp_test",
          name: "Bounded experiment execution",
          stepIds: steps.map((step) => step.stepId),
        },
      ],
      steps,
      successDefinition: [...acceptanceCriteria],
      assumptions: [],
      unknowns: [],
      proposedRisks: [],
      proposedVerificationChecks: [],
      proposedRollbackApproach: "Discard experiment measurement artifacts",
      proposedResourceTotals: {
        estimatedDurationMinutes: 12,
        estimatedLlmTokens: 3_000,
        estimatedApiCalls: 2,
        estimatedHumanMinutes: 8,
        estimatedCost: 0.08,
        maximumParallelWorkstreams: 1,
        estimatedLlmCalls: 2,
      },
      acceptanceCriterionVerificationBindings: compileExperimentVerificationBindings(
        {
          acceptanceCriteria,
          steps,
        },
      ).slice(0, 1),
      conciseRationale: "Experiment verification binding contract",
    });

    const objectiveForBindings = experimentObjectiveForBindings({
      compiled,
      experimentId: experiment.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
      acceptanceCriteria,
    });

    expect(() =>
      compileAcceptanceCriterionVerificationBindings({
        objective: objectiveForBindings,
        proposal,
        steps,
      }),
    ).toThrow(PlanningError);

    try {
      compileAcceptanceCriterionVerificationBindings({
        objective: objectiveForBindings,
        proposal,
        steps,
      });
    } catch (err) {
      expect(err).toMatchObject({ code: "ACCEPTANCE_CRITERION_UNBOUND" });
    }
  });
});
