/**
 * Revenue Recovery authority + economic provenance boundaries.
 *
 * CALLER ASSERTION != AUTHORIZATION.
 * ELIGIBLE != AUTHORIZED. APPROVED != SENT. EVENT KIND != TRUST PROVENANCE.
 *
 * Outreach is reachable only through Phase6 authorization → Phase7 execution →
 * SafeActuator → RevenueRecoveryPhase7Actuator. These tests prove that every
 * other path leaves zero provider deliveries and zero RecoveryAttempts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildServer } from "../api/server.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { FakeSafeActuator } from "../infrastructure/execution/actuators.js";
import { createLocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import type { LocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import { FakePlanningModel } from "../planning/fake-planning-model.js";
import type { PlanningContext } from "../planning/context.js";
import type { PlanningModelOutput } from "../planning/model.js";
import type { GapAnalysis, PlanProposal } from "../planning/proposal.js";
import { parsePlanProposal } from "../planning/proposal.js";
import { proposeBindingsForSteps } from "../planning/verification-bindings.js";
import { RevenueRecoveryPhase7Actuator } from "./phase7-actuator.js";
import { computeRecoveryRecordHash } from "./recovery-record.js";
import { resolveConfidenceFromProvenance } from "./provenance.js";
import { ATTRIBUTION_RULE_VERSION } from "./revenue-attribution.js";
import type { ProductRuntimeEnvironment } from "./provenance.js";

/** Monday 15:00 UTC — inside a Mon–Fri 09:00–17:00 UTC contact window. */
const MONDAY_IN_WINDOW = "2026-09-14T15:00:00.000Z";
const LEAD_CREATED_AT = "2026-09-14T12:00:00.000Z";
const RECOVERY_CRITERION = "Bounded recovery outreach attempt recorded";

function recoveryConfig() {
  return demoRecoveryConfig({
    timezone: "UTC",
    contactWindow: {
      startHourLocal: 9,
      endHourLocal: 17,
      daysOfWeek: [1, 2, 3, 4, 5],
    },
    cooldownMinutes: 0,
  });
}

/**
 * Planning model that proposes exactly one bounded SEND_RECOVERY_SMS step.
 * The plan names targets only; the recipient is resolved from the canonical
 * lead at actuation time.
 */
function createRecoverySmsPlanningModel(binding: {
  recoveryCaseId: string;
  leadId: string;
  templateId: string;
  templateVersion: number;
}): FakePlanningModel {
  return new RecoverySmsPlanningModel(binding);
}

class RecoverySmsPlanningModel extends FakePlanningModel {
  constructor(
    private readonly binding: {
      recoveryCaseId: string;
      leadId: string;
      templateId: string;
      templateVersion: number;
    },
  ) {
    super();
  }

  override async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    this.callCount += 1;
    const steps: PlanProposal["steps"] = [
      {
        stepId: "step_recovery_sms",
        actionType: "SEND_RECOVERY_SMS",
        description: "Send one bounded recovery SMS to the canonical lead",
        targetIds: [
          `rr_case:${this.binding.recoveryCaseId}`,
          `rr_lead:${this.binding.leadId}`,
          `rr_template:${this.binding.templateId}@${this.binding.templateVersion}`,
        ],
        evidenceRefs: input.context.contextMetadata.selectedEvidenceIds.slice(
          0,
          2,
        ),
        dependsOn: [],
        preconditions: ["Recovery case is active and contact policy permits SMS"],
        expectedPostconditions: [RECOVERY_CRITERION],
        resourceEstimate: {
          durationMs: 20_000,
          tokenEstimate: 200,
          costEstimateUsd: 0.01,
        },
        risk: { level: "MEDIUM", categories: ["external-communication"] },
        validationChecks: [
          "Recovery attempt recorded against the bound template identity",
        ],
        rollbackStrategy: "NONE",
      },
    ];

    return {
      value: parsePlanProposal({
        gapAnalysis: input.gapAnalysis,
        workstreams: [
          {
            workstreamId: "ws_recovery",
            name: "Bounded recovery outreach",
            stepIds: ["step_recovery_sms"],
          },
        ],
        steps,
        successDefinition: [...input.context.objective.acceptanceCriteria],
        assumptions: [...input.gapAnalysis.assumptions],
        unknowns: [...input.gapAnalysis.unknowns],
        proposedRisks: ["Outreach cannot be recalled once delivered"],
        proposedVerificationChecks: [
          "Exactly one recovery attempt exists for the case",
        ],
        proposedRollbackApproach:
          "Outreach cannot be unsent; suppression stops further contact",
        proposedResourceTotals: {
          estimatedDurationMinutes: 1,
          estimatedLlmTokens: 500,
          estimatedApiCalls: 1,
          estimatedHumanMinutes: 2,
          estimatedCost: 0.02,
          maximumParallelWorkstreams: 1,
          estimatedLlmCalls: 1,
        },
        acceptanceCriterionVerificationBindings: proposeBindingsForSteps({
          acceptanceCriteria: input.context.objective.acceptanceCriteria,
          steps,
        }),
        conciseRationale:
          "One bounded outreach step whose recipient resolves from the canonical lead.",
      }),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}

async function recoveryProduct(options?: {
  consent?: Parameters<typeof demoLead>[0]["consent"];
}) {
  const { service, messaging, repos } = createMemoryRevenueRecoveryService({
    nowIso: () => MONDAY_IN_WINDOW,
  });
  await service.putConfiguration(recoveryConfig());
  const template = await service.saveTemplate({
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    channel: "SMS",
    version: 1,
    body: "Hi {{firstName}} — {{businessName}} can still help.",
    allowedVariables: ["firstName", "businessName"],
    enabled: true,
  });
  const { lead } = await service.ingestLead(
    demoLead({
      createdAt: LEAD_CREATED_AT,
      ...(options?.consent ? { consent: options.consent } : {}),
    }),
  );
  const { recoveryCase } = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  if (!recoveryCase) {
    throw new Error("expected an open recovery case");
  }
  return { service, messaging, repos, template, lead, recoveryCase };
}

/**
 * SUPERVISED project + recovery planning model, routed to AWAITING_APPROVAL.
 * No AuthorizationRecord exists yet.
 */
async function routedRecoveryRun() {
  const product = await recoveryProduct();
  const delivery = new FakeApprovalDeliveryService();
  const actuator = new FakeSafeActuator();
  actuator.attachRevenueRecovery(
    new RevenueRecoveryPhase7Actuator(product.service),
  );
  const stack = createLocalExecutionStack({
    projects: [{ ...EXAMPLE_PROJECT, executionMode: "SUPERVISED" }],
    planningModel: createRecoverySmsPlanningModel({
      recoveryCaseId: product.recoveryCase.recoveryCaseId,
      leadId: product.lead.leadId,
      templateId: product.template.templateId,
      templateVersion: 1,
    }),
    actuator,
    approvalDelivery: delivery,
    clockIso: MONDAY_IN_WINDOW,
  });

  const admitted = await stack.admission.admit(
    exampleAdmissionRequest({
      objectiveId: "obj_rr_authority",
      requestedOutcome: "Recover one unanswered inbound lead",
      acceptanceCriteria: [RECOVERY_CRITERION],
      nonGoals: ["Contacting leads who opted out"],
      constraints: ["No contact after opt-out"],
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
  return {
    ...product,
    stack,
    actuator,
    delivery,
    runId,
    approvalRequestId: routed.approvalRequestId,
  };
}

async function approve(
  stack: LocalExecutionStack,
  delivery: FakeApprovalDeliveryService,
  approvalRequestId: string,
): Promise<void> {
  const nonce = delivery.nonceFor(approvalRequestId);
  if (!nonce) {
    throw new Error("missing decision nonce");
  }
  await stack.humanAuthorization.decide({
    approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "APPROVE",
    submittedAt: stack.clock.nowIso(),
    decisionNonce: nonce,
  });
}

function artifactRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "rr-authority-"));
}

describe("Revenue Recovery authority boundary", () => {
  it("A: rejects a caller-asserted humanAuthorizationConfirmed body", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => MONDAY_IN_WINDOW,
    });
    const app = await buildServer({ revenueRecovery: service });

    const config = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/config",
      payload: { ...recoveryConfig(), humanAuthorizationConfirmed: true },
    });
    expect(config.statusCode).toBe(400);
    expect(config.json().error).toBe("CALLER_ASSERTION_REJECTED");

    const leads = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/leads",
      payload: { ...demoLead(), humanAuthorizationConfirmed: true },
    });
    expect(leads.statusCode).toBe(400);
    expect(leads.json().error).toBe("CALLER_ASSERTION_REJECTED");
    await app.close();
  });

  it("J: exposes no authorized-action outreach route", async () => {
    const { service, messaging } = createMemoryRevenueRecoveryService({
      nowIso: () => MONDAY_IN_WINDOW,
    });
    const app = await buildServer({ revenueRecovery: service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/cases/x/authorized-action",
      payload: { actionType: "SEND_RECOVERY_SMS" },
    });
    expect(response.statusCode).toBe(404);
    expect(messaging.sent).toHaveLength(0);
    await app.close();
  });

  it("B/C: denies execution while AWAITING_APPROVAL with zero outreach", async () => {
    const { stack, runId, messaging, repos, recoveryCase } =
      await routedRecoveryRun();
    const run = await stack.runs.getById(runId);
    expect(run?.state).toBe("AWAITING_APPROVAL");

    await expect(stack.execution.execute(runId)).rejects.toMatchObject({
      code: "EXECUTION_NOT_READY",
    });

    expect(messaging.sent).toHaveLength(0);
    expect(
      await repos.attempts.listByCase(recoveryCase.recoveryCaseId),
    ).toHaveLength(0);
  });

  it("D: leaves no AuthorizationRecord when execution is denied", async () => {
    const { stack, runId, messaging, repos, recoveryCase } =
      await routedRecoveryRun();
    await expect(stack.execution.execute(runId)).rejects.toMatchObject({
      code: "EXECUTION_NOT_READY",
    });
    expect(await stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
    expect(messaging.sent).toHaveLength(0);
    expect(
      await repos.attempts.listByCase(recoveryCase.recoveryCaseId),
    ).toHaveLength(0);
  });

  it("E: authorized Phase7 execution sends exactly one bounded outreach", async () => {
    const {
      stack,
      delivery,
      approvalRequestId,
      runId,
      messaging,
      repos,
      recoveryCase,
      lead,
      template,
    } = await routedRecoveryRun();
    await approve(stack, delivery, approvalRequestId);

    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_SUCCEEDED");

    const attempts = await repos.attempts.listByCase(
      recoveryCase.recoveryCaseId,
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.channel).toBe("SMS");
    expect(attempts[0]?.deliveryOutcome).toBe("SIMULATED");
    expect(attempts[0]?.templateId).toBe(template.templateId);
    expect(attempts[0]?.runId).toBe(runId);
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.action).toMatchObject({
      recipientPhone: lead.phone,
    });
    // Recipient is masked on the durable attempt record.
    expect(attempts[0]?.recipientRef).not.toContain("5551234567");
  });

  it("F: idempotent Phase7 retry never produces a second delivery", async () => {
    const {
      stack,
      actuator,
      delivery,
      approvalRequestId,
      runId,
      messaging,
      repos,
      recoveryCase,
      lead,
      template,
    } = await routedRecoveryRun();
    await approve(stack, delivery, approvalRequestId);
    const first = await stack.execution.execute(runId);
    expect(messaging.sent).toHaveLength(1);

    // Same run re-driven: terminal execution fence replays the prior result.
    const replayedRun = await stack.execution.execute(runId);
    expect(replayedRun.executionAttemptId).toBe(first.executionAttemptId);

    // Same authorized step re-driven through the SafeActuator: replay, no send.
    const invocation = actuator.invocations.find(
      (i) => i.method === "sendRecoverySms",
    )?.input as {
      executionAttemptId: string;
      stepId: string;
      stepIdempotencyKey: string;
    };
    const replayedStep = await actuator.sendRecoverySms({
      runId,
      executionAttemptId: invocation.executionAttemptId,
      stepId: invocation.stepId,
      stepIdempotencyKey: invocation.stepIdempotencyKey,
      artifactRoot: artifactRoot(),
      args: {
        recoveryCaseId: recoveryCase.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: 1,
      },
      nowIso: MONDAY_IN_WINDOW,
      runtime: { timeoutMs: 30_000 },
    });
    expect(replayedStep.replayed).toBe(true);

    expect(messaging.sent).toHaveLength(1);
    expect(
      await repos.attempts.listByCase(recoveryCase.recoveryCaseId),
    ).toHaveLength(1);
  });

  it("G: DO_NOT_CONTACT after approval stops execution outreach", async () => {
    const {
      stack,
      service,
      delivery,
      approvalRequestId,
      runId,
      messaging,
      repos,
      recoveryCase,
      lead,
    } = await routedRecoveryRun();
    await approve(stack, delivery, approvalRequestId);

    // Approval is not a standing licence: suppression is re-proven at actuation.
    await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "DO_NOT_CONTACT",
      occurredAt: MONDAY_IN_WINDOW,
      externalEventId: "dnc_after_approval",
      source: "WEBHOOK",
    });

    // Outreach cannot be rolled back, so the failed step contains the run.
    const result = await stack.execution.execute(runId);
    expect(result.status).toBe("EXECUTION_CONTAINED");
    expect(result.stepResults[0]?.status).toBe("FAILED");
    expect(result.stepResults[0]?.errorCode).toBe(
      "EXECUTION_PRECONDITION_FAILED",
    );
    expect((await stack.runs.getById(runId))?.state).toBe("CONTAINED");
    expect(messaging.sent).toHaveLength(0);
    expect(
      await repos.attempts.listByCase(recoveryCase.recoveryCaseId),
    ).toHaveLength(0);
  });

  it("H: inbound response blocks further authorized outreach", async () => {
    const {
      stack,
      actuator,
      service,
      delivery,
      approvalRequestId,
      runId,
      messaging,
      repos,
      recoveryCase,
      lead,
      template,
    } = await routedRecoveryRun();
    await approve(stack, delivery, approvalRequestId);
    await stack.execution.execute(runId);
    expect(messaging.sent).toHaveLength(1);

    await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "INBOUND_MESSAGE",
      occurredAt: MONDAY_IN_WINDOW,
      externalEventId: "sms_in_after_send",
      source: "WEBHOOK",
      channel: "SMS",
    });

    // A distinct authorized step is still denied: the lead already responded.
    await expect(
      actuator.sendRecoverySms({
        runId,
        executionAttemptId: "exa_after_inbound",
        stepId: "step_after_inbound",
        stepIdempotencyKey: "idem_after_inbound",
        artifactRoot: artifactRoot(),
        args: {
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          templateId: template.templateId,
          templateVersion: 1,
        },
        nowIso: MONDAY_IN_WINDOW,
        runtime: { timeoutMs: 30_000 },
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_PRECONDITION_FAILED" });

    expect(messaging.sent).toHaveLength(1);
    expect(
      await repos.attempts.listByCase(recoveryCase.recoveryCaseId),
    ).toHaveLength(1);
  });

  it("I: rejects an action whose leadId does not match the case", async () => {
    const { service, messaging, repos, recoveryCase, template } =
      await recoveryProduct();
    const other = await service.ingestLead(
      demoLead({
        externalLeadId: "ext_lead_authority_other",
        createdAt: LEAD_CREATED_AT,
      }),
    );
    const actuator = new FakeSafeActuator();
    actuator.attachRevenueRecovery(new RevenueRecoveryPhase7Actuator(service));

    await expect(
      actuator.sendRecoverySms({
        runId: "run_mismatch",
        executionAttemptId: "exa_mismatch",
        stepId: "step_mismatch",
        stepIdempotencyKey: "idem_mismatch",
        artifactRoot: artifactRoot(),
        args: {
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: other.lead.leadId,
          templateId: template.templateId,
          templateVersion: 1,
        },
        nowIso: MONDAY_IN_WINDOW,
        runtime: { timeoutMs: 30_000 },
      }),
    ).rejects.toMatchObject({
      code: "EXECUTION_TARGET_INVALID",
      details: { revenueRecoveryCode: "RECOVERY_ACTION_TARGET_MISMATCH" },
    });

    expect(messaging.sent).toHaveLength(0);
    expect(
      await repos.attempts.listByCase(recoveryCase.recoveryCaseId),
    ).toHaveLength(0);
  });
});

async function economicCase(options?: {
  runtimeEnvironment?: ProductRuntimeEnvironment;
}) {
  const nowIso = "2026-09-12T12:30:00.000Z";
  const { service, repos } = createMemoryRevenueRecoveryService({
    nowIso: () => nowIso,
    ...(options?.runtimeEnvironment
      ? { runtimeEnvironment: options.runtimeEnvironment }
      : {}),
  });
  await service.putConfiguration(demoRecoveryConfig());
  const { lead } = await service.ingestLead(demoLead());
  const { recoveryCase } = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  if (!recoveryCase) {
    throw new Error("expected an open recovery case");
  }
  return { service, repos, lead, recoveryCase };
}

describe("Revenue Recovery economic provenance", () => {
  it("K: a manually ingested payment can only ever be ATTESTED_PAYMENT", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const payment = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "manual_pay_1",
      source: "MANUAL",
      amount: 3100,
      currency: "USD",
    });
    expect(payment.event.trustProvenance).toBe("MANUAL_ATTESTATION");

    const attribution = await service.attributeFromEvent({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      eventId: payment.event.eventId,
    });
    expect(attribution.confidenceClass).toBe("ATTESTED_PAYMENT");
    expect(attribution.confidenceClass).not.toBe("CONFIRMED_PAYMENT");

    const detail = await service.getCaseDetail({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(detail.economics.confirmedCollectedRevenue).toBeNull();
    expect(detail.economics.operatorAttestedRevenue).toBe(3100);
  });

  it("M: a trusted-sounding source label does not elevate provenance", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const payment = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "stripe_label_1",
      source: "Stripe",
      amount: 2600,
      currency: "USD",
    });
    // The source is a label, not authority: provenance stays server-assigned.
    expect(payment.event.source).toBe("Stripe");
    expect(payment.event.trustProvenance).toBe("MANUAL_ATTESTATION");

    const attribution = await service.attributeFromEvent({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      eventId: payment.event.eventId,
    });
    expect(attribution.confidenceClass).toBe("ATTESTED_PAYMENT");
  });

  it("N: FAKE_TEST payment provenance confirms collection in TEST only", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const payment = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "fake_pay_1",
      source: "FAKE_TEST_SOURCE",
      amount: 1900,
      currency: "USD",
      trustProvenance: "FAKE_TEST",
    });
    const attribution = await service.attributeFromEvent({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      eventId: payment.event.eventId,
    });
    expect(attribution.confidenceClass).toBe("CONFIRMED_PAYMENT");
  });

  it("O: FAKE_TEST provenance is denied outside the TEST environment", async () => {
    for (const environment of [
      "DEVELOPMENT",
      "STAGING",
      "PRODUCTION",
    ] as const) {
      expect(
        resolveConfidenceFromProvenance({
          eventKind: "PAYMENT_RECORDED",
          trustProvenance: "FAKE_TEST",
          runtimeEnvironment: environment,
        }),
      ).toMatchObject({ deny: true });
    }

    const production = await economicCase({
      runtimeEnvironment: "PRODUCTION",
    });
    await expect(
      production.service.appendLeadEventWithProvenance({
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        leadId: production.lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-12T13:00:00.000Z",
        externalEventId: "fake_pay_prod",
        source: "FAKE_TEST_SOURCE",
        amount: 1900,
        currency: "USD",
        trustProvenance: "FAKE_TEST",
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_NOT_PERMITTED" });
  });

  it("Q: a trusted CRM cannot mint confirmed cash collection", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const payment = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "crm_pay_1",
      source: "CRM",
      amount: 5000,
      currency: "USD",
      trustProvenance: "TRUSTED_CRM",
    });
    await expect(
      service.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: payment.event.eventId,
      }),
    ).rejects.toMatchObject({ code: "ATTRIBUTION_INVALID" });
  });

  it("S: a booked appointment is ESTIMATED value, never booked revenue", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const appointment = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "APPOINTMENT_BOOKED",
      occurredAt: "2026-09-12T14:00:00.000Z",
      externalEventId: "appt_estimate_1",
      source: "WEBHOOK",
    });
    const attribution = await service.attributeFromEvent({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      eventId: appointment.event.eventId,
    });
    expect(attribution.confidenceClass).toBe("ESTIMATED");
    expect(attribution.attributionType).toBe("APPOINTMENT_VALUE_ESTIMATE");
    expect(attribution.amount).toBe(4800);

    const detail = await service.getCaseDetail({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(detail.economics.estimatedRecoverableValue).toBe(4800);
    expect(detail.economics.bookedRecoveredRevenue).toBeNull();
    expect(detail.economics.confirmedCollectedRevenue).toBeNull();
  });

  it("U: attribution records its provenance, source event, and rule version", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const payment = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "lineage_pay_1",
      source: "PAYMENT_WEBHOOK",
      amount: 2100,
      currency: "USD",
      trustProvenance: "TRUSTED_PAYMENT_SOURCE",
    });
    const attribution = await service.attributeFromEvent({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      eventId: payment.event.eventId,
    });
    expect(attribution).toMatchObject({
      sourceEventId: payment.event.eventId,
      sourceIdentity: "PAYMENT_WEBHOOK",
      trustProvenance: "TRUSTED_PAYMENT_SOURCE",
      confidenceClass: "CONFIRMED_PAYMENT",
      attributionRuleVersion: ATTRIBUTION_RULE_VERSION,
      attributionWindowDays: 30,
    });
  });

  it("V: the sealed record hash binds the provenance lineage", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const payment = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "seal_pay_1",
      source: "MANUAL",
      amount: 2100,
      currency: "USD",
    });
    await service.attributeFromEvent({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      eventId: payment.event.eventId,
    });
    const record = await service.sealRecoveryRecord({
      recoveryCaseId: recoveryCase.recoveryCaseId,
    });
    const { recordHash, ...draft } = record;
    expect(computeRecoveryRecordHash(draft)).toBe(recordHash);
    expect(draft.attributionLineage[0]?.trustProvenance).toBe(
      "MANUAL_ATTESTATION",
    );

    const relabelled = {
      ...draft,
      attributionLineage: draft.attributionLineage.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              trustProvenance: "TRUSTED_PAYMENT_SOURCE" as const,
              confidenceClass: "CONFIRMED_PAYMENT" as const,
            }
          : entry,
      ),
    };
    expect(computeRecoveryRecordHash(relabelled)).not.toBe(recordHash);

    await expect(
      service.sealRecoveryRecord({
        recoveryCaseId: recoveryCase.recoveryCaseId,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_RECORD_CONFLICT" });
  });

  it("W: rejects a cross-tenant economic event", async () => {
    const { service, lead } = await economicCase();
    await expect(
      service.appendLeadEvent({
        customerAccountId: "other_tenant",
        projectId: RR_PROJECT,
        leadId: lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-12T13:00:00.000Z",
        externalEventId: "cross_tenant_pay_1",
        source: "MANUAL",
        amount: 9999,
        currency: "USD",
      }),
    ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });
  });

  it("X: dashboard confirmed totals exclude operator attestation", async () => {
    const { service, lead, recoveryCase } = await economicCase();
    const attested = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "SALE_RECORDED",
      occurredAt: "2026-09-13T09:00:00.000Z",
      externalEventId: "dash_attested_sale",
      source: "MANUAL",
      amount: 9900,
      currency: "USD",
    });
    const crmSale = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "SALE_RECORDED",
      occurredAt: "2026-09-13T12:00:00.000Z",
      externalEventId: "dash_crm_sale",
      source: "CRM",
      amount: 4200,
      currency: "USD",
      trustProvenance: "TRUSTED_CRM",
    });
    const payment = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-14T12:00:00.000Z",
      externalEventId: "dash_payment",
      source: "PAYMENT_WEBHOOK",
      amount: 2100,
      currency: "USD",
      trustProvenance: "TRUSTED_PAYMENT_SOURCE",
    });
    for (const eventId of [
      attested.event.eventId,
      crmSale.event.eventId,
      payment.event.eventId,
    ]) {
      await service.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId,
      });
    }

    const dashboard = await service.getDashboard({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(dashboard.funnel.bookedRecoveredRevenue).toBe(4200);
    expect(dashboard.funnel.confirmedRecoveredRevenue).toBe(2100);
    expect(dashboard.funnel.operatorAttestedRevenue).toBe(9900);
    expect(dashboard.funnel.estimatedPipelineRecovered).toBe(4800);
    expect(dashboard.doctrine.attestedNotConfirmed).toBeTruthy();
  });
});
