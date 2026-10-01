/**
 * Governed Revenue Recovery objective reissue.
 *
 * OBJECTIVE V1 != OBJECTIVE V2. RUN A != RUN B.
 * AUTHORITY FOR RUN A != AUTHORITY FOR RUN B.
 * REPLACEMENT RUN != REUSE OF PREDECESSOR AUTHORIZATION.
 * CASE POINTER != HISTORY. IDEMPOTENCY != UNBOUNDED REISSUE.
 */
import { describe, expect, it } from "vitest";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { AdmissionResult } from "../admission/result.js";
import { buildServer } from "../api/server.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import type { AuthorizationRecord } from "../domain/authorization/authorization-record.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import { addMsIso } from "../authorization/identity.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import type { ExecutionAttempt } from "../domain/execution/attempt.js";
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
import { FakePlanningModel } from "../planning/fake-planning-model.js";
import type { PlanningModelOutput } from "../planning/model.js";
import { parsePlanProposal, type PlanProposal } from "../planning/proposal.js";
import { proposeBindingsForSteps } from "../planning/verification-bindings.js";
import { FakeRequestAuthenticator } from "../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../runtime/access.js";
import { DrainController } from "../runtime/startup.js";
import { OperationalMetrics } from "../runtime/metrics.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../runtime/rate-limit.js";
import type { RecoveryObjectiveReissueOrchestratorPorts } from "./objective-reissue.js";
import { RevenueRecoveryPhase7Actuator } from "./phase7-actuator.js";
import {
  createRecoveryEmailPlanningModel,
  RECOVERY_EMAIL_POSTCONDITION,
  type RecoveryEmailPlanBinding,
} from "./recovery-email-planning-model.js";
import { RevenueRecoveryTargetBinder } from "./target-binder.js";

const REASON = "OBJECTIVE_MAPPING_CORRECTION";
const PRINCIPAL = "operator_reissue_test";

/** Pre-fix v1 content: names channels the EMAIL-only case never permitted. */
const LEGACY_V1 = {
  requestedOutcome: "Recover one unanswered inbound lead",
  acceptanceCriteria: [RECOVERY_EMAIL_POSTCONDITION],
  nonGoals: ["Contacting leads who opted out"],
  constraints: ["Allowed channels: SMS,EMAIL,CALL_TASK", "Max SMS attempts: 3"],
};

/**
 * The fixture EMAIL planner only declares its own postcondition; declare the
 * objective's criteria instead so canonical v2 objectives plan end to end.
 */
class CriteriaBoundEmailPlanningModel extends FakePlanningModel {
  constructor(private readonly inner: FakePlanningModel) {
    super();
  }

  override async proposePlan(
    input: Parameters<FakePlanningModel["proposePlan"]>[0],
  ): Promise<PlanningModelOutput<PlanProposal>> {
    const output = await this.inner.proposePlan(input);
    const acceptanceCriteria = input.context.objective.acceptanceCriteria;
    const steps = output.value.steps.map((step) => ({
      ...step,
      expectedPostconditions: [...acceptanceCriteria],
    }));
    return {
      ...output,
      value: parsePlanProposal({
        ...output.value,
        steps,
        acceptanceCriterionVerificationBindings: proposeBindingsForSteps({
          acceptanceCriteria,
          steps,
        }),
      }),
    };
  }
}

type HarnessOptions = {
  orchestrator?: (
    base: RecoveryObjectiveReissueOrchestratorPorts,
  ) => RecoveryObjectiveReissueOrchestratorPorts;
  admission?: (base: ObjectiveAdmissionService) => {
    admit(input: unknown): Promise<AdmissionResult>;
  };
};

/**
 * EMAIL-only case bound to a v1 run with legacy objective content, routed to
 * AWAITING_APPROVAL exactly as the pilot was before the mapping fix.
 */
async function reissueHarness(options: HarnessOptions = {}) {
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
    planningModel: new CriteriaBoundEmailPlanningModel(
      createRecoveryEmailPlanningModel(binding),
    ),
    actuator,
    approvalDelivery: delivery,
    clockIso: RR_MONDAY_IN_WINDOW,
  });
  const basePorts: RecoveryObjectiveReissueOrchestratorPorts = {
    runs: stack.runs,
    objectives: stack.objectives,
    plans: stack.plans,
    approvalRequests: stack.approvalRequests,
    authorizationRecords: stack.authorizationRecords,
    executionAttempts: stack.executionAttempts,
  };
  const admission = options.admission
    ? (options.admission(stack.admission) as unknown as ObjectiveAdmissionService)
    : stack.admission;
  const productClock = { now: RR_MONDAY_IN_WINDOW };
  const product = createMemoryRevenueRecoveryService({
    nowIso: () => productClock.now,
    admission,
    orchestrator: options.orchestrator
      ? options.orchestrator(basePorts)
      : basePorts,
  });
  actuator.attachRevenueRecovery(
    new RevenueRecoveryPhase7Actuator(product.service),
  );
  const binder = new RevenueRecoveryTargetBinder({
    runs: stack.runs,
    objectives: stack.objectives,
    cases: product.repos.cases,
    leads: product.repos.leads,
    templates: product.repos.templates,
  });
  stack.planning.bindRecoveryTargetBinder(binder);
  stack.validation.bindRecoveryTargetBinder(binder);

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
  if (!opened.recoveryCase) throw new Error("expected an open recovery case");
  const recoveryCaseId = opened.recoveryCase.recoveryCaseId;
  Object.assign(binding, {
    recoveryCaseId,
    leadId: lead.leadId,
    templateId: template.templateId,
  });

  const objectiveId = `obj_rr_${recoveryCaseId}`;
  const admitted = await stack.admission.admit(
    exampleAdmissionRequest({ objectiveId, ...LEGACY_V1 }),
  );
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const runId = admitted.runId;
  const fresh = await repos.cases.getById(recoveryCaseId);
  await repos.cases.save({
    ...fresh!,
    status: "IN_ORCHESTRATION",
    objectiveId,
    orchestratorRunId: runId,
    updatedAt: RR_MONDAY_IN_WINDOW,
    recordRevision: fresh!.recordRevision + 1,
  });
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  await stack.planning.plan(runId);
  await stack.validation.validate(runId);
  const routed = await stack.authorizationRouting.route(runId);
  if (routed.outcome !== "PENDING_APPROVAL") {
    throw new Error(`expected PENDING_APPROVAL, got ${routed.outcome}`);
  }

  async function decide(decision: "APPROVE" | "REJECT") {
    const nonce = delivery.nonceFor(routed.approvalRequestId);
    if (!nonce) throw new Error("missing decision nonce");
    return stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision,
      submittedAt: stack.clock.nowIso(),
      decisionNonce: nonce,
    });
  }

  async function expire() {
    const pending = await stack.approvalRequests.getById(
      routed.approvalRequestId,
    );
    await stack.approvalExpiry.expireDueRequests(
      addMsIso(pending!.expiresAt, 1),
    );
  }

  function reissue(
    body: Record<string, unknown> = {
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      reason: REASON,
    },
  ) {
    return service.reissueRecoveryObjective({
      recoveryCaseId,
      body,
      principalId: PRINCIPAL,
    });
  }

  async function predecessorSnapshot() {
    return {
      run: await stack.runs.getById(runId),
      objective: await stack.objectives.getById(objectiveId, 1),
      binding: await stack.objectives.getByRunBinding(runId),
      plans: await stack.plans.listByRunId(runId),
      decisions: await stack.validationDecisions.listByRunId(runId),
      approvals: await stack.approvalRequests.listByRun(runId),
      records: await stack.authorizationRecords.listByRun(runId),
    };
  }

  function reissueAudits() {
    return repos.audits
      .listAll()
      .filter((e) => e.kind === "RECOVERY_OBJECTIVE_REISSUED");
  }

  return {
    ...product,
    productClock,
    stack,
    delivery,
    binder,
    binding,
    template,
    lead,
    recoveryCaseId,
    objectiveId,
    runId,
    approvalRequestId: routed.approvalRequestId,
    decide,
    expire,
    reissue,
    predecessorSnapshot,
    reissueAudits,
  };
}

type Harness = Awaited<ReturnType<typeof reissueHarness>>;

async function expectNoReissueMutation(h: Harness, caseBefore: unknown) {
  expect(await h.repos.cases.getById(h.recoveryCaseId)).toEqual(caseBefore);
  expect(await h.stack.objectives.getById(h.objectiveId, 2)).toBeNull();
  expect(h.reissueAudits()).toEqual([]);
}

describe("objective reissue — corrected objective + replacement run", () => {
  it("REJECTED predecessor: mints corrected v2 and a new run; v1 history is untouched", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const before = await h.predecessorSnapshot();
    // A REJECT AuthorizationRecord is history, not authority.
    expect(before.records.map((r) => r.decision)).toEqual(["REJECT"]);
    const caseBefore = (await h.repos.cases.getById(h.recoveryCaseId))!;
    const leadBefore = await h.repos.leads.getById(h.lead.leadId);
    const healthBefore = h.service.getPilotHealth();

    const result = await h.reissue();

    expect(result).toMatchObject({
      outcome: "REISSUED",
      recoveryCaseId: h.recoveryCaseId,
      objectiveId: h.objectiveId,
      sourceObjectiveVersion: 1,
      targetObjectiveVersion: 2,
      predecessorRunId: h.runId,
      replacementRunState: "ADMITTED",
      reason: REASON,
    });
    expect(result.replacementRunId).not.toBe(h.runId);

    const v2 = await h.stack.objectives.getByRunBinding(result.replacementRunId);
    expect(v2).toMatchObject({ objectiveId: h.objectiveId, objectiveVersion: 2 });
    expect(v2!.constraints).toContain("Allowed channels: EMAIL");
    expect(v2!.constraints).toContain("Max email attempts: 1");
    expect(v2!.constraints.some((c) => /\bSMS\b/.test(c))).toBe(false);
    const replacementRun = await h.stack.runs.getById(result.replacementRunId);
    expect(replacementRun).toMatchObject({
      objectiveId: h.objectiveId,
      objectiveVersion: 2,
      state: "ADMITTED",
      requesterId: before.run!.requesterId,
      requestedEnvironment: before.run!.requestedEnvironment,
    });

    // Predecessor: same state, objective, plan, validation, approval, records.
    expect(await h.predecessorSnapshot()).toEqual(before);
    expect(before.run!.state).toBe("REJECTED");
    expect(before.objective!.constraints).toEqual(LEGACY_V1.constraints);

    const caseAfter = (await h.repos.cases.getById(h.recoveryCaseId))!;
    expect(caseAfter).toMatchObject({
      status: "IN_ORCHESTRATION",
      objectiveId: h.objectiveId,
      orchestratorRunId: result.replacementRunId,
      recoveryObjectiveVersion: 2,
      recordRevision: caseBefore.recordRevision + 1,
      leadId: caseBefore.leadId,
      customerAccountId: caseBefore.customerAccountId,
      projectId: caseBefore.projectId,
    });

    // No side effects: no send, attempt, approval, execution, consent, or mode change.
    expect(h.messaging.sent).toHaveLength(0);
    expect(await h.repos.attempts.listByCase(h.recoveryCaseId)).toEqual([]);
    expect(await h.stack.plans.listByRunId(result.replacementRunId)).toEqual([]);
    expect(
      await h.stack.approvalRequests.listByRun(result.replacementRunId),
    ).toEqual([]);
    expect(
      await h.stack.authorizationRecords.listByRun(result.replacementRunId),
    ).toEqual([]);
    expect(
      await h.stack.executionAttempts.listByRun(result.replacementRunId),
    ).toEqual([]);
    expect(await h.repos.leads.getById(h.lead.leadId)).toEqual(leadBefore);
    expect(h.service.getPilotHealth()).toEqual(healthBefore);
  });

  it("EXPIRED predecessor is eligible", async () => {
    const h = await reissueHarness();
    await h.expire();
    expect((await h.stack.runs.getById(h.runId))!.state).toBe("EXPIRED");
    const approvalBefore = await h.stack.approvalRequests.getById(
      h.approvalRequestId,
    );

    const result = await h.reissue();

    expect(result.outcome).toBe("REISSUED");
    expect(result.targetObjectiveVersion).toBe(2);
    expect(
      await h.stack.approvalRequests.getById(h.approvalRequestId),
    ).toEqual(approvalBefore);
  });

  it("writes one immutable RECOVERY_OBJECTIVE_REISSUED event with safe fields only", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const result = await h.reissue();

    const audits = h.reissueAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.recoveryCaseId).toBe(h.recoveryCaseId);
    expect(audits[0]!.payload).toEqual({
      reissueId: result.reissueId,
      recoveryCaseId: h.recoveryCaseId,
      objectiveId: h.objectiveId,
      sourceObjectiveVersion: 1,
      targetObjectiveVersion: 2,
      predecessorRunId: h.runId,
      predecessorRunState: "REJECTED",
      predecessorAuthority: "NONE",
      replacementRunId: result.replacementRunId,
      reason: REASON,
      admissionOutcome: "ADMITTED",
      requesterId: "user_local",
      principalId: PRINCIPAL,
    });
    const serialized = JSON.stringify(audits);
    expect(serialized).not.toContain("alex@example.com");
    expect(serialized).not.toContain("+15551234567");

    const detail = await h.service.getCaseDetail({
      recoveryCaseId: h.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(detail.objectiveBinding).toEqual({
      objectiveId: h.objectiveId,
      recoveryObjectiveVersion: 2,
      orchestratorRunId: result.replacementRunId,
      lineage: [
        {
          reissueId: result.reissueId,
          objectiveId: h.objectiveId,
          sourceObjectiveVersion: 1,
          targetObjectiveVersion: 2,
          predecessorRunId: h.runId,
          replacementRunId: result.replacementRunId,
          reason: REASON,
          principalId: PRINCIPAL,
          occurredAt: RR_MONDAY_IN_WINDOW,
        },
      ],
    });
  });
});

describe("objective reissue — predecessor eligibility", () => {
  it("rejects AWAITING_APPROVAL without touching the pending approval", async () => {
    const h = await reissueHarness();
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);
    const before = await h.predecessorSnapshot();

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE",
      details: {
        reasonCode: "PREDECESSOR_NOT_TERMINAL_WITHOUT_AUTHORITY",
        predecessorState: "AWAITING_APPROVAL",
      },
    });
    await expectNoReissueMutation(h, caseBefore);
    expect(await h.predecessorSnapshot()).toEqual(before);
    expect(h.delivery.nonceFor(h.approvalRequestId)).toBeTruthy();
  });

  it("rejects APPROVED", async () => {
    const h = await reissueHarness();
    await h.decide("APPROVE");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE",
      details: { predecessorState: "APPROVED" },
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("rejects EXECUTING", async () => {
    const h = await reissueHarness({
      orchestrator: (base) => ({
        ...base,
        runs: {
          getById: async (runId) => {
            const run = await base.runs.getById(runId);
            return run && run.state === "REJECTED"
              ? { ...run, state: "EXECUTING" }
              : run;
          },
        },
      }),
    });
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE",
      details: { predecessorState: "EXECUTING" },
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("rejects a predecessor holding an APPROVE AuthorizationRecord", async () => {
    const h = await reissueHarness({
      orchestrator: (base) => ({
        ...base,
        authorizationRecords: {
          listByRun: async (runId) => [
            ...(await base.authorizationRecords.listByRun(runId)),
            { runId, decision: "APPROVE" } as unknown as AuthorizationRecord,
          ],
        },
      }),
    });
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("rejects a predecessor with any ExecutionAttempt", async () => {
    const h = await reissueHarness({
      orchestrator: (base) => ({
        ...base,
        executionAttempts: {
          listByRun: async (runId) => [
            { runId, executionAttemptId: "exa_x" } as unknown as ExecutionAttempt,
          ],
        },
      }),
    });
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("rejects a predecessor with a RecoveryAttempt attributed to it", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    await h.repos.attempts.save({
      attemptId: "rra_attributed",
      recoveryCaseId: h.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: h.lead.leadId,
      runId: h.runId,
      executionAttemptId: "exa_attributed",
      stepId: "step_recovery_email",
      executionActionIdentity: "rr_action_attributed",
      providerIdempotencyKey: "rr_idem_attributed",
      channel: "EMAIL",
      recipientRef: "recipient_ref",
      sentAt: RR_MONDAY_IN_WINDOW,
      deliveryOutcome: "SIMULATED",
      recordRevision: 1,
    });
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_AUTHORITY_PRESENT",
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("fails closed when the contact policy permits no channel", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    h.productClock.now = "2026-09-12T15:00:00.000Z"; // Saturday, outside window
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE",
      details: { reasonCode: "CONTACT_POLICY_NOT_ELIGIBLE" },
    });
    await expectNoReissueMutation(h, caseBefore);
  });
});

describe("objective reissue — caller cannot choose content or identity", () => {
  it.each([
    ["objectiveId", "obj_rr_attacker"],
    ["objectiveVersion", 7],
    ["requestedOutcome", "x"],
    ["acceptanceCriteria", ["x"]],
    ["constraints", ["Allowed channels: SMS"]],
    ["nonGoals", ["x"]],
    ["runId", "run_attacker"],
    ["replacementRunId", "run_attacker"],
    ["targetIds", ["rr_case:x"]],
    ["planId", "plan_x"],
    ["approvalRequestId", "apr_x"],
    ["authorizationRecordId", "auth_x"],
  ])("rejects caller-supplied %s", async (key, value) => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(
      h.reissue({
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        reason: REASON,
        [key]: value,
      }),
    ).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_INVALID",
      details: { fields: [key] },
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("rejects an unknown reason", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    await expect(
      h.reissue({
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        reason: "ANYTHING_ELSE",
      }),
    ).rejects.toMatchObject({ code: "OBJECTIVE_REISSUE_INVALID" });
  });

  it("rejects cross-tenant and cross-project requests", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(
      h.reissue({
        customerAccountId: "other_tenant",
        projectId: RR_PROJECT,
        reason: REASON,
      }),
    ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });
    await expect(
      h.reissue({
        customerAccountId: RR_CUSTOMER,
        projectId: "other_project",
        reason: REASON,
      }),
    ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });
    await expectNoReissueMutation(h, caseBefore);
  });
});

describe("objective reissue — idempotency, concurrency, CAS", () => {
  it("a repeated call returns ALREADY_REISSUED with the same replacement run", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const first = await h.reissue();
    const caseAfterFirst = await h.repos.cases.getById(h.recoveryCaseId);

    const second = await h.reissue();

    expect(second).toEqual({ ...first, outcome: "ALREADY_REISSUED" });
    expect(await h.repos.cases.getById(h.recoveryCaseId)).toEqual(caseAfterFirst);
    expect(h.reissueAudits()).toHaveLength(1);
    expect(await h.stack.objectives.getById(h.objectiveId, 3)).toBeNull();
  });

  it("concurrent calls produce one v2 objective, one run, one pointer move", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const revisionBefore = (await h.repos.cases.getById(h.recoveryCaseId))!
      .recordRevision;

    const results = await Promise.all([h.reissue(), h.reissue(), h.reissue()]);

    expect(results.map((r) => r.outcome).sort()).toEqual([
      "ALREADY_REISSUED",
      "ALREADY_REISSUED",
      "REISSUED",
    ]);
    expect(new Set(results.map((r) => r.replacementRunId)).size).toBe(1);
    expect(h.reissueAudits()).toHaveLength(1);
    const caseAfter = (await h.repos.cases.getById(h.recoveryCaseId))!;
    expect(caseAfter.recordRevision).toBe(revisionBefore + 1);
    expect(caseAfter.orchestratorRunId).toBe(results[0]!.replacementRunId);
  });

  it("an untouched replacement is never reissued again", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const v2 = await h.reissue();
    // Replacement is untouched ADMITTED — not eligible for another reissue.
    await expect(h.reissue()).resolves.toMatchObject({
      outcome: "ALREADY_REISSUED",
      targetObjectiveVersion: 2,
    });
    expect(v2.targetObjectiveVersion).toBe(2);
    expect(await h.stack.objectives.getById(h.objectiveId, 3)).toBeNull();
  });

  it("memory CAS rejects a stale run, version, or revision", async () => {
    const h = await reissueHarness();
    const current = (await h.repos.cases.getById(h.recoveryCaseId))!;
    const swap = {
      recoveryCaseId: h.recoveryCaseId,
      expectedOrchestratorRunId: h.runId,
      expectedObjectiveVersion: 1,
      expectedRecordRevision: current.recordRevision,
      orchestratorRunId: "run_next",
      objectiveId: h.objectiveId,
      objectiveVersion: 2,
      updatedAt: RR_MONDAY_IN_WINDOW,
    };
    expect(
      await h.repos.cases.compareAndSetOrchestratorRunBinding({
        ...swap,
        expectedOrchestratorRunId: "run_other",
      }),
    ).toBeNull();
    expect(
      await h.repos.cases.compareAndSetOrchestratorRunBinding({
        ...swap,
        expectedObjectiveVersion: 2,
      }),
    ).toBeNull();
    expect(
      await h.repos.cases.compareAndSetOrchestratorRunBinding({
        ...swap,
        expectedRecordRevision: current.recordRevision - 1,
      }),
    ).toBeNull();
    expect(await h.repos.cases.getById(h.recoveryCaseId)).toEqual(current);

    const swapped = await h.repos.cases.compareAndSetOrchestratorRunBinding(swap);
    expect(swapped).toMatchObject({
      orchestratorRunId: "run_next",
      recoveryObjectiveVersion: 2,
      recordRevision: current.recordRevision + 1,
    });
    await expect(
      h.repos.cases.save({ ...current, recordRevision: current.recordRevision + 1 }),
    ).rejects.toMatchObject({ code: "RECOVERY_CAS_CONFLICT" });
  });

  it("a concurrent case write fails closed with BINDING_CHANGED, then converges on retry", async () => {
    let interfere = true;
    let harness: Harness | undefined;
    const h = await reissueHarness({
      admission: (base) => ({
        admit: async (input) => {
          const result = await base.admit(input);
          if (interfere && harness) {
            interfere = false;
            const current = (await harness.repos.cases.getById(
              harness.recoveryCaseId,
            ))!;
            await harness.repos.cases.save({
              ...current,
              updatedAt: "2026-09-14T15:00:01.000Z",
              recordRevision: current.recordRevision + 1,
            });
          }
          return result;
        },
      }),
    });
    harness = h;
    await h.decide("REJECT");

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_BINDING_CHANGED",
    });
    const caseAfterFailure = (await h.repos.cases.getById(h.recoveryCaseId))!;
    expect(caseAfterFailure.orchestratorRunId).toBe(h.runId);
    expect(caseAfterFailure.recoveryObjectiveVersion ?? 1).toBe(1);
    expect(h.reissueAudits()).toEqual([]);

    // Memory has no rollback: the admitted-but-unbound v2 run is adopted on retry.
    const retried = await h.reissue();
    expect(retried.outcome).toBe("REISSUED");
    expect(h.reissueAudits()[0]!.payload).toMatchObject({
      admissionOutcome: "CONVERGED_DUPLICATE",
      replacementRunId: retried.replacementRunId,
    });
  });
});

describe("objective reissue — admission failure leaves no mutation", () => {
  it("a different pre-existing v2 objective is a CONFLICT", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const squatter = await h.stack.admission.admit(
      exampleAdmissionRequest({
        objectiveId: h.objectiveId,
        objectiveVersion: 2,
        ...LEGACY_V1,
      }),
    );
    expect(squatter.outcome).toBe("ADMITTED");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_CONFLICT",
    });
    expect(await h.repos.cases.getById(h.recoveryCaseId)).toEqual(caseBefore);
    expect(h.reissueAudits()).toEqual([]);
  });

  it("an admission CONFLICT result moves nothing", async () => {
    const h = await reissueHarness({
      admission: () => ({
        admit: async () => ({
          outcome: "CONFLICT",
          reasonCode: "OBJECTIVE_VERSION_CONFLICT",
          message: "conflict",
        }),
      }),
    });
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_CONFLICT",
      details: { admissionReasonCode: "OBJECTIVE_VERSION_CONFLICT" },
    });
    await expectNoReissueMutation(h, caseBefore);
  });

  it("an admission REJECTED result moves nothing", async () => {
    const h = await reissueHarness({
      admission: () => ({
        admit: async () => ({
          outcome: "REJECTED",
          reasonCode: "REQUESTER_NOT_AUTHORIZED",
          message: "denied",
        }),
      }),
    });
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);

    await expect(h.reissue()).rejects.toMatchObject({
      code: "OBJECTIVE_REISSUE_NOT_ELIGIBLE",
      details: { reasonCode: "ADMISSION_REJECTED" },
    });
    await expectNoReissueMutation(h, caseBefore);
  });
});

describe("objective reissue — authority isolation and binder", () => {
  it("binder accepts the replacement, rejects the predecessor, and resolves the same case/lead/template", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const { replacementRunId } = await h.reissue();

    const resolved = await h.binder.resolveCaseAndLead(replacementRunId);
    expect(resolved.recoveryCase.recoveryCaseId).toBe(h.recoveryCaseId);
    expect(resolved.leadId).toBe(h.lead.leadId);
    await expect(h.binder.resolveCaseAndLead(h.runId)).rejects.toMatchObject({
      code: "RECOVERY_CASE_NOT_BOUND",
    });

    await h.stack.ingestion.ingest(
      replacementRunId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await h.stack.planning.plan(replacementRunId);
    const plan = await h.stack.plans.getByRunId(replacementRunId);
    expect(plan!.plan.steps[0]!.targetIds).toEqual([
      `rr_case:${h.recoveryCaseId}`,
      `rr_lead:${h.lead.leadId}`,
      `rr_template:${h.template.templateId}@1`,
    ]);
  });

  it("the replacement inherits no authority and must earn its own Phase 6 approval", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const oldNonce = h.delivery.nonceFor(h.approvalRequestId)!;
    const { replacementRunId } = await h.reissue();

    const readiness = await h.stack.executionReadiness.assess(replacementRunId);
    expect(readiness.ready).toBe(false);

    await h.stack.ingestion.ingest(
      replacementRunId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await h.stack.planning.plan(replacementRunId);
    await h.stack.validation.validate(replacementRunId);
    const routed = await h.stack.authorizationRouting.route(replacementRunId);
    expect(routed.outcome).toBe("PENDING_APPROVAL");
    if (routed.outcome !== "PENDING_APPROVAL") return;
    expect(routed.approvalRequestId).not.toBe(h.approvalRequestId);

    // The predecessor's nonce is useless against the replacement's request.
    await expect(
      h.stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: h.stack.clock.nowIso(),
        decisionNonce: oldNonce,
      }),
    ).rejects.toBeTruthy();
    expect(
      await h.stack.authorizationRecords.listByRun(replacementRunId),
    ).toEqual([]);
    expect((await h.stack.runs.getById(replacementRunId))!.state).toBe(
      "AWAITING_APPROVAL",
    );
    expect(h.messaging.sent).toHaveLength(0);
  });
});

describe("prepareRecoveryObjective — safety", () => {
  async function freshCase() {
    const h = await reissueHarness();
    const other = await h.service.ingestLead(
      demoLead({
        createdAt: RR_LEAD_CREATED_AT,
        externalLeadId: "ext_lead_prepare",
        phone: "+15557654321",
        email: "prepare@example.com",
      }),
    );
    const opened = await h.service.detectAndOpenRecoveryCase({
      leadId: other.lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    return { h, recoveryCase: opened.recoveryCase! };
  }

  function admittedAudits(h: Harness, recoveryCaseId: string) {
    return h.repos.audits
      .listAll()
      .filter(
        (e) =>
          e.kind === "RECOVERY_OBJECTIVE_ADMITTED" &&
          e.recoveryCaseId === recoveryCaseId,
      );
  }

  it("ADMITTED binds the case and writes one admitted audit; a duplicate changes nothing", async () => {
    const { h, recoveryCase } = await freshCase();
    const first = await h.service.prepareRecoveryObjective({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      admit: true,
    });
    const runId = (first.admissionResult as { runId: string }).runId;
    const bound = (await h.repos.cases.getById(recoveryCase.recoveryCaseId))!;
    expect(bound).toMatchObject({
      status: "IN_ORCHESTRATION",
      orchestratorRunId: runId,
      recoveryObjectiveVersion: 1,
    });
    expect(admittedAudits(h, recoveryCase.recoveryCaseId)).toHaveLength(1);

    const again = await h.service.prepareRecoveryObjective({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      admit: true,
    });
    expect(again.admissionResult).toMatchObject({
      outcome: "ACTIVE_DUPLICATE",
      runId,
    });
    expect(await h.repos.cases.getById(recoveryCase.recoveryCaseId)).toEqual(bound);
    expect(admittedAudits(h, recoveryCase.recoveryCaseId)).toHaveLength(1);
  });

  it("an admission CONFLICT writes no admitted audit and does not bind the case", async () => {
    const { h, recoveryCase } = await freshCase();
    await h.stack.admission.admit(
      exampleAdmissionRequest({
        objectiveId: `obj_rr_${recoveryCase.recoveryCaseId}`,
        ...LEGACY_V1,
      }),
    );
    const before = await h.repos.cases.getById(recoveryCase.recoveryCaseId);

    const result = await h.service.prepareRecoveryObjective({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      admit: true,
    });

    expect(result.admissionResult).toMatchObject({ outcome: "CONFLICT" });
    expect(await h.repos.cases.getById(recoveryCase.recoveryCaseId)).toEqual(before);
    expect(admittedAudits(h, recoveryCase.recoveryCaseId)).toEqual([]);
  });

  it("never rebinds or regresses a bound case", async () => {
    const h = await reissueHarness();
    const bound = await h.repos.cases.getById(h.recoveryCaseId);

    // Preview on a bound case does not regress IN_ORCHESTRATION.
    await h.service.prepareRecoveryObjective({
      recoveryCaseId: h.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
    });
    expect(await h.repos.cases.getById(h.recoveryCaseId)).toEqual(bound);

    // A different environment would mint another run: refused before admission.
    await expect(
      h.service.prepareRecoveryObjective({
        recoveryCaseId: h.recoveryCaseId,
        requesterId: "user_local",
        requestedEnvironment: "staging",
        admit: true,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_OBJECTIVE_CONFLICT" });
    expect(await h.repos.cases.getById(h.recoveryCaseId)).toEqual(bound);
    expect(
      h.repos.audits
        .listAll()
        .filter((e) => e.kind === "RECOVERY_OBJECTIVE_ADMITTED"),
    ).toEqual([]);
  });
});

describe("objective reissue — HTTP", () => {
  function perimeter(projectIds: readonly string[]) {
    return {
      authenticator: new FakeRequestAuthenticator({
        principalId: PRINCIPAL,
        authenticationMode: "STATIC_PRINCIPAL" as const,
      }),
      access: new InMemoryProjectAccessDirectory([
        { principalId: PRINCIPAL, projectIds },
      ]),
      drain: new DrainController(),
      metrics: new OperationalMetrics(),
      logger: new MemoryStructuredLogger("rr_reissue", () => undefined),
      rateLimiter: new SlidingWindowRateLimiter(120, 60_000),
      authenticationMode: "STATIC_PRINCIPAL" as const,
    };
  }

  const payload = {
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    reason: REASON,
  };

  it("201 on REISSUED, 200 on replay, principal recorded; 409 when ineligible", async () => {
    const h = await reissueHarness();
    const app = await buildServer({
      revenueRecovery: h.service,
      perimeter: perimeter([RR_PROJECT]),
    });
    const url = `/v1/revenue-recovery/cases/${h.recoveryCaseId}/objective-reissue`;

    const ineligible = await app.inject({ method: "POST", url, payload });
    expect(ineligible.statusCode).toBe(409);
    expect(ineligible.json().error).toBe("OBJECTIVE_REISSUE_NOT_ELIGIBLE");

    await h.decide("REJECT");
    const created = await app.inject({ method: "POST", url, payload });
    expect(created.statusCode).toBe(201);
    expect(created.json().outcome).toBe("REISSUED");
    const replay = await app.inject({ method: "POST", url, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({
      outcome: "ALREADY_REISSUED",
      replacementRunId: created.json().replacementRunId,
    });
    expect(h.reissueAudits()[0]!.payload).toMatchObject({ principalId: PRINCIPAL });

    const detail = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/cases/${h.recoveryCaseId}?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().objectiveBinding).toMatchObject({
      recoveryObjectiveVersion: 2,
      orchestratorRunId: created.json().replacementRunId,
    });

    const smuggled = await app.inject({
      method: "POST",
      url,
      payload: { ...payload, objectiveVersion: 3 },
    });
    expect(smuggled.statusCode).toBe(400);
    expect(smuggled.json().error).toBe("OBJECTIVE_REISSUE_INVALID");
    await app.close();
  });

  it("denies a principal without project access and does not infer authority from the case id", async () => {
    const h = await reissueHarness();
    await h.decide("REJECT");
    const caseBefore = await h.repos.cases.getById(h.recoveryCaseId);
    const app = await buildServer({
      revenueRecovery: h.service,
      perimeter: perimeter(["other-project"]),
    });

    const denied = await app.inject({
      method: "POST",
      url: `/v1/revenue-recovery/cases/${h.recoveryCaseId}/objective-reissue`,
      payload,
    });
    expect(denied.statusCode).toBe(403);
    const deniedDetail = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/cases/${h.recoveryCaseId}?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(deniedDetail.statusCode).toBe(403);
    await expectNoReissueMutation(h, caseBefore);
    await app.close();
  });

  it("503 when the composer wires no orchestrator evidence", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => RR_MONDAY_IN_WINDOW,
    });
    const app = await buildServer({ revenueRecovery: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/cases/rrc_x/objective-reissue",
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toBe("OBJECTIVE_REISSUE_UNAVAILABLE");
    await app.close();
  });
});
