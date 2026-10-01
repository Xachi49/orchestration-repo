/**
 * Objective reissue after governed approved-plan repair.
 *
 * HISTORICAL APPROVAL != EFFECTIVE AUTHORITY.
 * SUPERSEDED PLAN AUTHORIZATION != EXECUTABLE AUTHORIZATION.
 * LATEST REJECT != HISTORICAL APPROVE.
 * IMMUTABLE HISTORY != PERMANENT REISSUE POISON.
 *
 * Reproduces the pilot history: v1 APPROVE → v1 SUPERSEDED by repair →
 * v2 REJECT → run REJECTED, with zero execution.
 */
import { describe, expect, it } from "vitest";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import { assessHistoricalExecutionAuthority } from "../authorization/historical-authority.js";
import { addMsIso } from "../authorization/identity.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import type { AuthorizationRecord } from "../domain/authorization/index.js";
import type { ExecutionAttempt } from "../domain/execution/attempt.js";
import { Sha256PlanHasher } from "../domain/plan/plan-hasher.js";
import { ExecutionReadinessService } from "../execution/readiness.js";
import { FakeSafeActuator } from "../infrastructure/execution/actuators.js";
import { createLocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_LEAD_CREATED_AT,
  RR_MONDAY_IN_WINDOW,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import {
  ApprovedPlanRepairService,
  InMemoryApprovedPlanRepairCoordinator,
} from "../planning/approved-plan-repair.js";
import type { RecoveryObjectiveReissueOrchestratorPorts } from "./objective-reissue.js";
import { RevenueRecoveryPhase7Actuator } from "./phase7-actuator.js";
import {
  createRecoveryEmailPlanningModel,
  RECOVERY_EMAIL_POSTCONDITION,
  type RecoveryEmailPlanBinding,
} from "./recovery-email-planning-model.js";
import { RevenueRecoveryTargetBinder } from "./target-binder.js";

const REASON = "OBJECTIVE_MAPPING_CORRECTION";

/**
 * Admit → plan v1 → validate → APPROVE v1 → failed structural execute fence
 * (no ExecutionAttempt) → governed repair supersedes v1 → validate v2 →
 * route v2 → REJECT (or let v2 expire).
 */
async function repairedPilotRun(finish: "REJECT" | "EXPIRE" = "REJECT") {
  const binding: RecoveryEmailPlanBinding = {
    recoveryCaseId: "",
    leadId: "",
    templateId: "",
    templateVersion: 1,
  };
  const delivery = new FakeApprovalDeliveryService();
  const actuator = new FakeSafeActuator();
  const stack = createLocalExecutionStack({
    projects: [{ ...EXAMPLE_PROJECT, executionMode: "SUPERVISED" }],
    planningModel: createRecoveryEmailPlanningModel(binding),
    actuator,
    approvalDelivery: delivery,
    clockIso: RR_MONDAY_IN_WINDOW,
  });
  // Mutable so a test can substitute a single evidence port after setup.
  const ports: RecoveryObjectiveReissueOrchestratorPorts = {
    runs: stack.runs,
    objectives: stack.objectives,
    plans: stack.plans,
    approvalRequests: stack.approvalRequests,
    authorizationRecords: stack.authorizationRecords,
    executionAttempts: stack.executionAttempts,
  };
  const product = createMemoryRevenueRecoveryService({
    nowIso: () => RR_MONDAY_IN_WINDOW,
    admission: stack.admission,
    orchestrator: ports,
  });
  const { service, repos } = product;
  actuator.attachRevenueRecovery(new RevenueRecoveryPhase7Actuator(service));

  await service.putConfiguration(
    demoRecoveryConfig({
      timezone: "UTC",
      contactWindow: { startHourLocal: 9, endHourLocal: 17, daysOfWeek: [1, 2, 3, 4, 5] },
      cooldownMinutes: 0,
      allowedChannels: ["EMAIL"],
      maxEmailAttempts: 1,
    }),
  );
  const template = await service.saveTemplate({
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    channel: "EMAIL",
    version: 1,
    body: "Hi {{firstName}} — checking in from {{businessName}}.",
    allowedVariables: ["firstName", "businessName"],
    enabled: true,
  });
  const { lead } = await service.ingestLead(
    demoLead({ createdAt: RR_LEAD_CREATED_AT }),
  );
  const opened = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  const recoveryCaseId = opened.recoveryCase!.recoveryCaseId;
  Object.assign(binding, {
    recoveryCaseId,
    leadId: lead.leadId,
    templateId: template.templateId,
  });
  const binder = new RevenueRecoveryTargetBinder({
    runs: stack.runs,
    objectives: stack.objectives,
    cases: repos.cases,
    leads: repos.leads,
    templates: repos.templates,
  });
  stack.planning.bindRecoveryTargetBinder(binder);

  const objectiveId = `obj_rr_${recoveryCaseId}`;
  const admitted = await stack.admission.admit(
    exampleAdmissionRequest({
      objectiveId,
      requestedOutcome: "Recover one unanswered inbound lead",
      acceptanceCriteria: [RECOVERY_EMAIL_POSTCONDITION],
      constraints: ["Allowed channels: SMS,EMAIL,CALL_TASK", "Max SMS attempts: 3"],
    }),
  );
  if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
  const runId = admitted.runId;
  const fresh = (await repos.cases.getById(recoveryCaseId))!;
  await repos.cases.save({
    ...fresh,
    status: "IN_ORCHESTRATION",
    objectiveId,
    orchestratorRunId: runId,
    updatedAt: RR_MONDAY_IN_WINDOW,
    recordRevision: fresh.recordRevision + 1,
  });
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);

  // v1: structurally unexecutable targets, as in the repair incident fixture.
  const planned = (await stack.plans.getByRunId(runId))!;
  const brokenSteps = planned.plan.steps.map((s) =>
    s.actionType === "SEND_RECOVERY_EMAIL" ? { ...s, targetIds: [] as string[] } : s,
  );
  const forHash = { ...planned.plan, steps: brokenSteps };
  delete (forHash as { planHash?: string }).planHash;
  const brokenHash = new Sha256PlanHasher().hash(forHash);
  await stack.plans.save({
    ...planned,
    plan: { ...planned.plan, steps: brokenSteps, planHash: brokenHash },
    planHash: brokenHash,
  });
  await stack.validation.validate(runId);
  const routedV1 = await stack.authorizationRouting.route(runId);
  if (routedV1.outcome !== "PENDING_APPROVAL") throw new Error("v1 not routed");
  await stack.humanAuthorization.decide({
    approvalRequestId: routedV1.approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    submittedAt: stack.clock.nowIso(),
    decisionNonce: delivery.nonceFor(routedV1.approvalRequestId)!,
  });
  const v1Authz = (await stack.authorizationRecords.getLatestByRun(runId))!;
  const v1Plan = (await stack.plans.getByRunId(runId))!;

  // Failed structural execute: fence only, never an ExecutionAttempt.
  const fenceKey = {
    runId,
    planId: v1Plan.planId,
    planVersion: v1Plan.planVersion,
    planHash: v1Plan.planHash,
    authorizationRecordId: v1Authz.authorizationRecordId,
  };
  const begin = await stack.executionCoordinator.begin(fenceKey, stack.clock.nowIso());
  if (begin.outcome !== "STARTED") throw new Error("expected STARTED fence");
  await stack.executionCoordinator.markFailed(
    fenceKey,
    begin.ownerToken,
    stack.clock.nowIso(),
    "EXECUTION_ARGUMENT_INVALID",
  );

  const repair = new ApprovedPlanRepairService({
    runs: stack.runs,
    plans: stack.plans,
    authorizationRecords: stack.authorizationRecords,
    approvalRequests: stack.approvalRequests,
    executionAttempts: stack.executionAttempts,
    executionCoordinator: stack.executionCoordinator,
    recoveryAttempts: repos.attempts,
    recoveryTargetBinder: binder,
    coordinator: new InMemoryApprovedPlanRepairCoordinator(),
    clock: stack.clock,
    identities: { nextPlanId: () => "plan_repaired_v2" },
  });
  const repaired = await repair.repairApprovedPlan({
    runId,
    reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
  });
  if (repaired.outcome !== "REPAIRED") throw new Error("repair failed");

  stack.validation.bindRecoveryTargetBinder(binder);
  await stack.validation.validate(runId);
  const routedV2 = await stack.authorizationRouting.route(runId);
  if (routedV2.outcome !== "PENDING_APPROVAL") {
    throw new Error(`v2 not routed: ${routedV2.outcome}`);
  }
  if (finish === "REJECT") {
    await stack.humanAuthorization.decide({
      approvalRequestId: routedV2.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "REJECT",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: delivery.nonceFor(routedV2.approvalRequestId)!,
    });
  } else {
    const pending = (await stack.approvalRequests.getById(routedV2.approvalRequestId))!;
    await stack.approvalExpiry.expireDueRequests(addMsIso(pending.expiresAt, 1));
  }

  async function history() {
    return {
      run: await stack.runs.getById(runId),
      objective: await stack.objectives.getByRunBinding(runId),
      plans: await stack.plans.listByRunId(runId),
      validations: await stack.validationDecisions.listByRunId(runId),
      approvals: await stack.approvalRequests.listByRun(runId),
      records: await stack.authorizationRecords.listByRun(runId),
      attempts: await stack.executionAttempts.listByRun(runId),
      fence: await stack.executionCoordinator.get(fenceKey),
    };
  }

  function reissue() {
    return service.reissueRecoveryObjective({
      recoveryCaseId,
      body: { customerAccountId: RR_CUSTOMER, projectId: RR_PROJECT, reason: REASON },
      principalId: "operator_authority_test",
    });
  }

  async function expectNothingReissued(caseBefore: unknown) {
    expect(await repos.cases.getById(recoveryCaseId)).toEqual(caseBefore);
    expect(await stack.objectives.getById(objectiveId, 2)).toBeNull();
    expect(
      repos.audits.listAll().filter((e) => e.kind === "RECOVERY_OBJECTIVE_REISSUED"),
    ).toEqual([]);
  }

  return {
    ...product,
    stack,
    ports,
    delivery,
    lead,
    recoveryCaseId,
    objectiveId,
    runId,
    v1Authz,
    v1Plan,
    v1ApprovalRequestId: routedV1.approvalRequestId,
    v2ApprovalRequestId: routedV2.approvalRequestId,
    v2PlanId: repaired.repairedPlanId,
    history,
    reissue,
    expectNothingReissued,
  };
}

type Pilot = Awaited<ReturnType<typeof repairedPilotRun>>;

describe("objective reissue — pilot history (v1 APPROVE → superseded → v2 REJECT)", () => {
  it("reproduces the pilot history exactly", async () => {
    const p = await repairedPilotRun();
    const h = await p.history();
    expect(h.run!.state).toBe("REJECTED");
    expect(h.plans.map((x) => [x.planVersion, x.status])).toEqual([
      [1, "SUPERSEDED"],
      [2, expect.not.stringMatching(/^SUPERSEDED$/)],
    ]);
    expect(h.approvals.map((a) => [a.approvalRequestId, a.status])).toEqual([
      [p.v1ApprovalRequestId, "APPROVED"],
      [p.v2ApprovalRequestId, "REJECTED"],
    ]);
    expect(h.records.map((r) => [r.approvalRequestId, r.decision])).toEqual([
      [p.v1ApprovalRequestId, "APPROVE"],
      [p.v2ApprovalRequestId, "REJECT"],
    ]);
    expect(h.attempts).toEqual([]);
    expect(await p.repos.attempts.listByCase(p.recoveryCaseId)).toEqual([]);
    expect(p.messaging.sent).toHaveLength(0);
  });

  it("allows reissue and leaves every historical artifact byte-for-byte unchanged", async () => {
    const p = await repairedPilotRun();
    const before = JSON.stringify(await p.history());

    const result = await p.reissue();

    expect(result).toMatchObject({
      outcome: "REISSUED",
      sourceObjectiveVersion: 1,
      targetObjectiveVersion: 2,
      predecessorRunId: p.runId,
      replacementRunState: "ADMITTED",
    });
    expect(JSON.stringify(await p.history())).toBe(before);

    const audit = p.repos.audits
      .listAll()
      .filter((e) => e.kind === "RECOVERY_OBJECTIVE_REISSUED");
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload).toMatchObject({
      predecessorRunState: "REJECTED",
      predecessorAuthority: "HISTORICAL_SUPERSEDED_APPROVE_ONLY",
      admissionOutcome: "ADMITTED",
      replacementRunId: result.replacementRunId,
    });

    const v2 = await p.stack.objectives.getByRunBinding(result.replacementRunId);
    expect(v2!.constraints).toContain("Allowed channels: EMAIL");
    expect(v2!.constraints.some((c) => /\bSMS\b/.test(c))).toBe(false);
    expect(await p.repos.cases.getById(p.recoveryCaseId)).toMatchObject({
      orchestratorRunId: result.replacementRunId,
      recoveryObjectiveVersion: 2,
    });
  });

  it("the replacement inherits no authority and old authority stays unusable", async () => {
    const p = await repairedPilotRun();
    const v1Nonce = p.delivery.nonceFor(p.v1ApprovalRequestId)!;
    const { replacementRunId } = await p.reissue();

    expect(await p.stack.plans.listByRunId(replacementRunId)).toEqual([]);
    expect(await p.stack.approvalRequests.listByRun(replacementRunId)).toEqual([]);
    expect(await p.stack.authorizationRecords.listByRun(replacementRunId)).toEqual([]);
    expect(await p.stack.executionAttempts.listByRun(replacementRunId)).toEqual([]);
    expect((await p.stack.executionReadiness.assess(replacementRunId)).ready).toBe(false);
    expect((await p.stack.executionReadiness.assess(p.runId)).ready).toBe(false);
    const recordsBefore = await p.stack.authorizationRecords.listByRun(p.runId);
    // Replaying the spent v1 nonce is an idempotent no-op, not new authority.
    const replay = await p.stack.humanAuthorization.decide({
      approvalRequestId: p.v1ApprovalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: p.stack.clock.nowIso(),
      decisionNonce: v1Nonce,
    });
    expect(replay).toMatchObject({ result: "ALREADY_DECIDED", runState: "REJECTED" });
    expect(await p.stack.authorizationRecords.listByRun(p.runId)).toEqual(recordsBefore);
    expect(await p.stack.authorizationRecords.listByRun(replacementRunId)).toEqual([]);
    expect((await p.stack.runs.getById(p.runId))!.state).toBe("REJECTED");
    expect(p.messaging.sent).toHaveLength(0);
  });

  it("a repeated call is ALREADY_REISSUED, not a second replacement", async () => {
    const p = await repairedPilotRun();
    const first = await p.reissue();
    const second = await p.reissue();
    expect(second).toEqual({ ...first, outcome: "ALREADY_REISSUED" });
    expect(await p.stack.objectives.getById(p.objectiveId, 3)).toBeNull();
  });
});

describe("Phase 7 consistency — historical v1 APPROVE is non-executable", () => {
  function readinessWith(p: Pilot, overrides: Partial<ConstructorParameters<typeof ExecutionReadinessService>[0]>) {
    return new ExecutionReadinessService({
      runs: p.stack.runs,
      plans: p.stack.plans,
      objectives: p.stack.objectives,
      controlPlane: p.stack.controlPlane,
      locks: p.stack.locks,
      authorizationRecords: p.stack.authorizationRecords,
      approvalRequests: p.stack.approvalRequests,
      clockNowIso: () => p.stack.clock.nowIso(),
      ...overrides,
    });
  }

  it("fails independently on run state, latest decision, and stale v1 binding", async () => {
    const p = await repairedPilotRun();

    // Real state: run is REJECTED.
    expect(await p.stack.executionReadiness.assess(p.runId)).toMatchObject({
      ready: false,
      code: "RUN_NOT_APPROVED",
    });

    const pretendApproved = {
      getById: async (id: string) => {
        const run = await p.stack.runs.getById(id);
        return run ? { ...run, state: "APPROVED" as const } : run;
      },
    } as unknown as typeof p.stack.runs;

    // Even if the run were APPROVED, the latest record is REJECT.
    expect(
      await readinessWith(p, { runs: pretendApproved }).assess(p.runId),
    ).toMatchObject({ ready: false, code: "AUTHORIZATION_NOT_APPROVE" });

    // Even if v1 APPROVE were latest, it is bound to a stale plan.
    const v1Latest = Object.create(p.stack.authorizationRecords, {
      getLatestByRun: { value: async () => p.v1Authz },
    }) as typeof p.stack.authorizationRecords;
    const staleBinding = await readinessWith(p, {
      runs: pretendApproved,
      authorizationRecords: v1Latest,
    }).assess(p.runId);
    expect(staleBinding).toMatchObject({
      ready: false,
      code: "AUTHORIZATION_BINDING_MISMATCH",
    });

    // And if v1 were read as the current plan, it is SUPERSEDED.
    const v1Current = Object.create(p.stack.plans, {
      getByRunId: { value: async () => p.stack.plans.getById(p.v1Plan.planId) },
    }) as typeof p.stack.plans;
    expect(
      await readinessWith(p, {
        runs: pretendApproved,
        authorizationRecords: v1Latest,
        plans: v1Current,
      }).assess(p.runId),
    ).toMatchObject({ ready: false, code: "PLAN_SUPERSEDED" });

    // The reissue guard classifies the same history as historical only.
    const h = await p.history();
    expect(
      assessHistoricalExecutionAuthority({
        runId: p.runId,
        authorizationRecords: h.records,
        approvalRequests: h.approvals,
        plans: h.plans,
      }),
    ).toEqual({
      kind: "HISTORICAL_SUPERSEDED_APPROVE_ONLY",
      authorizationRecordIds: [p.v1Authz.authorizationRecordId],
      approvalRequestIds: [p.v1ApprovalRequestId],
    });
  });
});

describe("objective reissue — hard blocks still hold on the pilot history", () => {
  async function expectAuthorityPresent(
    p: Pilot,
    details: Record<string, unknown>,
  ) {
    const caseBefore = await p.repos.cases.getById(p.recoveryCaseId);
    const before = JSON.stringify(await p.history());
    await expect(p.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
      details: { predecessorRunId: p.runId, ...details },
    });
    await p.expectNothingReissued(caseBefore);
    expect(JSON.stringify(await p.history())).toBe(before);
  }

  it("blocks when the latest AuthorizationRecord is APPROVE", async () => {
    const p = await repairedPilotRun();
    const real = p.stack.authorizationRecords;
    p.ports.authorizationRecords = {
      listByRun: async (runId) => {
        const records = await real.listByRun(runId);
        return [
          ...records,
          { ...records[1]!, authorizationRecordId: "authz_late", decision: "APPROVE" },
        ];
      },
    };
    await expectAuthorityPresent(p, {
      authorityState: "CURRENT_APPROVE",
      reasonCode: "LATEST_AUTHORIZATION_APPROVE",
    });
  });

  it("blocks an EXPIRED predecessor whose latest record is still the v1 APPROVE", async () => {
    // Expiry writes no AuthorizationRecord: v1 APPROVE remains latest.
    const p = await repairedPilotRun("EXPIRE");
    const h = await p.history();
    expect(h.run!.state).toBe("EXPIRED");
    expect(h.records.map((r) => r.decision)).toEqual(["APPROVE"]);
    await expectAuthorityPresent(p, {
      authorityState: "CURRENT_APPROVE",
      reasonCode: "LATEST_AUTHORIZATION_APPROVE",
    });
  });

  it("allows an EXPIRED predecessor whose historical APPROVE is followed by a non-APPROVE decision", async () => {
    const p = await repairedPilotRun("EXPIRE");
    const real = p.stack.authorizationRecords;
    // Later REQUEST_MODIFICATION on another request, then expiry.
    p.ports.authorizationRecords = {
      listByRun: async (runId) => [
        ...(await real.listByRun(runId)),
        {
          ...p.v1Authz,
          authorizationRecordId: "authz_modify",
          approvalRequestId: p.v2ApprovalRequestId,
          decision: "REQUEST_MODIFICATION",
        } as AuthorizationRecord,
      ],
    };
    const result = await p.reissue();
    expect(result.outcome).toBe("REISSUED");
    expect(
      p.repos.audits.listAll().find((e) => e.kind === "RECOVERY_OBJECTIVE_REISSUED")!
        .payload,
    ).toMatchObject({
      predecessorRunState: "EXPIRED",
      predecessorAuthority: "HISTORICAL_SUPERSEDED_APPROVE_ONLY",
    });
  });

  it("blocks when the historical APPROVE is bound to a non-superseded plan", async () => {
    const p = await repairedPilotRun();
    const real = p.stack.plans;
    p.ports.plans = {
      listByRunId: async (runId) =>
        (await real.listByRunId(runId)).map((plan) =>
          plan.planId === p.v1Plan.planId
            ? { ...plan, status: "VALIDATED_APPROVAL_REQUIRED" as const }
            : plan,
        ),
    };
    await expectAuthorityPresent(p, {
      authorityState: "CURRENT_APPROVE",
      reasonCode: "APPROVE_BOUND_TO_NON_SUPERSEDED_PLAN",
    });
  });

  it("blocks when the historical APPROVE's plan is missing", async () => {
    const p = await repairedPilotRun();
    const real = p.stack.plans;
    p.ports.plans = {
      listByRunId: async (runId) =>
        (await real.listByRunId(runId)).filter((plan) => plan.planId !== p.v1Plan.planId),
    };
    await expectAuthorityPresent(p, {
      authorityState: "AMBIGUOUS",
      reasonCode: "APPROVED_PLAN_MISSING",
    });
  });

  it("blocks when the historical APPROVE's plan binding is ambiguous", async () => {
    const p = await repairedPilotRun();
    const real = p.stack.plans;
    p.ports.plans = {
      listByRunId: async (runId) =>
        (await real.listByRunId(runId)).map((plan) =>
          plan.planId === p.v1Plan.planId ? { ...plan, planHash: "hash_drifted" } : plan,
        ),
    };
    await expectAuthorityPresent(p, {
      authorityState: "AMBIGUOUS",
      reasonCode: "APPROVED_PLAN_BINDING_INCONSISTENT",
    });
  });

  it("blocks an APPROVED ApprovalRequest bound to the current, non-superseded plan", async () => {
    const p = await repairedPilotRun();
    const real = p.stack.approvalRequests;
    p.ports.approvalRequests = {
      listByRun: async (runId) => {
        const requests = await real.listByRun(runId);
        const v2 = requests.find((r) => r.approvalRequestId === p.v2ApprovalRequestId)!;
        return [...requests, { ...v2, approvalRequestId: "apr_current", status: "APPROVED" }];
      },
    };
    await expectAuthorityPresent(p, {
      authorityState: "AMBIGUOUS",
      reasonCode: "APPROVED_REQUEST_WITHOUT_APPROVE_RECORD",
    });
  });

  it("a PENDING ApprovalRequest remains NOT_ELIGIBLE", async () => {
    const p = await repairedPilotRun();
    const real = p.stack.approvalRequests;
    p.ports.approvalRequests = {
      listByRun: async (runId) => {
        const requests = await real.listByRun(runId);
        const v2 = requests.find((r) => r.approvalRequestId === p.v2ApprovalRequestId)!;
        return [...requests, { ...v2, approvalRequestId: "apr_pending", status: "PENDING" }];
      },
    };
    const caseBefore = await p.repos.cases.getById(p.recoveryCaseId);
    await expect(p.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE",
      details: { reasonCode: "PREDECESSOR_APPROVAL_PENDING" },
    });
    await p.expectNothingReissued(caseBefore);
  });

  it("an ExecutionAttempt still blocks", async () => {
    const p = await repairedPilotRun();
    p.ports.executionAttempts = {
      listByRun: async (runId) => [
        { runId, executionAttemptId: "exa_x" } as unknown as ExecutionAttempt,
      ],
    };
    await expectAuthorityPresent(p, {});
  });

  it("a RecoveryAttempt attributable to the predecessor still blocks", async () => {
    const p = await repairedPilotRun();
    await p.repos.attempts.save({
      attemptId: "rra_pilot",
      recoveryCaseId: p.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: p.lead.leadId,
      runId: p.runId,
      executionAttemptId: "exa_pilot",
      stepId: "step_recovery_email",
      executionActionIdentity: "rr_action_pilot",
      providerIdempotencyKey: "rr_idem_pilot",
      channel: "EMAIL",
      recipientRef: "recipient_ref",
      sentAt: RR_MONDAY_IN_WINDOW,
      deliveryOutcome: "SIMULATED",
      recordRevision: 1,
    });
    await expectAuthorityPresent(p, {});
  });
});
