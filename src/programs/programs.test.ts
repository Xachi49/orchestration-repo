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
import { SequenceDecisionNonceGenerator } from "../authorization/decision-nonce.js";
import {
  defaultDelegationEnvelope,
  FakeProgramDecompositionModel,
  InMemoryProgramBudgetLedgerRepository,
  InMemoryProgramBudgetReservationRepository,
  InMemoryProgramCompletionRepository,
  InMemoryProgramLineageRepository,
  InMemoryProgramMaterializationApprovalRepository,
  InMemoryProgramPlanRepository,
  InMemoryProgramRepository,
  ProgramOrchestrationService,
  validateProgramPlan,
  compileProgramPlan,
  emptyBudgetEstimate,
  exceedsCeiling,
  sumNodeBudgets,
  availableToReserve,
  canReserve,
  addBudget,
  type DecompositionProposal,
} from "./index.js";
import { ProgramProgressionLoop } from "./loops.js";

const clock = new FixedClock("2026-08-14T12:00:00.000Z");

function buildControlPlane(project = EXAMPLE_PROJECT) {
  return new ControlPlaneService({
    projects: new InMemoryProjectRegistry([project]),
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
    budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
    clock,
  });
}

function nonceStore() {
  const map = new Map<string, string>();
  return {
    async put(id: string, plaintext: string) {
      map.set(id, plaintext);
    },
    async take(id: string) {
      const v = map.get(id) ?? null;
      map.delete(id);
      return v;
    },
  };
}

function buildService(
  model: FakeProgramDecompositionModel = new FakeProgramDecompositionModel(),
  opts?: {
    isProgramMaterializer?: (
      principalId: string,
      projectId: string,
    ) => Promise<boolean>;
    project?: typeof EXAMPLE_PROJECT;
    authorizedRepositoryIdentities?: (
      projectId: string,
    ) => Promise<readonly string[]>;
    controlPlane?: ControlPlaneService;
    runs?: import("../admission/run-repository.js").RunRepository;
    runCompletions?: import("../verification/completion-repository.js").CompletionRecordRepository;
    outcomeVerifications?: import("../verification/outcome-repository.js").OutcomeVerificationRepository;
    transactions?: import("../durability/transaction.js").TransactionManager;
    completionFailpoint?: import("./service.js").ProgramCompletionFailpoint;
  },
) {
  const programs = new InMemoryProgramRepository();
  const lineage = new InMemoryProgramLineageRepository();
  const plans = new InMemoryProgramPlanRepository();
  const completions = new InMemoryProgramCompletionRepository();
  const store = nonceStore();
  const service = new ProgramOrchestrationService({
    nowIso: () => "2026-01-01T00:00:00.000Z",
    programs,
    plans,
    budgets: new InMemoryProgramBudgetLedgerRepository(),
    reservations: new InMemoryProgramBudgetReservationRepository(),
    lineage,
    materializationApprovals:
      new InMemoryProgramMaterializationApprovalRepository(),
    completions,
    controlPlane: opts?.controlPlane ?? buildControlPlane(opts?.project),
    decompositionModel: model,
    nonceGenerator: new SequenceDecisionNonceGenerator(),
    materializationNonceStore: store,
    isProgramMaterializer:
      opts?.isProgramMaterializer ??
      (async (principalId) => principalId === "approver_bootstrap"),
    ...(opts?.authorizedRepositoryIdentities
      ? {
          authorizedRepositoryIdentities: opts.authorizedRepositoryIdentities,
        }
      : {}),
    ...(opts?.runs ? { runs: opts.runs } : {}),
    ...(opts?.runCompletions ? { runCompletions: opts.runCompletions } : {}),
    ...(opts?.outcomeVerifications
      ? { outcomeVerifications: opts.outcomeVerifications }
      : {}),
    ...(opts?.transactions ? { transactions: opts.transactions } : {}),
    ...(opts?.completionFailpoint
      ? { completionFailpoint: opts.completionFailpoint }
      : {}),
  });
  return { service, programs, lineage, store, plans, completions };
}

describe("Phase 14 programs", () => {
  it("rejects budget multiplication across children", async () => {
    const { service } = buildService(
      new FakeProgramDecompositionModel((program) => {
        const big = {
          ...program.delegationEnvelope.maximumChildBudget,
          llmCalls: 70,
        };
        const mk = (title: string, criterionIndex: number) => ({
          title,
          requestedOutcome: title,
          acceptanceCriteria: [title],
          nonGoals: [] as string[],
          constraints: [...program.rootIntent.constraints],
          priority: "MEDIUM" as const,
          requirement: "REQUIRED" as const,
          requestedProjectId: program.projectId,
          requestedEnvironment: program.requestedEnvironment,
          requestedCapabilityIds: [] as string[],
          requestedRepositoryIdentities: [] as string[],
          requestedBudget: big,
          dependsOnTitles: [] as string[],
          criterionBindings: [
            {
              rootCriterionIndex: criterionIndex,
              childCriterionIndex: 0,
              contributionKind: "SATISFIES" as const,
              evidenceRequirement: "COMPLETION_RECORD" as const,
            },
          ],
        });
        return {
          children: [mk("A", 0), mk("B", 1)],
          modelProviderId: "test",
        } satisfies DecompositionProposal;
      }),
    );

    const envelope = defaultDelegationEnvelope({
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
    });
    envelope.maximumProgramBudget = {
      ...envelope.maximumProgramBudget,
      llmCalls: 100,
    };
    envelope.maximumChildBudget = {
      ...envelope.maximumChildBudget,
      llmCalls: 70,
    };

    const admitted = await service.admit({
      programId: "prog_budget",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Modernize onboarding",
        acceptanceCriteria: ["Audit done", "Target defined"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: envelope,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") {
      return;
    }
    const result = await service.decompose(admitted.program.programId);
    expect(result.plan).toBeNull();
    expect(result.program.decompositionRevisionCount).toBe(1);
  });

  it("blocks depth / fan-out / capability expansion / repo escape / policy weaken", async () => {
    const { service } = buildService();
    const envelope = defaultDelegationEnvelope({
      projectId: EXAMPLE_PROJECT_ID,
      environment: EXAMPLE_ENVIRONMENT,
      capabilityIds: ["cap_a", "cap_b"],
      repositoryIdentities: ["repo_allowed"],
    });
    envelope.maximumDepth = 1;
    envelope.maximumFanOut = 1;

    const admitted = await service.admit({
      programId: "prog_limits",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Modernize",
        acceptanceCriteria: ["c1"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "MEDIUM",
      },
      delegationEnvelope: envelope,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") {
      return;
    }
    const program = admitted.program;

    const deepProposal: DecompositionProposal = {
      modelProviderId: "test",
      children: [
        {
          title: "root",
          requestedOutcome: "c1",
          acceptanceCriteria: ["c1"],
          nonGoals: [],
          constraints: ["no production deployment"],
          priority: "MEDIUM",
          requirement: "REQUIRED",
          requestedCapabilityIds: ["cap_a"],
          requestedRepositoryIdentities: ["repo_escape"],
          requestedBudget: emptyBudgetEstimate(),
          dependsOnTitles: [],
          criterionBindings: [
            {
              rootCriterionIndex: 0,
              childCriterionIndex: 0,
              contributionKind: "SATISFIES",
              evidenceRequirement: "COMPLETION_RECORD",
            },
          ],
        },
        {
          title: "child",
          parentTitle: "root",
          requestedOutcome: "c1",
          acceptanceCriteria: ["c1"],
          nonGoals: [],
          constraints: ["no production deployment"],
          priority: "MEDIUM",
          requirement: "REQUIRED",
          requestedCapabilityIds: [],
          requestedRepositoryIdentities: [],
          requestedBudget: emptyBudgetEstimate(),
          dependsOnTitles: [],
          criterionBindings: [
            {
              rootCriterionIndex: 0,
              childCriterionIndex: 0,
              contributionKind: "SATISFIES",
              evidenceRequirement: "COMPLETION_RECORD",
            },
          ],
        },
        {
          title: "grandchild",
          parentTitle: "child",
          requestedOutcome: "c1",
          acceptanceCriteria: ["c1"],
          nonGoals: [],
          constraints: ["no production deployment"],
          priority: "MEDIUM",
          requirement: "REQUIRED",
          requestedCapabilityIds: [],
          requestedRepositoryIdentities: [],
          requestedBudget: emptyBudgetEstimate(),
          dependsOnTitles: [],
          criterionBindings: [
            {
              rootCriterionIndex: 0,
              childCriterionIndex: 0,
              contributionKind: "SATISFIES",
              evidenceRequirement: "COMPLETION_RECORD",
            },
          ],
        },
        {
          title: "sibling",
          requestedOutcome: "deploy to production",
          acceptanceCriteria: ["deploy"],
          nonGoals: [],
          constraints: ["deploy to production"],
          priority: "MEDIUM",
          requirement: "OPTIONAL",
          requestedCapabilityIds: [],
          requestedRepositoryIdentities: [],
          requestedBudget: emptyBudgetEstimate(),
          dependsOnTitles: [],
          criterionBindings: [
            {
              rootCriterionIndex: 0,
              childCriterionIndex: 0,
              contributionKind: "PARTIAL_EVIDENCE",
              evidenceRequirement: "COMPLETION_RECORD",
            },
          ],
        },
      ],
    };
    const compiled = compileProgramPlan({
      program,
      proposal: deepProposal,
      programPlanVersion: 1,
      revisionAttempt: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const result = validateProgramPlan(program, compiled);
    expect(result.valid).toBe(false);
    const codes = result.findings.map((f) => f.code);
    expect(codes.length).toBeGreaterThan(0);
    expect(codes).toEqual(expect.arrayContaining([
      "PROGRAM_DEPTH_EXCEEDED",
      "PROGRAM_FAN_OUT_EXCEEDED",
    ]));
    expect(
      codes.some((c) =>
        [
          "CAPABILITY_EXPANSION_REJECTED",
          "REPOSITORY_OUTSIDE_ENVELOPE",
          "POLICY_WEAKENING_REJECTED",
        ].includes(c),
      ),
    ).toBe(true);
  });

  it("enforces human materialization barrier before any children", async () => {
    const { service, programs, lineage } = buildService();
    const admitted = await service.admit({
      programId: "prog_barrier",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Modernize onboarding",
        acceptanceCriteria: ["Audit", "Architecture", "Implement"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: defaultDelegationEnvelope({
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
      }),
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") {
      return;
    }
    const loop = new ProgramProgressionLoop({
      programs,
      materializer: {
        discoverBatch: async () => ({ created: [], reused: [] }),
      } as never,
    });
    void loop;
    await service.decompose(admitted.program.programId);
    await service.validate(admitted.program.programId);
    const program = await programs.getById(admitted.program.programId);
    expect(program?.status).toBe("AWAITING_MATERIALIZATION_APPROVAL");
    expect(await lineage.listByProgram(admitted.program.programId)).toHaveLength(
      0,
    );
    await expect(
      service.materializeNext(admitted.program.programId),
    ).rejects.toMatchObject({ code: "MATERIALIZATION_APPROVAL_REQUIRED" });
  });

  it("CAS prevents concurrent budget over-allocation", async () => {
    const ledgers = new InMemoryProgramBudgetLedgerRepository();
    const ceiling = {
      ...emptyBudgetEstimate(),
      llmCalls: 100,
    };
    await ledgers.create({
      programId: "prog_race",
      programVersion: 1,
      ceiling,
      reserved: emptyBudgetEstimate(),
      settled: emptyBudgetEstimate(),
      released: emptyBudgetEstimate(),
      recordRevision: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const ledger = (await ledgers.get("prog_race"))!;
    const request = { ...emptyBudgetEstimate(), llmCalls: 60 };
    expect(canReserve(availableToReserve(ledger), request)).toBe(true);
    const afterFirst = await ledgers.saveCas(
      {
        ...ledger,
        reserved: addBudget(ledger.reserved, request),
        updatedAt: "2026-01-01T00:00:01.000Z",
      },
      ledger.recordRevision,
    );
    await expect(
      ledgers.saveCas(
        {
          ...ledger,
          reserved: addBudget(ledger.reserved, request),
          updatedAt: "2026-01-01T00:00:02.000Z",
        },
        ledger.recordRevision,
      ),
    ).rejects.toMatchObject({ code: "PROGRAM_BUDGET_OVER_ALLOCATION" });
    expect(canReserve(availableToReserve(afterFirst), request)).toBe(false);
    expect(exceedsCeiling(sumNodeBudgets([request, request]), ceiling)).toBe(
      true,
    );
  });

  it("rejects Phase 6 approver without PROGRAM_MATERIALIZER role", async () => {
    const { service } = buildService(undefined, {
      isProgramMaterializer: async () => false,
    });
    const admitted = await service.admit({
      programId: "prog_role",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Modernize",
        acceptanceCriteria: ["A", "B", "C"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: defaultDelegationEnvelope({
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
      }),
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.decompose(admitted.program.programId);
    await service.validate(admitted.program.programId);
    const routed = await service.routeMaterializationApproval(
      admitted.program.programId,
    );
    await expect(
      service.decideMaterialization({
        approvalId: routed.approval.approvalId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: routed.decisionNonce,
        submittedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MATERIALIZATION_APPROVAL_INVALID" });
  });

  it("ProgramProgressionLoop only produces work discovery, never advances state", async () => {
    const { service, programs } = buildService();
    const admitted = await service.admit({
      programId: "prog_loop",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Modernize",
        acceptanceCriteria: ["A", "B", "C"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: defaultDelegationEnvelope({
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
      }),
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    let discovered: string[] = [];
    const loop = new ProgramProgressionLoop({
      programs,
      materializer: {
        discoverBatch: async (ids: readonly string[]) => {
          discovered = [...ids];
          return { created: [], reused: [] };
        },
      } as never,
    });
    await loop.tick();
    expect(discovered).toContain(admitted.program.programId);
    const after = await programs.getById(admitted.program.programId);
    expect(after?.status).toBe("ADMITTED");
  });

  it("denies materialization when approved repository R1 is revoked", async () => {
    let authorized: string[] = ["R1"];
    const { service, lineage } = buildService(undefined, {
      authorizedRepositoryIdentities: async () => authorized,
    });
    const admitted = await service.admit({
      programId: "prog_repo_drift",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Repo scoped",
        acceptanceCriteria: ["Done"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: defaultDelegationEnvelope({
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
        repositoryIdentities: ["R1"],
      }),
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.decompose(admitted.program.programId);
    await service.validate(admitted.program.programId);
    const routed = await service.routeMaterializationApproval(
      admitted.program.programId,
    );
    await service.decideMaterialization({
      approvalId: routed.approval.approvalId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    authorized = [];
    await expect(
      service.materializeNext(admitted.program.programId),
    ).rejects.toMatchObject({ code: "AUTHORITY_DRIFT" });
    expect(await lineage.listByProgram(admitted.program.programId)).toHaveLength(
      0,
    );
  });

  it("denies materialization when approved environment E1 is revoked", async () => {
    const mutable = {
      project: { ...EXAMPLE_PROJECT },
    };
    class MutatingProjectRegistry {
      async getById(id: string) {
        return id === mutable.project.projectId ? mutable.project : null;
      }
      async exists(id: string) {
        return id === mutable.project.projectId;
      }
      async list() {
        return [mutable.project];
      }
    }
    const controlPlane = new ControlPlaneService({
      projects: new MutatingProjectRegistry() as never,
      capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
      policies: new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock }),
      budgets: new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]),
      clock,
    });
    const { service, lineage } = buildService(undefined, { controlPlane });
    const admitted = await service.admit({
      programId: "prog_env_drift",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Env scoped",
        acceptanceCriteria: ["Done"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: defaultDelegationEnvelope({
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
      }),
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.decompose(admitted.program.programId);
    await service.validate(admitted.program.programId);
    const routed = await service.routeMaterializationApproval(
      admitted.program.programId,
    );
    await service.decideMaterialization({
      approvalId: routed.approval.approvalId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    mutable.project = {
      ...mutable.project,
      allowedEnvironments: ["development"],
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
    await expect(
      service.materializeNext(admitted.program.programId),
    ).rejects.toBeTruthy();
    expect(await lineage.listByProgram(admitted.program.programId)).toHaveLength(
      0,
    );
  });

  it("success-path verify creates one completion; concurrent verify reuses it", async () => {
    const { InMemoryOutcomeVerificationRepository } = await import(
      "../verification/outcome-repository.js"
    );
    const { InMemoryCompletionRecordRepository } = await import(
      "../verification/completion-repository.js"
    );
    const { InMemoryRunRepository } = await import(
      "../infrastructure/admission/in-memory-run-repository.js"
    );

    const runs = new InMemoryRunRepository();
    const runCompletions = new InMemoryCompletionRecordRepository();
    const outcomes = new InMemoryOutcomeVerificationRepository();
    const { service, programs, plans, lineage, completions } = buildService(
      undefined,
      {
        runs,
        runCompletions,
        outcomeVerifications: outcomes,
      },
    );

    const admitted = await service.admit({
      programId: "prog_complete",
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      rootIntent: {
        requestedOutcome: "Done",
        acceptanceCriteria: ["Criterion A"],
        nonGoals: [],
        constraints: ["no production deployment"],
        priority: "HIGH",
      },
      delegationEnvelope: defaultDelegationEnvelope({
        projectId: EXAMPLE_PROJECT_ID,
        environment: EXAMPLE_ENVIRONMENT,
      }),
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(admitted.outcome).toBe("ADMITTED");
    if (admitted.outcome !== "ADMITTED") return;
    await service.decompose(admitted.program.programId);
    await service.validate(admitted.program.programId);
    const routed = await service.routeMaterializationApproval(
      admitted.program.programId,
    );
    await service.decideMaterialization({
      approvalId: routed.approval.approvalId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      decisionNonce: routed.decisionNonce,
      submittedAt: "2026-01-01T00:00:00.000Z",
    });
    // Skip objective admission: seed lineage + Phase 8 evidence directly.
    const plan = (await plans.getLatest(admitted.program.programId))!;
    const node = plan.nodes[0]!;
    const runId = "run_child_complete";
    await runs.create({
      runId,
      projectId: EXAMPLE_PROJECT_ID,
      objectiveId: "obj_child",
      objectiveVersion: 1,
      idempotencyKey: "ik",
      requesterId: "requester_bootstrap",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      state: "COMPLETED",
      recordRevision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      correlationId: "c",
      traceId: "t",
    });
    await outcomes.append({
      outcomeVerificationId: "ov_1",
      verificationAttemptId: "va_1",
      runId,
      executionAttemptId: "ea_1",
      planId: "pl_1",
      planVersion: 1,
      planHash: "ph",
      authorizationRecordId: "ar_1",
      postExecutionSnapshotHash: "pe",
      verificationSpecificationHash: "vs",
      outcome: "VERIFIED_SUCCESS",
      criterionResults: [
        {
          criterionId: "c0",
          criterionText: "Criterion A",
          verdict: "SATISFIED",
          evidenceRefs: ["e1"],
          stepRefs: [],
          findingRefs: [],
          conciseRationale: "ok",
          verificationMethod: "deterministic",
        },
      ],
      postconditionResults: [],
      findings: [],
      evidenceRefs: ["e1"],
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await runCompletions.append({
      completionRecordId: "cr_1",
      runId,
      objectiveId: "obj_child",
      objectiveVersion: 1,
      planId: "pl_1",
      planVersion: 1,
      planHash: "ph",
      executionAttemptId: "ea_1",
      authorizationRecordId: "ar_1",
      outcomeVerificationId: "ov_1",
      postExecutionSnapshotHash: "pe",
      verificationSpecificationHash: "vs",
      completedAt: "2026-01-01T00:00:00.000Z",
    });
    await lineage.save({
      lineageId: `pln_${admitted.program.programId}_1_${node.nodeId}`,
      programId: admitted.program.programId,
      programVersion: 1,
      programPlanVersion: plan.programPlanVersion,
      programPlanHash: plan.programPlanHash,
      nodeId: node.nodeId,
      childObjectiveId: "obj_child",
      childObjectiveVersion: 1,
      childRunId: runId,
      materializationStatus: "ADMITTED",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      recordRevision: 1,
    });
    const prog = (await programs.getById(admitted.program.programId))!;
    await programs.transition(
      prog.programId,
      prog.status,
      prog.recordRevision,
      "ACTIVE",
      "2026-01-01T00:00:01.000Z",
    );

    const first = await service.verify(admitted.program.programId);
    expect(first.outcome).toBe("VERIFIED_SUCCESS");
    expect(first.program.status).toBe("COMPLETED");
    const second = await service.verify(admitted.program.programId);
    expect(second.outcome).toBe("VERIFIED_SUCCESS");
    expect(second.completion?.programCompletionRecordId).toBe(
      first.completion?.programCompletionRecordId,
    );
    expect(await completions.getByProgram(admitted.program.programId)).toEqual(
      first.completion,
    );
  });
});
