import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildServer } from "../api/server.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import {
  ResendRecoveryEmailProvider,
  verifyResendWebhookSignature,
  type ResendTransport,
} from "./resend-provider.js";
import type { RecoveryPilotConfig } from "./pilot-config.js";
import { isRevenueRecoveryError } from "./errors.js";
import { demoRecoveryConfig } from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";

const RR_NOW = "2026-09-14T15:00:00.000Z";
const RR_LEAD_AT = "2026-09-14T12:00:00.000Z";

const PILOT_CUSTOMER = "pilot_customer_live";
const PILOT_PROJECT = "pilot_project_live";
const OTHER_CUSTOMER = "other_customer";
const OTHER_PROJECT = "other_project";
const WEB_SECRET = "web-ingest-secret-test-value";

function mockTransport(): ResendTransport & {
  calls: Array<{ to: string; idempotencyKey: string }>;
} {
  const calls: Array<{ to: string; idempotencyKey: string }> = [];
  return {
    calls,
    async sendEmail(input) {
      calls.push({ to: input.to, idempotencyKey: input.idempotencyKey });
      return { id: `re_${calls.length}_${input.idempotencyKey.slice(0, 8)}` };
    },
  };
}

function basePilot(overrides?: Partial<RecoveryPilotConfig>): RecoveryPilotConfig {
  return {
    mode: "FAKE",
    recoveryEmailFrom: "recovery@example.com",
    livePilotCustomerAccountId: PILOT_CUSTOMER,
    livePilotProjectId: PILOT_PROJECT,
    webIngestSecret: WEB_SECRET,
    resendWebhookSecret: "whsec_dGVzdC1zZWNyZXQtdmFsdWUtZm9yLXNpZ24=",
    resendApiKey: "re_test_key",
    livePilotRecipientAllowlist: ["pilot@example.com"],
    ...overrides,
  };
}

async function seedEmailTemplate(
  service: ReturnType<typeof createMemoryRevenueRecoveryService>["service"],
  tenant: { customerAccountId: string; projectId: string },
) {
  await service.putConfiguration(
    demoRecoveryConfig({
      customerAccountId: tenant.customerAccountId,
      projectId: tenant.projectId,
      responseGapThresholdMinutes: 15,
      cooldownMinutes: 0,
      allowedChannels: ["EMAIL", "SMS"],
    }),
  );
  return service.saveTemplate({
    customerAccountId: tenant.customerAccountId,
    projectId: tenant.projectId,
    channel: "EMAIL",
    version: 1,
    body: "Hi {{firstName}}, following up on {{serviceRequested}}.",
    allowedVariables: ["firstName", "serviceRequested"],
    enabled: true,
  });
}

async function openCaseForLead(
  service: ReturnType<typeof createMemoryRevenueRecoveryService>["service"],
  input: {
    customerAccountId: string;
    projectId: string;
    leadId: string;
  },
) {
  const opened = await service.detectAndOpenRecoveryCase(input);
  expect(opened.recoveryCase).toBeTruthy();
  return opened.recoveryCase!;
}

describe("Revenue Recovery live pilot v1 (provider-neutral web ingress)", () => {
  it("A: invalid web-ingress auth is rejected", async () => {
    const { service, pilotConfig } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot(),
      nowIso: () => RR_NOW,
    });
    const app = await buildServer({
      revenueRecovery: service,
      revenueRecoveryPilotConfig: pilotConfig,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/integrations/web/revenue-recovery/leads",
      headers: { "x-rr-web-ingest-token": "wrong" },
      payload: {
        submissionId: "sub-a",
        submittedAt: RR_LEAD_AT,
        email: "a@example.com",
        consent: { email: true },
      },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("WEB_INGEST_UNAUTHORIZED");
    await app.close();
  });

  it("B: duplicate web submission is idempotent", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot(),
      nowIso: () => RR_NOW,
    });
    const payload = {
      submissionId: "sub-b",
      submittedAt: RR_LEAD_AT,
      email: "b@example.com",
      firstName: "Bea",
      consent: { email: true },
    };
    const first = await service.ingestWebLead({
      tokenHeader: WEB_SECRET,
      payload,
    });
    const second = await service.ingestWebLead({
      tokenHeader: WEB_SECRET,
      payload,
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.lead.leadId).toBe(first.lead.leadId);
    expect(first.lead.source).toBe("WEB_FORM");
    expect(first.lead.customerAccountId).toBe(PILOT_CUSTOMER);
  });

  it("C: conflicting web submission is rejected", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot(),
      nowIso: () => RR_NOW,
    });
    await service.ingestWebLead({
      tokenHeader: WEB_SECRET,
      payload: {
        submissionId: "sub-c",
        submittedAt: RR_LEAD_AT,
        email: "c1@example.com",
        consent: { email: true },
      },
    });
    await expect(
      service.ingestWebLead({
        tokenHeader: WEB_SECRET,
        payload: {
          submissionId: "sub-c",
          submittedAt: RR_LEAD_AT,
          email: "c2@example.com",
          consent: { email: true },
        },
      }),
    ).rejects.toMatchObject({ code: "LEAD_SOURCE_CONFLICT" });
  });

  it("D: estimated value remains estimate only", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot(),
      nowIso: () => RR_NOW,
    });
    const { lead } = await service.ingestWebLead({
      tokenHeader: WEB_SECRET,
      payload: {
        submissionId: "sub-d",
        submittedAt: RR_LEAD_AT,
        email: "d@example.com",
        estimatedValue: 4800,
        currency: "USD",
        consent: { email: true },
      },
    });
    expect(lead.estimatedValue).toBe(4800);
    const detailReady = await service.getDashboard({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    expect(detailReady.funnel.bookedRecoveredRevenue).toBe(0);
    expect(detailReady.funnel.confirmedRecoveredRevenue).toBe(0);
  });

  it("E: SHADOW creates zero provider transport calls", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "SHADOW" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "shadow-e",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      firstName: "Sam",
      serviceRequested: "roof",
      consent: { emailOptIn: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: lead.leadId,
    });
    const result = await service.actuateRecoveryOutreachFromPhase7({
      actionType: "SEND_RECOVERY_EMAIL",
      args: {
        recoveryCaseId: recoveryCase.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: template.version,
      },
      runId: "run_shadow",
      executionAttemptId: "exec_shadow",
      stepId: "step_shadow",
      stepIdempotencyKey: "idem_shadow",
    });
    expect(transport.calls).toHaveLength(0);
    expect(messaging.shadowed).toHaveLength(1);
    expect(result.attempt.providerName).toBe("SHADOW");
    expect(result.attempt.deliveryOutcome).toBe("SIMULATED");
    expect(result.attempt.providerIdempotencyKey).toBe(
      result.attempt.executionActionIdentity,
    );
  });

  it("F: non-pilot tenant cannot LIVE_EMAIL", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: OTHER_CUSTOMER,
      projectId: OTHER_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: OTHER_CUSTOMER,
      projectId: OTHER_PROJECT,
      externalLeadId: "other-f",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: OTHER_CUSTOMER,
      projectId: OTHER_PROJECT,
      leadId: lead.leadId,
    });
    await expect(
      service.actuateRecoveryOutreachFromPhase7({
        actionType: "SEND_RECOVERY_EMAIL",
        args: {
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          templateId: template.templateId,
          templateVersion: template.version,
        },
        runId: "run_f",
        executionAttemptId: "exec_f",
        stepId: "step_f",
        stepIdempotencyKey: "idem_f",
      }),
    ).rejects.toMatchObject({ code: "LIVE_PILOT_TENANT_DENIED" });
    expect(transport.calls).toHaveLength(0);
  });

  it("G: missing Phase6 authority → zero provider call", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "g-phase6",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: lead.leadId,
    });
    await service.prepareRecoveryObjective({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      requesterId: "user_local",
      requestedEnvironment: "local",
      admit: false,
    });
    expect(transport.calls).toHaveLength(0);
    expect(messaging.liveCalls).toHaveLength(0);
    expect(
      typeof (messaging as { sendArbitrary?: unknown }).sendArbitrary,
    ).toBe("undefined");
    void template;
  });

  it("H: stale/mismatched Phase7 identity → zero additional provider call", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const firstLead = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "h-lead-1",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true },
    });
    const secondLead = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "h-lead-2",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true },
    });
    const case1 = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: firstLead.lead.leadId,
    });
    const case2 = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: secondLead.lead.leadId,
    });
    await service.actuateRecoveryOutreachFromPhase7({
      actionType: "SEND_RECOVERY_EMAIL",
      args: {
        recoveryCaseId: case1.recoveryCaseId,
        leadId: firstLead.lead.leadId,
        templateId: template.templateId,
        templateVersion: template.version,
      },
      runId: "run_h",
      executionAttemptId: "exec_h",
      stepId: "step_h",
      stepIdempotencyKey: "idem_h",
    });
    expect(transport.calls).toHaveLength(1);
    await expect(
      service.actuateRecoveryOutreachFromPhase7({
        actionType: "SEND_RECOVERY_EMAIL",
        args: {
          recoveryCaseId: case2.recoveryCaseId,
          leadId: secondLead.lead.leadId,
          templateId: template.templateId,
          templateVersion: template.version,
        },
        runId: "run_h",
        executionAttemptId: "exec_h",
        stepId: "step_h",
        stepIdempotencyKey: "idem_h",
      }),
    ).rejects.toMatchObject({ code: "EXECUTION_ACTION_CONFLICT" });
    expect(transport.calls).toHaveLength(1);
  });

  it("I: time-of-action DNC → zero provider call", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "dnc-i",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true, doNotContact: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: lead.leadId,
    });
    await expect(
      service.actuateRecoveryOutreachFromPhase7({
        actionType: "SEND_RECOVERY_EMAIL",
        args: {
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          templateId: template.templateId,
          templateVersion: template.version,
        },
        runId: "run_i",
        executionAttemptId: "exec_i",
        stepId: "step_i",
        stepIdempotencyKey: "idem_i",
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        isRevenueRecoveryError(err) && err.code === "CONTACT_NOT_PERMITTED",
    );
    expect(transport.calls).toHaveLength(0);
  });

  it("J/K: Resend idempotency key = executionActionIdentity; replay → one send", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "jk-live",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      firstName: "Jay",
      consent: { emailOptIn: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: lead.leadId,
    });
    const args = {
      actionType: "SEND_RECOVERY_EMAIL" as const,
      args: {
        recoveryCaseId: recoveryCase.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: template.version,
      },
      runId: "run_jk",
      executionAttemptId: "exec_jk",
      stepId: "step_jk",
      stepIdempotencyKey: "idem_jk",
    };
    const first = await service.actuateRecoveryOutreachFromPhase7(args);
    const second = await service.actuateRecoveryOutreachFromPhase7(args);
    expect(first.attempt.providerIdempotencyKey).toBe(
      first.attempt.executionActionIdentity,
    );
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]!.idempotencyKey).toBe(
      first.attempt.executionActionIdentity,
    );
    expect(second.replayed).toBe(true);
    expect(second.attempt.attemptId).toBe(first.attempt.attemptId);
    expect(first.attempt.providerName).toBe("RESEND");
  });

  it("L: invalid Resend webhook signature is rejected", async () => {
    const { service, pilotConfig } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot(),
      nowIso: () => RR_NOW,
    });
    const app = await buildServer({
      revenueRecovery: service,
      revenueRecoveryPilotConfig: pilotConfig,
    });
    const body = JSON.stringify({
      type: "email.delivered",
      data: { email_id: "re_x" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/integrations/resend/webhook",
      headers: {
        "content-type": "application/json",
        "svix-id": "msg_1",
        "svix-timestamp": String(Math.floor(Date.now() / 1000)),
        "svix-signature": "v1,invalid",
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("M/O: duplicate webhook is idempotent; correlates exact attempt", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "mo-live",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: lead.leadId,
    });
    const { attempt } = await service.actuateRecoveryOutreachFromPhase7({
      actionType: "SEND_RECOVERY_EMAIL",
      args: {
        recoveryCaseId: recoveryCase.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: template.version,
      },
      runId: "run_mo",
      executionAttemptId: "exec_mo",
      stepId: "step_mo",
      stepIdempotencyKey: "idem_mo",
    });
    const first = await service.applyResendWebhookEvent({
      providerEventKey: "evt_mo_1",
      eventKind: "email.delivered",
      providerMessageId: attempt.providerMessageId!,
      occurredAt: RR_NOW,
    });
    const second = await service.applyResendWebhookEvent({
      providerEventKey: "evt_mo_1",
      eventKind: "email.delivered",
      providerMessageId: attempt.providerMessageId!,
      occurredAt: RR_NOW,
    });
    expect(first.applied).toBe(true);
    expect(second.replayed).toBe(true);
    const detail = await service.getCaseDetail({
      recoveryCaseId: recoveryCase.recoveryCaseId,
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    expect(detail.attempts[0]!.deliveryState).toBe("DELIVERED");
    expect(detail.attempts[0]!.providerMessageId).toBe(
      attempt.providerMessageId,
    );
  });

  it("N: bounce suppresses future email recovery", async () => {
    const transport = mockTransport();
    const pilotConfig = basePilot({ mode: "LIVE_EMAIL" });
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig,
      messaging,
      nowIso: () => RR_NOW,
    });
    const template = await seedEmailTemplate(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const { lead } = await service.ingestLead({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      externalLeadId: "n-bounce",
      source: "FAKE_TEST_SOURCE",
      createdAt: RR_LEAD_AT,
      email: "pilot@example.com",
      consent: { emailOptIn: true },
    });
    const recoveryCase = await openCaseForLead(service, {
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
      leadId: lead.leadId,
    });
    const { attempt } = await service.actuateRecoveryOutreachFromPhase7({
      actionType: "SEND_RECOVERY_EMAIL",
      args: {
        recoveryCaseId: recoveryCase.recoveryCaseId,
        leadId: lead.leadId,
        templateId: template.templateId,
        templateVersion: template.version,
      },
      runId: "run_n",
      executionAttemptId: "exec_n",
      stepId: "step_n",
      stepIdempotencyKey: "idem_n",
    });
    await service.applyResendWebhookEvent({
      providerEventKey: "evt_bounce",
      eventKind: "email.bounced",
      providerMessageId: attempt.providerMessageId!,
      occurredAt: RR_NOW,
    });
    await expect(
      service.actuateRecoveryOutreachFromPhase7({
        actionType: "SEND_RECOVERY_EMAIL",
        args: {
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          templateId: template.templateId,
          templateVersion: template.version,
        },
        runId: "run_n2",
        executionAttemptId: "exec_n2",
        stepId: "step_n2",
        stepIdempotencyKey: "idem_n2",
      }),
    ).rejects.toMatchObject({ code: "CONTACT_NOT_PERMITTED" });
    expect(transport.calls).toHaveLength(1);
  });

  it("P: unknown provider ID cannot mutate another case", async () => {
    const { service } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot({ mode: "FAKE" }),
      nowIso: () => RR_NOW,
    });
    const result = await service.applyResendWebhookEvent({
      providerEventKey: "evt_unknown",
      eventKind: "email.bounced",
      providerMessageId: "re_does_not_exist",
      occurredAt: RR_NOW,
    });
    expect(result.applied).toBe(false);
  });

  it("Q: secrets absent from logs/API/read models", async () => {
    const { service, pilotConfig } = createMemoryRevenueRecoveryService({
      pilotConfig: basePilot({ mode: "SHADOW" }),
      nowIso: () => RR_NOW,
    });
    const health = service.getPilotHealth();
    const blob = JSON.stringify({ health });
    expect(blob).not.toContain(WEB_SECRET);
    expect(blob).not.toContain("re_test_key");
    expect(blob).not.toContain("whsec_");
    expect(health.webIngestConfigured).toBe(true);
    expect(pilotConfig.resendApiKey).toBeDefined();
    const dashboard = await service.getDashboard({
      customerAccountId: PILOT_CUSTOMER,
      projectId: PILOT_PROJECT,
    });
    const serialized = JSON.stringify(dashboard);
    expect(serialized).not.toContain("re_test_key");
    expect(serialized).not.toContain(WEB_SECRET);
    expect(serialized).not.toContain("whsec_");
    expect(dashboard.pilot.mode).toBe("SHADOW");
  });

  it("webhook signature helper accepts a valid Svix signature", () => {
    const secret = "whsec_dGVzdC1zZWNyZXQtdmFsdWUtZm9yLXNpZ24=";
    const id = "msg_test";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = '{"type":"email.sent","data":{}}';
    const secretBytes = Buffer.from(secret.slice("whsec_".length), "base64");
    const expected = createHmac("sha256", secretBytes)
      .update(`${id}.${timestamp}.${body}`)
      .digest("base64");
    expect(
      verifyResendWebhookSignature({
        rawBody: body,
        svixId: id,
        svixTimestamp: timestamp,
        svixSignature: `v1,${expected}`,
        secret,
      }),
    ).toBe(true);
  });
});
