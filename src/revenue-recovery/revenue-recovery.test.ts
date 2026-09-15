import { describe, expect, it } from "vitest";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import { isRevenueRecoveryError } from "./errors.js";
import { EXAMPLE_ENVIRONMENT } from "../control-plane/fixtures.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import { computeRecoveryRecordHash } from "./recovery-record.js";
import { withinAttributionWindow } from "./revenue-attribution.js";
import { isWithinContactWindow } from "./recovery-config.js";

describe("Revenue Recovery Engine (unit)", () => {
  it("ingests leads idempotently and conflicts on material divergence", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => "2026-09-12T12:20:00.000Z",
    });
    await service.putConfiguration(demoRecoveryConfig());
    const first = await service.ingestLead(demoLead());
    expect(first.created).toBe(true);
    const second = await service.ingestLead(demoLead());
    expect(second.created).toBe(false);
    expect(second.lead.leadId).toBe(first.lead.leadId);

    await expect(
      service.ingestLead(demoLead({ firstName: "Jordan" })),
    ).rejects.toMatchObject({ code: "LEAD_SOURCE_CONFLICT" });
  });

  it("detects response gap and opens a durable recovery case", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(
      demoRecoveryConfig({ responseGapThresholdMinutes: 15 }),
    );
    const { lead } = await service.ingestLead(demoLead({ createdAt: now }));
    now = "2026-09-12T12:10:00.000Z";
    const early = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(early.gap.eligible).toBe(false);
    expect(early.recoveryCase).toBeNull();

    now = "2026-09-12T12:20:00.000Z";
    const gap = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(gap.gap.eligible).toBe(true);
    expect(gap.recoveryCase?.status).toBe("OPEN");
    expect(gap.recoveryCase?.estimatedRecoverableValue).toBe(4800);

    const again = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(again.recoveryCase?.recoveryCaseId).toBe(
      gap.recoveryCase?.recoveryCaseId,
    );
  });

  it("blocks Phase7 outreach for DO_NOT_CONTACT at time of actuation", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(demoRecoveryConfig());
    const { lead } = await service.ingestLead(
      demoLead({
        consent: { smsOptIn: true, doNotContact: true },
      }),
    );
    now = "2026-09-12T12:30:00.000Z";
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(recoveryCase).toBeTruthy();
    const policy = await service.evaluateCaseContactPolicy(
      recoveryCase!.recoveryCaseId,
    );
    expect(policy.eligible).toBe(false);
    expect(policy.reasonCodes).toContain("DO_NOT_CONTACT");

    await expect(
      service.actuateRecoveryOutreachFromPhase7({
        actionType: "CREATE_CALLBACK_TASK",
        args: {
          recoveryCaseId: recoveryCase!.recoveryCaseId,
          leadId: lead.leadId,
        },
        runId: "run_dnc",
        executionAttemptId: "exa_dnc",
        stepId: "step_dnc",
        stepIdempotencyKey: "idem_dnc",
      }),
    ).rejects.toMatchObject({ code: "CONTACT_NOT_PERMITTED" });
  });

  it("contains SMS recipient to canonical lead and replays one send per step", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service, messaging } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(demoRecoveryConfig());
    const template = await service.saveTemplate({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      channel: "SMS",
      version: 1,
      body: "Hi {{firstName}} — {{businessName}} can help with {{serviceRequested}}. Book: {{bookingLink}}",
      allowedVariables: [
        "firstName",
        "businessName",
        "serviceRequested",
        "bookingLink",
      ],
      enabled: true,
    });
    const { lead } = await service.ingestLead(demoLead());
    const other = await service.ingestLead(
      demoLead({ externalLeadId: "ext_lead_demo_other" }),
    );
    now = "2026-09-12T12:30:00.000Z";
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });

    // A plan may not redirect outreach to a different lead.
    await expect(
      service.actuateRecoveryOutreachFromPhase7({
        actionType: "SEND_RECOVERY_SMS",
        args: {
          recoveryCaseId: recoveryCase!.recoveryCaseId,
          leadId: other.lead.leadId,
          templateId: template.templateId,
          templateVersion: 1,
        },
        runId: "run_sms",
        executionAttemptId: "exa_sms",
        stepId: "step_sms_bad",
        stepIdempotencyKey: "idem_sms_bad",
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_ACTION_TARGET_MISMATCH" });

    const step = {
      actionType: "SEND_RECOVERY_SMS" as const,
      args: {
        recoveryCaseId: recoveryCase!.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: 1,
      },
      runId: "run_sms",
      executionAttemptId: "exa_sms",
      stepId: "step_sms",
      stepIdempotencyKey: "idem_sms",
    };
    const sent = await service.actuateRecoveryOutreachFromPhase7(step);
    expect(sent.replayed).toBe(false);
    expect(sent.attempt.deliveryOutcome).toBe("SIMULATED");
    expect(sent.attempt.channel).toBe("SMS");
    // Recipient is masked and resolved from the canonical lead.
    expect(sent.attempt.recipientRef).not.toContain("5551234567");
    expect(messaging.sent).toHaveLength(1);
    expect(messaging.sent[0]?.action).toMatchObject({
      recipientPhone: lead.phone,
    });

    // Same authorized step re-driven — no second provider call.
    const replay = await service.actuateRecoveryOutreachFromPhase7(step);
    expect(replay.replayed).toBe(true);
    expect(replay.attempt.attemptId).toBe(sent.attempt.attemptId);
    expect(messaging.sent).toHaveLength(1);
  });

  it("inbound response engages case and economic headline separates revenue classes", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(demoRecoveryConfig());
    const template = await service.saveTemplate({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      channel: "SMS",
      version: 1,
      body: "Hello {{firstName}}",
      allowedVariables: ["firstName"],
      enabled: true,
    });
    const { lead } = await service.ingestLead(demoLead());
    now = "2026-09-12T12:30:00.000Z";
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    await service.prepareRecoveryObjective({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      admit: false,
    });
    await service.actuateRecoveryOutreachFromPhase7({
      actionType: "SEND_RECOVERY_SMS",
      args: {
        recoveryCaseId: recoveryCase!.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: 1,
      },
      runId: "run_econ",
      executionAttemptId: "exa_econ",
      stepId: "step_econ",
      stepIdempotencyKey: "idem_econ",
    });

    now = "2026-09-12T13:00:00.000Z";
    const inbound = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "INBOUND_MESSAGE",
      occurredAt: now,
      externalEventId: "sms_in_1",
      source: "FAKE_TEST_SOURCE",
      channel: "SMS",
    });
    const afterEngage = await service.getCaseDetail({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(afterEngage.recoveryCase.status).toBe("ENGAGED");

    const appt = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "APPOINTMENT_BOOKED",
      occurredAt: "2026-09-12T14:00:00.000Z",
      externalEventId: "appt_1",
      source: "FAKE_TEST_SOURCE",
      amount: 4800,
      currency: "USD",
    });
    await service.attributeFromEvent({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      eventId: appt.event.eventId,
    });

    // A generic operator-asserted sale can only ever be ATTESTED.
    const attestedSale = await service.appendLeadEvent({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "SALE_RECORDED",
      occurredAt: "2026-09-13T09:00:00.000Z",
      externalEventId: "attested_sale_1",
      source: "MANUAL",
      amount: 9900,
      currency: "USD",
    });
    const attestedAttribution = await service.attributeFromEvent({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      eventId: attestedSale.event.eventId,
    });
    expect(attestedAttribution.confidenceClass).toBe("ATTESTED_SALE");

    const sale = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "SALE_RECORDED",
      occurredAt: "2026-09-13T12:00:00.000Z",
      externalEventId: "sale_1",
      source: "FAKE_TEST_SOURCE",
      amount: 4200,
      currency: "USD",
      trustProvenance: "TRUSTED_CRM",
    });
    await service.attributeFromEvent({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      eventId: sale.event.eventId,
    });

    const payment = await service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "PAYMENT_RECORDED",
      occurredAt: "2026-09-14T12:00:00.000Z",
      externalEventId: "pay_1",
      source: "FAKE_TEST_SOURCE",
      amount: 2100,
      currency: "USD",
      trustProvenance: "TRUSTED_PAYMENT_SOURCE",
    });
    await service.attributeFromEvent({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      eventId: payment.event.eventId,
    });

    const detail = await service.getCaseDetail({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(detail.economics.estimatedRecoverableValue).toBe(4800);
    expect(detail.economics.bookedRecoveredRevenue).toBe(4200);
    expect(detail.economics.confirmedCollectedRevenue).toBe(2100);
    // Attestation is reported separately and never promoted to booked money.
    expect(detail.economics.operatorAttestedRevenue).toBe(9900);

    const record = await service.sealRecoveryRecord({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
    });
    expect(record.estimatedRecoverableValue).toBe(4800);
    expect(record.bookedRecoveredRevenue).toBe(4200);
    expect(record.confirmedCollectedRevenue).toBe(2100);
    expect(record.operatorAttestedRevenue).toBe(9900);
    expect(record.attributionLineage.map((l) => l.trustProvenance)).toContain(
      "TRUSTED_PAYMENT_SOURCE",
    );
    const { recordHash, ...rest } = record;
    expect(recordHash).toBe(computeRecoveryRecordHash(rest));
    void inbound;
  });

  it("rejects caller-elevated and environment-invalid economic provenance", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const production = createMemoryRevenueRecoveryService({
      nowIso: () => now,
      runtimeEnvironment: "PRODUCTION",
    });
    await production.service.putConfiguration(demoRecoveryConfig());
    const { lead } = await production.service.ingestLead(demoLead());
    now = "2026-09-12T12:30:00.000Z";
    const { recoveryCase } = await production.service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });

    await expect(
      production.service.appendLeadEventWithProvenance({
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        leadId: lead.leadId,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-12T13:00:00.000Z",
        externalEventId: "fake_sale_1",
        source: "FAKE_TEST_SOURCE",
        amount: 4200,
        currency: "USD",
        trustProvenance: "FAKE_TEST",
      }),
    ).rejects.toMatchObject({ code: "PROVENANCE_NOT_PERMITTED" });

    // A payment source cannot mint sale truth even when trusted for payments.
    const crossClaim = await production.service.appendLeadEventWithProvenance({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      leadId: lead.leadId,
      kind: "SALE_RECORDED",
      occurredAt: "2026-09-12T13:00:00.000Z",
      externalEventId: "cross_sale_1",
      source: "WEBHOOK",
      amount: 4200,
      currency: "USD",
      trustProvenance: "TRUSTED_PAYMENT_SOURCE",
    });
    await expect(
      production.service.attributeFromEvent({
        recoveryCaseId: recoveryCase!.recoveryCaseId,
        eventId: crossClaim.event.eventId,
      }),
    ).rejects.toMatchObject({ code: "ATTRIBUTION_INVALID" });
  });

  it("enforces SMS attempt ceiling when contact is otherwise eligible", async () => {
    let now = "2026-09-14T15:00:00.000Z"; // Monday 15:00 UTC inside 9–17
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(
      demoRecoveryConfig({
        maxSmsAttempts: 1,
        cooldownMinutes: 0,
        contactWindow: {
          startHourLocal: 9,
          endHourLocal: 17,
          daysOfWeek: [1, 2, 3, 4, 5],
        },
        timezone: "UTC",
      }),
    );
    const template = await service.saveTemplate({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      channel: "SMS",
      version: 1,
      body: "Hi",
      allowedVariables: [],
      enabled: true,
    });
    const { lead } = await service.ingestLead(
      demoLead({ createdAt: "2026-09-14T12:00:00.000Z" }),
    );
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    await service.actuateRecoveryOutreachFromPhase7({
      actionType: "SEND_RECOVERY_SMS",
      args: {
        recoveryCaseId: recoveryCase!.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: 1,
      },
      runId: "run_ceiling",
      executionAttemptId: "exa_ceiling",
      stepId: "step_ceiling",
      stepIdempotencyKey: "idem_ceiling",
    });
    const policy = await service.evaluateCaseContactPolicy(
      recoveryCase!.recoveryCaseId,
    );
    expect(
      policy.channels.find((c) => c.channel === "SMS")?.reasonCodes,
    ).toContain("ATTEMPT_LIMIT_REACHED");
  });

  it("enforces attempt ceiling and contact window", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(
      demoRecoveryConfig({
        maxSmsAttempts: 1,
        cooldownMinutes: 0,
        contactWindow: {
          startHourLocal: 9,
          endHourLocal: 17,
          daysOfWeek: [1, 2, 3, 4, 5],
        },
        timezone: "UTC",
      }),
    );
    // Saturday 2026-09-12 is day 6 — outside window
    const { lead } = await service.ingestLead(
      demoLead({ createdAt: "2026-09-11T12:00:00.000Z" }),
    );
    now = "2026-09-12T12:00:00.000Z";
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    const policy = await service.evaluateCaseContactPolicy(
      recoveryCase!.recoveryCaseId,
    );
    expect(policy.eligible).toBe(false);
    expect(
      policy.channels.some((c) =>
        c.reasonCodes.includes("CONTACT_WINDOW_CLOSED"),
      ),
    ).toBe(true);

    expect(
      isWithinContactWindow("2026-09-14T15:00:00.000Z", {
        timezone: "UTC",
        contactWindow: {
          startHourLocal: 9,
          endHourLocal: 17,
          daysOfWeek: [1, 2, 3, 4, 5],
        },
      }),
    ).toBe(true);
  });

  it("rejects cross-tenant case reads", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(demoRecoveryConfig());
    const { lead } = await service.ingestLead(demoLead());
    now = "2026-09-12T12:30:00.000Z";
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    await expect(
      service.getCaseDetail({
        recoveryCaseId: recoveryCase!.recoveryCaseId,
        customerAccountId: "other_tenant",
        projectId: RR_PROJECT,
      }),
    ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });
  });

  it("maps recovery objective without creating Phase6 authority", async () => {
    let now = "2026-09-12T12:00:00.000Z";
    const { service } = createMemoryRevenueRecoveryService({
      nowIso: () => now,
    });
    await service.putConfiguration(demoRecoveryConfig());
    const { lead } = await service.ingestLead(demoLead());
    now = "2026-09-12T12:30:00.000Z";
    const { recoveryCase } = await service.detectAndOpenRecoveryCase({
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    const prepared = await service.prepareRecoveryObjective({
      recoveryCaseId: recoveryCase!.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
      admit: false,
    });
    expect(prepared.admissionRequest.objectiveId).toContain("obj_rr_");
    expect(prepared.admissionRequest.constraints.join(" ")).toMatch(/No contact after opt-out/);
    expect(prepared.planningContext.dataClassification).toBe(
      "UNTRUSTED_EXTERNAL_CRM_METADATA",
    );
  });

  it("attribution window rejects events outside bound", () => {
    expect(
      withinAttributionWindow({
        engagementAt: "2026-09-01T00:00:00.000Z",
        eventAt: "2026-10-15T00:00:00.000Z",
        windowDays: 30,
      }),
    ).toBe(false);
    expect(
      withinAttributionWindow({
        engagementAt: "2026-09-01T00:00:00.000Z",
        eventAt: "2026-09-10T00:00:00.000Z",
        windowDays: 30,
      }),
    ).toBe(true);
  });

  it("isRevenueRecoveryError type guard", () => {
    try {
      throw Object.assign(new Error("x"), { code: "LEAD_NOT_FOUND" });
    } catch (e) {
      expect(isRevenueRecoveryError(e)).toBe(false);
    }
  });
});
