/**
 * Governed same-objective run replacement.
 *
 * OBJECTIVE REVISION != RUN REPLACEMENT.
 * RUN-SCOPED BUDGET != UNBOUNDED BUDGET RENEWAL.
 * In-memory composers are not the atomicity authority; Postgres tests are.
 */
import { describe, expect, it } from "vitest";
import { PROJECT_OBJECTIVE_SUBMITTED } from "../admission/event-store.js";
import { PROJECT_RUN_REPLACEMENT_ADMITTED } from "../admission/event-store.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../admission/fixtures.js";
import { reconcilePersistedRun } from "../admission/run-repository.js";
import { commitRunTransition } from "../admission/run-transition.js";
import { buildServer } from "../api/server.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import { InMemoryAuthorizationRecordRepository } from "../authorization/authorization-record-repository.js";
import { InMemoryApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { objectiveFingerprint } from "../domain/objective/fingerprint.js";
import { objectiveIdempotencyKey } from "../domain/objective/idempotency.js";
import {
  runReplacementIdempotencyKey,
  runReplacementMaterialFingerprint,
} from "../domain/run/replacement-identity.js";
import { InMemoryExecutionAttemptRepository } from "../execution/attempt-repository.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";
import { InMemoryRunRepository } from "../infrastructure/admission/in-memory-run-repository.js";
import { UuidAdmissionIdentityGenerator } from "../infrastructure/admission/identity.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_LEAD_CREATED_AT,
  RR_MONDAY_IN_WINDOW,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import type { PlanningFence } from "../planning/coordinator.js";
import { InMemoryPlanningCoordinator } from "../planning/coordinator.js";
import {
  aggregatePlanningUsage,
  InMemoryPlanningUsageLedger,
  type PlanningModelUsage,
} from "../planning/model.js";
import { InMemoryPlanRepository } from "../planning/plan-repository.js";
import type { StoredPlanRecord } from "../planning/plan-repository.js";
import { FakeRequestAuthenticator } from "../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../runtime/access.js";
import { DrainController } from "../runtime/startup.js";
import { OperationalMetrics } from "../runtime/metrics.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../runtime/rate-limit.js";
import {
  candidateWorkKinds,
  DISCOVERABLE_RUN_STATES,
} from "../scheduling/discovery-map.js";
import { parseRecoveryAttempt } from "./recovery-attempt.js";
import {
  assertReplacementPlanningEvidence,
  RecoveryRunReplacementService,
  type RecoveryRunReplacementOrchestratorPorts,
} from "./run-replacement.js";

const NOW = RR_MONDAY_IN_WINDOW;
const REASON = "SYSTEM_DEFECT_RETRY" as const;

function settledUsage(input: {
  callId: string;
  runId: string;
  operation: "GAP_ANALYSIS" | "PLAN_PROPOSAL";
  totalUsage: number;
}): PlanningModelUsage {
  return {
    callId: input.callId,
    runId: input.runId,
    planningAttempt: 1,
    operation: input.operation,
    provider: "fake",
    model: "fake",
    reservedTokens: 100,
    totalUsage: input.totalUsage,
    inputUsage: 50,
    outputUsage: input.totalUsage - 50,
    startedAt: NOW,
    completedAt: NOW,
    status: "SUCCESS",
    charging: "ACTUAL",
  };
}

function failedFence(runId: string, failureCode: string): PlanningFence {
  return {
    runId,
    status: "FAILED",
    attempt: 1,
    lastUpdatedAt: NOW,
    failureCode,
    failedAt: NOW,
    retryable: true,
  };
}

describe("run attempt hydration and ordinary admission", () => {
  it("hydrates a historical payload without runAttempt as attempt 1", () => {
    const historical = {
      runId: "run_hist",
      projectId: "proj",
      objectiveId: "obj",
      objectiveVersion: 2,
      idempotencyKey: "key",
      requesterId: "user",
      requestedEnvironment: "local",
      state: "PLANNING",
      createdAt: NOW,
      updatedAt: NOW,
      correlationId: "corr",
      traceId: "trace",
    };
    const run = reconcilePersistedRun({
      payload: historical,
      runAttempt: 1,
      recordRevision: 4,
    });
    expect(run.runAttempt).toBe(1);
    expect(run.recordRevision).toBe(4);
  });

  it("fails closed when the payload runAttempt disagrees with the column", () => {
    expect(() =>
      reconcilePersistedRun({
        payload: {
          runId: "run_hist",
          projectId: "proj",
          objectiveId: "obj",
          objectiveVersion: 2,
          runAttempt: 2,
          idempotencyKey: "key",
          requesterId: "user",
          requestedEnvironment: "local",
          state: "PLANNING",
          recordRevision: 1,
          createdAt: NOW,
          updatedAt: NOW,
          correlationId: "corr",
          traceId: "trace",
        },
        runAttempt: 1,
        recordRevision: 1,
      }),
    ).toThrow(/disagrees/);
  });

  it("ordinary admission creates attempt 1 and duplicate admission converges", async () => {
    const { service, runs } = createLocalAdmissionStack({ clockIso: NOW });
    const request = exampleAdmissionRequest();
    const first = await service.admit(request);
    const second = await service.admit(request);
    expect(first.outcome).toBe("ADMITTED");
    expect(second.outcome).toBe("ACTIVE_DUPLICATE");
    if (first.outcome !== "ADMITTED" || second.outcome !== "ACTIVE_DUPLICATE") {
      return;
    }
    expect(second.runId).toBe(first.runId);
    const run = await runs.getById(first.runId);
    expect(run?.runAttempt).toBe(1);
    expect(run?.idempotencyKey).toBe(
      objectiveIdempotencyKey({
        projectId: request.projectId,
        objectiveId: request.objectiveId,
        objectiveVersion: request.objectiveVersion,
        requestedEnvironment: request.requestedEnvironment,
      }),
    );
    expect(await runs.listByProject(request.projectId)).toHaveLength(1);
  });

  it("stores a distinct replacement idempotency identity", () => {
    const ordinary = objectiveIdempotencyKey({
      projectId: "proj",
      objectiveId: "obj",
      objectiveVersion: 2,
      requestedEnvironment: "local",
    });
    const replacement = runReplacementIdempotencyKey({
      projectId: "proj",
      objectiveId: "obj",
      objectiveVersion: 2,
      requestedEnvironment: "local",
      predecessorRunId: "run_pred",
      replacementReason: "SYSTEM_DEFECT_RETRY",
    });
    expect(replacement).not.toBe(ordinary);
    expect(
      runReplacementIdempotencyKey({
        projectId: "proj",
        objectiveId: "obj",
        objectiveVersion: 2,
        requestedEnvironment: "local",
        predecessorRunId: "run_pred",
        replacementReason: "SYSTEM_DEFECT_RETRY",
      }),
    ).toBe(replacement);
    expect(
      runReplacementMaterialFingerprint({
        objectiveFingerprint: "fp-a",
        predecessorRunId: "run_pred",
        replacementReason: "SYSTEM_DEFECT_RETRY",
        objectiveId: "obj",
        objectiveVersion: 2,
        requestedEnvironment: "local",
        projectId: "proj",
      }),
    ).not.toBe(
      runReplacementMaterialFingerprint({
        objectiveFingerprint: "fp-b",
        predecessorRunId: "run_pred",
        replacementReason: "SYSTEM_DEFECT_RETRY",
        objectiveId: "obj",
        objectiveVersion: 2,
        requestedEnvironment: "local",
        projectId: "proj",
      }),
    );
  });

  it("permits attempt 2 for the same objective identity and rejects a duplicate attempt", async () => {
    const runs = new InMemoryRunRepository();
    const base = {
      projectId: "proj",
      objectiveId: "obj",
      objectiveVersion: 2,
      requestedEnvironment: "local",
      requesterId: "user",
      state: "ADMITTED" as const,
      recordRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      correlationId: "corr",
      traceId: "trace",
    };
    await runs.create({
      ...base,
      runId: "run_1",
      runAttempt: 1,
      idempotencyKey: "adm",
    });
    await runs.create({
      ...base,
      runId: "run_2",
      runAttempt: 2,
      idempotencyKey: "repl",
    });
    await expect(
      runs.create({
        ...base,
        runId: "run_2b",
        runAttempt: 2,
        idempotencyKey: "repl-2",
      }),
    ).rejects.toThrow(/logical run identity/);
    expect(
      await runs.maxRunAttempt({
        projectId: "proj",
        objectiveId: "obj",
        objectiveVersion: 2,
        requestedEnvironment: "local",
      }),
    ).toBe(2);
  });

  it("does not rediscover a SUPERSEDED predecessor", () => {
    expect(candidateWorkKinds({ runState: "SUPERSEDED" })).toEqual([]);
    expect(DISCOVERABLE_RUN_STATES).not.toContain("SUPERSEDED");
    expect(DISCOVERABLE_RUN_STATES).not.toContain("PLANNING");
  });
});

describe("planning evidence", () => {
  const budget = EXAMPLE_BUDGET;
  const usage = [
    settledUsage({
      callId: "c1",
      runId: "run",
      operation: "GAP_ANALYSIS",
      totalUsage: 100_000,
    }),
    settledUsage({
      callId: "c2",
      runId: "run",
      operation: "PLAN_PROPOSAL",
      totalUsage: 100_000,
    }),
  ];

  it("accepts settled token exhaustion with calls remaining", () => {
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage,
        budget,
      }),
    ).not.toThrow();
  });

  it("accepts a token-reservation failure whose remaining tokens exceed one output cap", () => {
    const partialBudget = {
      ...EXAMPLE_BUDGET,
      maximumTotalTokens: 50_000,
      maximumLlmCalls: 10,
    };
    const charged = settledUsage({
      callId: "c1",
      runId: "run",
      operation: "GAP_ANALYSIS",
      totalUsage: 30_000,
    });
    const aggregate = aggregatePlanningUsage([charged]);
    const remaining =
      partialBudget.maximumTotalTokens - aggregate.completedActualTokens;
    expect(remaining).toBe(20_000);
    expect(remaining).toBeGreaterThan(4097);
    expect(aggregate.llmCalls).toBeLessThan(partialBudget.maximumLlmCalls);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [charged],
        budget: partialBudget,
      }),
    ).not.toThrow();
  });

  it("rejects an unproven, call-limit, reserved, uncharged, or invariant ledger", () => {
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: null,
        usage,
        budget,
      }),
    ).toThrow(/does not prove/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_INVALID_OUTPUT"),
        usage,
        budget,
      }),
    ).toThrow(/does not prove/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: { ...failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"), retryable: false },
        usage,
        budget,
      }),
    ).toThrow(/does not prove/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [{ ...usage[0]!, status: "STARTED", totalUsage: undefined }],
        budget,
      }),
    ).toThrow(/active reservation/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [{ ...usage[0]!, totalUsage: 0 }],
        budget,
      }),
    ).toThrow(/no settled consumption/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [],
        budget,
      }),
    ).toThrow(/no settled consumption/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [{ ...usage[0]!, budgetInvariantViolation: true }],
        budget,
      }),
    ).toThrow(/invariant/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [usage[0]!],
        budget: { ...budget, maximumLlmCalls: 1 },
      }),
    ).toThrow(/call limit/);
    expect(() =>
      assertReplacementPlanningEvidence({
        fence: failedFence("run", "PLANNING_MODEL_BUDGET_EXCEEDED"),
        usage: [
          {
            ...usage[0]!,
            budgetProfileId: "budget_other",
          } as (typeof usage)[number],
        ],
        budget,
      }),
    ).toThrow(/different budget profile/);
  });
});

type Harness = Awaited<ReturnType<typeof eligibleHarness>>;

async function seedConsumption(
  usage: InMemoryPlanningUsageLedger,
  runId: string,
  totals: readonly number[],
  budget = EXAMPLE_BUDGET,
) {
  const operations = ["GAP_ANALYSIS", "PLAN_PROPOSAL"] as const;
  for (let i = 0; i < totals.length; i += 1) {
    const operation = operations[i] ?? "GAP_ANALYSIS";
    const reserved = await usage.reserve({
      callId: `${runId}_${operation}_${i}`,
      runId,
      planningAttempt: 1,
      operation,
      provider: "fake",
      model: "fake",
      reservedTokens: 100,
      startedAt: NOW,
      maximumLlmCalls: budget.maximumLlmCalls,
      maximumTotalTokens: budget.maximumTotalTokens,
      budgetProfileId: budget.budgetProfileId,
    });
    await usage.settle(reserved.callId, {
      outcome: "SUCCESS",
      completedAt: NOW,
      charging: "ACTUAL",
      totalUsage: totals[i]!,
      inputUsage: 50,
      outputUsage: totals[i]! - 50,
    });
  }
}

async function markBudgetFailed(
  planning: InMemoryPlanningCoordinator,
  runId: string,
  failureCode = "PLANNING_MODEL_BUDGET_EXCEEDED",
) {
  const begin = await planning.begin(runId, NOW);
  if (begin.outcome !== "STARTED") {
    throw new Error("expected a new planning fence");
  }
  await planning.markFailed(runId, begin.ownerToken, {
    failureCode,
    failedAt: NOW,
    retryable: true,
  });
}

async function eligibleHarness(options?: {
  budget?: typeof EXAMPLE_BUDGET;
  toPlanning?: boolean;
  consume?: readonly number[];
  failureCode?: string | null;
}) {
  const budget = options?.budget ?? EXAMPLE_BUDGET;
  const admission = createLocalAdmissionStack({
    clockIso: NOW,
    budgets: [budget],
  });
  const plans = new InMemoryPlanRepository();
  const approvalRequests = new InMemoryApprovalRequestRepository();
  const authorizationRecords = new InMemoryAuthorizationRecordRepository();
  const executionAttempts = new InMemoryExecutionAttemptRepository();
  const planning = new InMemoryPlanningCoordinator();
  const usage = new InMemoryPlanningUsageLedger();
  const orchestrator: RecoveryRunReplacementOrchestratorPorts = {
    runs: admission.runs,
    objectives: admission.objectives,
    plans,
    approvalRequests,
    authorizationRecords,
    executionAttempts,
    planning,
    usage,
    controlPlane: admission.controlPlane,
    events: admission.events,
    idempotency: admission.idempotency,
    locks: admission.locks,
  };
  const product = createMemoryRevenueRecoveryService({
    nowIso: () => NOW,
    admission: admission.service,
    orchestrator,
    runReplacement: {
      identities: new UuidAdmissionIdentityGenerator(),
      orchestrator,
    },
  });
  const { service, repos } = product;
  await service.putConfiguration(
    demoRecoveryConfig({
      timezone: "UTC",
      contactWindow: {
        startHourLocal: 9,
        endHourLocal: 17,
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      cooldownMinutes: 0,
    }),
  );
  const { lead } = await service.ingestLead(
    demoLead({ createdAt: RR_LEAD_CREATED_AT }),
  );
  const opened = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  if (!opened.recoveryCase) throw new Error("expected recovery case");
  const recoveryCaseId = opened.recoveryCase.recoveryCaseId;
  await repos.cases.save({
    ...opened.recoveryCase,
    recoveryObjectiveVersion: 2,
    recordRevision: opened.recoveryCase.recordRevision + 1,
    updatedAt: NOW,
  });
  await service.prepareRecoveryObjective({
    recoveryCaseId,
    requesterId: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    admit: true,
  });
  const bound = await repos.cases.getById(recoveryCaseId);
  const runId = bound?.orchestratorRunId;
  if (!runId) throw new Error("expected bound run");
  const objectiveId = `obj_rr_${recoveryCaseId}`;
  if (options?.toPlanning !== false) {
    let run = await admission.runs.getById(runId);
    if (!run) throw new Error("missing run");
    run = await commitRunTransition(admission.runs, run, "INGESTING", NOW);
    await commitRunTransition(admission.runs, run, "PLANNING", NOW);
    if (options?.failureCode !== null) {
      await markBudgetFailed(
        planning,
        runId,
        options?.failureCode ?? "PLANNING_MODEL_BUDGET_EXCEEDED",
      );
    }
    await seedConsumption(
      usage,
      runId,
      options?.consume ?? [100_000, 100_000],
      budget,
    );
  }
  const body = {
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    reason: REASON,
  };
  return {
    admission,
    planning,
    usage,
    plans,
    approvalRequests,
    authorizationRecords,
    executionAttempts,
    orchestrator,
    service,
    repos,
    recoveryCaseId,
    runId,
    objectiveId,
    body,
    product,
  };
}

function directService(
  h: Harness,
  overrides: Partial<{
    orchestrator: RecoveryRunReplacementOrchestratorPorts;
    attempts: { listByCase: (id: string) => Promise<readonly never[]> };
    audits: Harness["repos"]["audits"];
  }> = {},
) {
  return new RecoveryRunReplacementService({
    nowIso: () => NOW,
    cases: h.repos.cases,
    attempts: overrides.attempts ?? h.repos.attempts,
    audits: overrides.audits ?? h.repos.audits,
    orchestrator: overrides.orchestrator ?? h.orchestrator,
    identities: new UuidAdmissionIdentityGenerator(),
    withReplacementLock: (_id, fn) => fn(),
  });
}

describe("governed run replacement", () => {
  it("replaces an eligible PLANNING run with attempt 2 on the same objective", async () => {
    const h = await eligibleHarness();
    const before = await h.admission.objectives.getById(h.objectiveId, 2);
    const beforeFingerprint = objectiveFingerprint({
      requestedOutcome: before!.requestedOutcome,
      acceptanceCriteria: before!.acceptanceCriteria,
      nonGoals: before!.nonGoals,
      constraints: before!.constraints,
      priority: before!.priority,
    });
    const predecessorUsage = await h.usage.listByRunId(h.runId);
    const predecessorKey = (await h.admission.runs.getById(h.runId))!
      .idempotencyKey;

    await expect(
      h.service.reissueRecoveryObjective({
        recoveryCaseId: h.recoveryCaseId,
        body: {
          customerAccountId: RR_CUSTOMER,
          projectId: RR_PROJECT,
          reason: "OBJECTIVE_MAPPING_CORRECTION",
        },
      }),
    ).rejects.toMatchObject({ code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE" });

    const result = await h.service.replaceRecoveryRun({
      recoveryCaseId: h.recoveryCaseId,
      body: h.body,
      principalId: "operator_test",
    });
    expect(result).toMatchObject({
      outcome: "REPLACED",
      objectiveId: h.objectiveId,
      objectiveVersion: 2,
      predecessorRunId: h.runId,
      predecessorRunAttempt: 1,
      predecessorRunState: "SUPERSEDED",
      replacementRunAttempt: 2,
      replacementRunState: "ADMITTED",
      reason: REASON,
    });
    expect(result.replacementRunId).not.toBe(h.runId);

    const predecessor = await h.admission.runs.getById(h.runId);
    const replacement = await h.admission.runs.getById(result.replacementRunId);
    expect(predecessor?.state).toBe("SUPERSEDED");
    expect(predecessor?.idempotencyKey).toBe(predecessorKey);
    expect(predecessorKey).toBe(
      objectiveIdempotencyKey({
        projectId: RR_PROJECT,
        objectiveId: h.objectiveId,
        objectiveVersion: 2,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
      }),
    );
    expect(replacement?.runAttempt).toBe(2);
    expect(replacement?.state).toBe("ADMITTED");
    expect(replacement?.idempotencyKey).not.toBe(predecessorKey);
    expect(replacement?.idempotencyKey).toBe(
      runReplacementIdempotencyKey({
        projectId: RR_PROJECT,
        objectiveId: h.objectiveId,
        objectiveVersion: 2,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        predecessorRunId: h.runId,
        replacementReason: REASON,
      }),
    );

    const after = await h.admission.objectives.getById(h.objectiveId, 2);
    expect(after).toEqual(before);
    expect(
      objectiveFingerprint({
        requestedOutcome: after!.requestedOutcome,
        acceptanceCriteria: after!.acceptanceCriteria,
        nonGoals: after!.nonGoals,
        constraints: after!.constraints,
        priority: after!.priority,
      }),
    ).toBe(beforeFingerprint);
    const bound = await h.admission.objectives.getByRunBinding(
      result.replacementRunId,
    );
    expect(bound?.objectiveVersion).toBe(2);
    expect(bound).toEqual(before);

    const recoveryCase = await h.repos.cases.getById(h.recoveryCaseId);
    expect(recoveryCase?.orchestratorRunId).toBe(result.replacementRunId);
    expect(recoveryCase?.recoveryObjectiveVersion).toBe(2);

    expect(await h.plans.listByRunId(result.replacementRunId)).toEqual([]);
    expect(await h.approvalRequests.listByRun(result.replacementRunId)).toEqual([]);
    expect(
      await h.authorizationRecords.listByRun(result.replacementRunId),
    ).toEqual([]);
    expect(await h.executionAttempts.listByRun(result.replacementRunId)).toEqual(
      [],
    );
    expect(
      (await h.repos.attempts.listByCase(h.recoveryCaseId)).filter(
        (attempt) => attempt.runId === result.replacementRunId,
      ),
    ).toEqual([]);
    expect(await h.usage.listByRunId(h.runId)).toEqual(predecessorUsage);
    expect(await h.usage.listByRunId(result.replacementRunId)).toEqual([]);

    const predecessorEvents = await h.admission.events.listByRunId(h.runId);
    const replacementEvents = await h.admission.events.listByRunId(
      result.replacementRunId,
    );
    expect(predecessorEvents.map((event) => event.eventType)).toEqual([
      PROJECT_OBJECTIVE_SUBMITTED,
    ]);
    expect(replacementEvents.map((event) => event.eventType)).toEqual([
      PROJECT_RUN_REPLACEMENT_ADMITTED,
    ]);

    const audits = (await h.repos.audits.listByCase(h.recoveryCaseId)).filter(
      (event) => event.kind === "RECOVERY_RUN_REPLACED",
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({
      principalId: "operator_test",
      predecessorRunId: h.runId,
      replacementRunId: result.replacementRunId,
      objectiveVersion: 2,
      reason: REASON,
    });

    const replay = await h.service.replaceRecoveryRun({
      recoveryCaseId: h.recoveryCaseId,
      body: h.body,
    });
    expect(replay).toMatchObject({
      outcome: "ALREADY_REPLACED",
      replacementRunId: result.replacementRunId,
      replacementRunAttempt: 2,
    });
    expect(
      (await h.repos.audits.listByCase(h.recoveryCaseId)).filter(
        (event) => event.kind === "RECOVERY_RUN_REPLACED",
      ),
    ).toHaveLength(1);
    expect(
      await h.admission.runs.maxRunAttempt({
        projectId: RR_PROJECT,
        objectiveId: h.objectiveId,
        objectiveVersion: 2,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
      }),
    ).toBe(2);
  });

  it("does not mint attempt 3 after the one SYSTEM_DEFECT_RETRY", async () => {
    const h = await eligibleHarness();
    const first = await h.service.replaceRecoveryRun({
      recoveryCaseId: h.recoveryCaseId,
      body: h.body,
    });
    const moved = await h.repos.cases.compareAndSetOrchestratorRunBinding({
      recoveryCaseId: h.recoveryCaseId,
      expectedOrchestratorRunId: first.replacementRunId,
      expectedObjectiveVersion: 2,
      expectedRecordRevision: (await h.repos.cases.getById(h.recoveryCaseId))!
        .recordRevision,
      orchestratorRunId: "run_not_the_replacement",
      objectiveId: h.objectiveId,
      objectiveVersion: 2,
      updatedAt: NOW,
    });
    expect(moved).not.toBeNull();
    await expect(
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: h.body,
      }),
    ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_LIMIT_REACHED" });
    expect(
      await h.admission.runs.maxRunAttempt({
        projectId: RR_PROJECT,
        objectiveId: h.objectiveId,
        objectiveVersion: 2,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
      }),
    ).toBe(2);
  });

  it("converges concurrent replacement requests onto one run", async () => {
    const h = await eligibleHarness();
    const [a, b] = await Promise.all([
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: h.body,
      }),
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: h.body,
      }),
    ]);
    expect(a.replacementRunId).toBe(b.replacementRunId);
    expect(new Set([a.outcome, b.outcome])).toEqual(
      new Set(["REPLACED", "ALREADY_REPLACED"]),
    );
    expect(
      (await h.admission.runs.listByProject(RR_PROJECT)).filter(
        (run) => run.objectiveId === h.objectiveId,
      ),
    ).toHaveLength(2);
  });

  it("blocks ineligible predecessors", async () => {
    const admitted = await eligibleHarness({ toPlanning: false });
    await expect(
      admitted.service.replaceRecoveryRun({
        recoveryCaseId: admitted.recoveryCaseId,
        body: admitted.body,
      }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_NOT_ELIGIBLE",
      details: { reasonCode: "PREDECESSOR_NOT_PLANNING" },
    });

    const wrongCode = await eligibleHarness({
      failureCode: "PLANNING_MODEL_INVALID_OUTPUT",
    });
    await expect(
      wrongCode.service.replaceRecoveryRun({
        recoveryCaseId: wrongCode.recoveryCaseId,
        body: wrongCode.body,
      }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_NOT_ELIGIBLE",
      details: { reasonCode: "PLANNING_FAILURE_UNPROVEN" },
    });

    const partialRemaining = await eligibleHarness({
      budget: {
        ...EXAMPLE_BUDGET,
        maximumTotalTokens: 50_000,
        maximumLlmCalls: 10,
      },
      consume: [30_000],
    });
    const partial = await partialRemaining.service.replaceRecoveryRun({
      recoveryCaseId: partialRemaining.recoveryCaseId,
      body: partialRemaining.body,
    });
    expect(partial).toMatchObject({
      outcome: "REPLACED",
      predecessorRunState: "SUPERSEDED",
      replacementRunState: "ADMITTED",
      replacementRunAttempt: 2,
      objectiveVersion: 2,
    });

    const callLimit = await eligibleHarness({
      budget: { ...EXAMPLE_BUDGET, maximumLlmCalls: 1 },
      consume: [100],
    });
    await expect(
      callLimit.service.replaceRecoveryRun({
        recoveryCaseId: callLimit.recoveryCaseId,
        body: callLimit.body,
      }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_NOT_ELIGIBLE",
      details: { reasonCode: "PLANNING_FAILURE_UNPROVEN" },
    });

    const h = await eligibleHarness();
    await expect(
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: { ...h.body, projectId: "other-project" },
      }),
    ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });
    await expect(
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: { ...h.body, reason: "OBJECTIVE_MAPPING_CORRECTION" },
      }),
    ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_INVALID" });
    await expect(
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: { ...h.body, predecessorRunId: h.runId },
      }),
    ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_INVALID" });

    const stale = await h.repos.cases.getById(h.recoveryCaseId);
    await h.repos.cases.compareAndSetOrchestratorRunBinding({
      recoveryCaseId: h.recoveryCaseId,
      expectedOrchestratorRunId: h.runId,
      expectedObjectiveVersion: 2,
      expectedRecordRevision: stale!.recordRevision,
      orchestratorRunId: "run_missing",
      objectiveId: h.objectiveId,
      objectiveVersion: 2,
      updatedAt: NOW,
    });
    await expect(
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: h.body,
      }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_NOT_ELIGIBLE",
      details: { reasonCode: "PREDECESSOR_NOT_FOUND" },
    });
  });

  it("blocks plans, approvals, authorization, execution, and recovery attempts", async () => {
    const h = await eligibleHarness();
    const withPlan = directService(h, {
      orchestrator: {
        ...h.orchestrator,
        plans: {
          listByRunId: async () => [{ runId: h.runId } as StoredPlanRecord],
        },
      },
    });
    await expect(
      withPlan.replace({ recoveryCaseId: h.recoveryCaseId, body: h.body }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_NOT_ELIGIBLE",
      details: { reasonCode: "PLAN_PRESENT" },
    });

    const withApproval = directService(h, {
      orchestrator: {
        ...h.orchestrator,
        approvalRequests: {
          listByRun: async () => [{ runId: h.runId } as never],
        },
      },
    });
    await expect(
      withApproval.replace({ recoveryCaseId: h.recoveryCaseId, body: h.body }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_NOT_ELIGIBLE",
      details: { reasonCode: "APPROVAL_PRESENT" },
    });

    const withAuth = directService(h, {
      orchestrator: {
        ...h.orchestrator,
        authorizationRecords: {
          listByRun: async () => [{ runId: h.runId } as never],
        },
      },
    });
    await expect(
      withAuth.replace({ recoveryCaseId: h.recoveryCaseId, body: h.body }),
    ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_AUTHORITY_PRESENT" });

    const withExecution = directService(h, {
      orchestrator: {
        ...h.orchestrator,
        executionAttempts: {
          listByRun: async () => [{ runId: h.runId } as never],
        },
      },
    });
    await expect(
      withExecution.replace({ recoveryCaseId: h.recoveryCaseId, body: h.body }),
    ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_AUTHORITY_PRESENT" });

    const recoveryCase = await h.repos.cases.getById(h.recoveryCaseId);
    await h.repos.attempts.save(
      parseRecoveryAttempt({
        attemptId: "ratt_test",
        recoveryCaseId: h.recoveryCaseId,
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        leadId: recoveryCase!.leadId,
        runId: h.runId,
        executionAttemptId: "ex_1",
        stepId: "step_1",
        executionActionIdentity: "rex_1",
        providerIdempotencyKey: "pid_1",
        channel: "EMAIL",
        recipientRef: "alex@example.com",
        sentAt: NOW,
        deliveryOutcome: "SIMULATED",
        recordRevision: 1,
      }),
    );
    await expect(
      h.service.replaceRecoveryRun({
        recoveryCaseId: h.recoveryCaseId,
        body: h.body,
      }),
    ).rejects.toMatchObject({
      code: "RUN_REPLACEMENT_AUTHORITY_PRESENT",
      details: { reasonCode: "RECOVERY_ATTEMPT_PRESENT" },
    });
    expect(await h.admission.runs.getById(h.runId)).toMatchObject({
      state: "PLANNING",
    });
  });

  it("returns 503 when replacement is not configured", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => NOW,
    });
    await expect(
      service.replaceRecoveryRun({
        recoveryCaseId: "rcase_x",
        body: {
          customerAccountId: RR_CUSTOMER,
          projectId: RR_PROJECT,
          reason: REASON,
        },
      }),
    ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_UNAVAILABLE" });
  });
});

describe("run replacement HTTP", () => {
  const principal = "operator_replacement";

  function perimeter(projectIds: readonly string[]) {
    return {
      authenticator: new FakeRequestAuthenticator({
        principalId: principal,
        authenticationMode: "STATIC_PRINCIPAL" as const,
      }),
      access: new InMemoryProjectAccessDirectory([
        { principalId: principal, projectIds },
      ]),
      drain: new DrainController(),
      metrics: new OperationalMetrics(),
      logger: new MemoryStructuredLogger("rr_replace", () => undefined),
      rateLimiter: new SlidingWindowRateLimiter(120, 60_000),
      authenticationMode: "STATIC_PRINCIPAL" as const,
    };
  }

  it("201 on replacement, 200 on replay, 409 when ineligible, 400 on unknown fields", async () => {
    const h = await eligibleHarness();
    const app = await buildServer({
      revenueRecovery: h.service,
      perimeter: perimeter([RR_PROJECT]),
    });
    const url = `/v1/revenue-recovery/cases/${h.recoveryCaseId}/run-replacement`;
    const created = await app.inject({
      method: "POST",
      url,
      payload: h.body,
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().outcome).toBe("REPLACED");
    expect(created.json().objectiveVersion).toBe(2);
    const replay = await app.inject({ method: "POST", url, payload: h.body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      outcome: "ALREADY_REPLACED",
      replacementRunId: created.json().replacementRunId,
    });
    const smuggled = await app.inject({
      method: "POST",
      url,
      payload: { ...h.body, predecessorRunId: h.runId },
    });
    expect(smuggled.statusCode).toBe(400);
    expect(smuggled.json().error).toBe("RUN_REPLACEMENT_INVALID");
    await app.close();

    const blocked = await eligibleHarness({ toPlanning: false });
    const blockedApp = await buildServer({
      revenueRecovery: blocked.service,
      perimeter: perimeter([RR_PROJECT]),
    });
    const ineligible = await blockedApp.inject({
      method: "POST",
      url: `/v1/revenue-recovery/cases/${blocked.recoveryCaseId}/run-replacement`,
      payload: blocked.body,
    });
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json().error).toBe("RUN_REPLACEMENT_NOT_ELIGIBLE");
    await blockedApp.close();
  });

  it("denies a principal without project access", async () => {
    const h = await eligibleHarness();
    const app = await buildServer({
      revenueRecovery: h.service,
      perimeter: perimeter(["other-project"]),
    });
    const denied = await app.inject({
      method: "POST",
      url: `/v1/revenue-recovery/cases/${h.recoveryCaseId}/run-replacement`,
      payload: h.body,
    });
    expect(denied.statusCode).toBe(403);
    expect((await h.admission.runs.getById(h.runId))?.state).toBe("PLANNING");
    await app.close();
  });

  it("503 when the composer does not wire replacement", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => NOW,
    });
    const app = await buildServer({ revenueRecovery: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/cases/rcase_x/run-replacement",
      payload: {
        customerAccountId: RR_CUSTOMER,
        projectId: EXAMPLE_PROJECT_ID,
        reason: REASON,
      },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("RUN_REPLACEMENT_UNAVAILABLE");
    await app.close();
  });
});
