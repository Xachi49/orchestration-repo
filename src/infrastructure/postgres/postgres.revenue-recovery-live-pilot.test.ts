/**
 * Focused PostgreSQL live-pilot acceptance: authenticated WEB_FORM ingress +
 * canonical Phase6 → Phase7 → mocked Resend. Accumulated-DB safe.
 *
 * REAL PROVIDER != BYPASS OF GOVERNANCE.
 * No truncate/drop. No real Resend API calls.
 */
import { describe, expect, it } from "vitest";
import type { AdmissionRequest } from "../../admission/request.js";
import {
  ResendRecoveryEmailProvider,
  type ResendTransport,
} from "../../revenue-recovery/resend-provider.js";
import type { RecoveryPilotConfig } from "../../revenue-recovery/pilot-config.js";
import { RECOVERY_EMAIL_POSTCONDITION } from "../../revenue-recovery/recovery-email-planning-model.js";
import {
  advanceToAwaitingApproval,
  approveAwaitingRun,
} from "./postgres-lifecycle-helpers.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import {
  RR_LEAD_CREATED_AT,
  RR_MONDAY_IN_WINDOW,
  createRrPostgresEnv,
  rrAdmissionRequest,
  rrConfigFor,
  uniqueRrIds,
  type RrPostgresEnv,
  type RrUniqueIds,
} from "./postgres.revenue-recovery.helpers.js";

const WEB_SECRET = "pg-live-pilot-web-secret";
const PILOT_EMAIL = "pilot@example.com";

function mockTransport(): ResendTransport & {
  calls: Array<{ to: string; idempotencyKey: string }>;
} {
  const calls: Array<{ to: string; idempotencyKey: string }> = [];
  return {
    calls,
    async sendEmail(input) {
      calls.push({ to: input.to, idempotencyKey: input.idempotencyKey });
      return { id: `re_pg_${calls.length}_${input.idempotencyKey.slice(0, 8)}` };
    },
  };
}

function pilotConfigFor(ids: RrUniqueIds): RecoveryPilotConfig {
  return {
    mode: "LIVE_EMAIL",
    recoveryEmailFrom: "recovery@example.com",
    livePilotCustomerAccountId: ids.customerAccountId,
    livePilotProjectId: ids.projectId,
    webIngestSecret: WEB_SECRET,
    resendApiKey: "re_test_key_not_real",
    resendWebhookSecret: "whsec_dGVzdC1zZWNyZXQtdmFsdWUtZm9yLXNpZ24=",
    livePilotRecipientAllowlist: [PILOT_EMAIL],
  };
}

async function createLivePilotEnv(label: string): Promise<{
  env: RrPostgresEnv;
  transport: ReturnType<typeof mockTransport>;
  messaging: ResendRecoveryEmailProvider;
  pilotConfig: RecoveryPilotConfig;
}> {
  const ids = uniqueRrIds(label);
  const transport = mockTransport();
  const pilotConfig = pilotConfigFor(ids);
  const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
  const env = await createRrPostgresEnv({
    label,
    ids,
    withRecoverySmsPlan: false,
    withRecoveryEmailPlan: true,
    pilotConfig,
    messaging,
  });
  return { env, transport, messaging, pilotConfig };
}

async function seedWebLeadAndEmailCase(
  env: RrPostgresEnv,
  options: {
    submissionId?: string;
    consent?: { email?: boolean; sms?: boolean; doNotContact?: boolean };
    estimatedValue?: number;
  } = {},
) {
  const rr = env.stack.revenueRecoveryService;
  await rr.putConfiguration(
    rrConfigFor(env.ids, {
      allowedChannels: ["EMAIL", "SMS"],
      maxEmailAttempts: 3,
      cooldownMinutes: 0,
    }),
  );
  const template = await rr.saveTemplate({
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
    channel: "EMAIL",
    version: 1,
    body: "Hi {{firstName}} — {{businessName}} can still help with {{serviceRequested}}.",
    allowedVariables: ["firstName", "businessName", "serviceRequested"],
    enabled: true,
  });
  const { lead } = await rr.ingestWebLead({
    tokenHeader: WEB_SECRET,
    payload: {
      submissionId:
        options.submissionId ?? uniquePostgresTestId("web_sub"),
      submittedAt: RR_LEAD_CREATED_AT,
      email: PILOT_EMAIL,
      firstName: "Pat",
      serviceRequested: "AC repair",
      ...(options.estimatedValue !== undefined
        ? { estimatedValue: options.estimatedValue, currency: "USD" }
        : {}),
      consent: {
        email: options.consent?.email ?? true,
        ...(options.consent?.sms !== undefined ? { sms: options.consent.sms } : {}),
        ...(options.consent?.doNotContact !== undefined
          ? { doNotContact: options.consent.doNotContact }
          : {}),
      },
    },
  });
  const { recoveryCase } = await rr.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
  });
  if (!recoveryCase) {
    throw new Error("expected open recovery case from web lead");
  }
  env.emailPlanBinding.recoveryCaseId = recoveryCase.recoveryCaseId;
  env.emailPlanBinding.leadId = lead.leadId;
  env.emailPlanBinding.templateId = template.templateId;
  env.emailPlanBinding.templateVersion = template.version;
  return { rr, lead, recoveryCase, template };
}

function emailAdmissionRequest(
  env: RrPostgresEnv,
  label: string,
  recoveryCaseId: string,
): AdmissionRequest {
  return {
    ...rrAdmissionRequest({
      label,
      projectId: env.ids.projectId,
      recoveryCaseId,
    }),
    requestedOutcome: "Recover one unanswered inbound service lead via email",
    acceptanceCriteria: [RECOVERY_EMAIL_POSTCONDITION],
    constraints: ["No contact after opt-out"],
    nonGoals: ["Contacting leads who opted out"],
  };
}

async function routeEmailRun(
  env: RrPostgresEnv,
  label: string,
  recoveryCaseId: string,
) {
  const request = emailAdmissionRequest(env, label, recoveryCaseId);
  const awaiting = await advanceToAwaitingApproval(env.stack, request);
  return { request, ...awaiting };
}

describe("Revenue Recovery live-pilot PostgreSQL acceptance", () => {
  it("1–6: web lead → Phase6 → Phase7 → one mocked Resend send; replay idempotent", async () => {
    const { env, transport } = await createLivePilotEnv("lp16");
    try {
      const { lead, recoveryCase, template } =
        await seedWebLeadAndEmailCase(env, { estimatedValue: 4800 });
      expect(lead.source).toBe("WEB_FORM");
      expect(lead.estimatedValue).toBe(4800);

      const routed = await routeEmailRun(
        env,
        "lp16",
        recoveryCase.recoveryCaseId,
      );
      expect((await env.stack.runs.getById(routed.runId))?.state).toBe(
        "AWAITING_APPROVAL",
      );
      expect(
        await env.stack.authorizationRecords.getLatestByRun(routed.runId),
      ).toBeNull();
      expect(transport.calls).toHaveLength(0);

      const approved = await approveAwaitingRun(env.stack, {
        runId: routed.runId,
        approvalRequestId: routed.approvalRequestId,
        request: routed.request,
      });
      expect(
        await env.stack.authorizationRecords.getLatestByRun(approved.runId),
      ).toBeTruthy();

      const result = await env.stack.execution.execute(approved.runId);
      expect(result.status).toBe("EXECUTION_SUCCEEDED");
      expect(transport.calls).toHaveLength(1);

      const detail = await env.stack.revenueRecoveryService.getCaseDetail({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(detail.attempts).toHaveLength(1);
      const attempt = detail.attempts[0]!;
      expect(attempt.providerName).toBe("RESEND");
      expect(attempt.providerIdempotencyKey).toBeTruthy();
      expect(transport.calls[0]!.idempotencyKey).toBe(
        attempt.providerIdempotencyKey,
      );

      const replayedRun = await env.stack.execution.execute(approved.runId);
      expect(replayedRun.executionAttemptId).toBe(result.executionAttemptId);
      expect(transport.calls).toHaveLength(1);

      const invocation = env.stack.actuator.invocations.find(
        (i) => i.method === "sendRecoveryEmail",
      )?.input as {
        executionAttemptId: string;
        stepId: string;
        stepIdempotencyKey: string;
      };
      expect(invocation).toBeTruthy();
      const { mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const path = await import("node:path");
      const replayedStep = await env.stack.actuator.sendRecoveryEmail({
        runId: approved.runId,
        executionAttemptId: invocation.executionAttemptId,
        stepId: invocation.stepId,
        stepIdempotencyKey: invocation.stepIdempotencyKey,
        artifactRoot: mkdtempSync(path.join(tmpdir(), "rr-lp-")),
        args: {
          recoveryCaseId: recoveryCase.recoveryCaseId,
          leadId: lead.leadId,
          templateId: template.templateId,
          templateVersion: 1,
        },
        nowIso: env.clock.nowIso(),
        runtime: { timeoutMs: 30_000 },
      });
      expect(replayedStep.replayed).toBe(true);
      expect(transport.calls).toHaveLength(1);
      expect(
        (
          await env.stack.revenueRecoveryService.getCaseDetail({
            recoveryCaseId: recoveryCase.recoveryCaseId,
            customerAccountId: env.ids.customerAccountId,
            projectId: env.ids.projectId,
          })
        ).attempts,
      ).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 180_000);

  it("7: DNC after approval before actuation → zero provider calls", async () => {
    const { env, transport } = await createLivePilotEnv("lp7");
    try {
      const { lead, recoveryCase, template } =
        await seedWebLeadAndEmailCase(env);
      const routed = await routeEmailRun(
        env,
        "lp7",
        recoveryCase.recoveryCaseId,
      );
      const approved = await approveAwaitingRun(env.stack, {
        runId: routed.runId,
        approvalRequestId: routed.approvalRequestId,
        request: routed.request,
      });
      expect(transport.calls).toHaveLength(0);

      // Mutate contact eligibility after approval (time-of-action recheck).
      await env.stack.revenueRecoveryService.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "DO_NOT_CONTACT",
        occurredAt: RR_MONDAY_IN_WINDOW,
        externalEventId: uniquePostgresTestId("dnc"),
        source: "MANUAL",
      });

      const executed = await env.stack.execution.execute(approved.runId);
      expect(["FAILED", "EXECUTION_CONTAINED"]).toContain(executed.status);
      expect(transport.calls).toHaveLength(0);
      void template;
    } finally {
      await env.close();
    }
  }, 180_000);

  it("8: wrong pilot tenant/project → zero provider calls", async () => {
    const ids = uniqueRrIds("lp8");
    const transport = mockTransport();
    // Pilot gate bound to a DIFFERENT tenant than the case material.
    const pilotConfig: RecoveryPilotConfig = {
      ...pilotConfigFor({
        customerAccountId: "other_pilot_customer",
        projectId: "other_pilot_project",
        externalLeadId: ids.externalLeadId,
      }),
      // Still need web ingest tenant for ingestWebLead binding — use case tenant
      // for ingest, but LIVE gate points elsewhere via isLivePilotTenant.
      livePilotCustomerAccountId: "other_pilot_customer",
      livePilotProjectId: "other_pilot_project",
      webIngestSecret: WEB_SECRET,
    };
    // For ingestWebLead, tenant comes from pilot config — so seed via ingestLead.
    const messaging = new ResendRecoveryEmailProvider(pilotConfig, transport);
    const env = await createRrPostgresEnv({
      label: "lp8",
      ids,
      withRecoverySmsPlan: false,
      withRecoveryEmailPlan: true,
      pilotConfig: {
        ...pilotConfig,
        // Allow ingest path tests via direct ingestLead under ids tenant
        livePilotCustomerAccountId: ids.customerAccountId,
        livePilotProjectId: ids.projectId,
      },
      messaging: new ResendRecoveryEmailProvider(
        {
          ...pilotConfig,
          livePilotCustomerAccountId: "other_pilot_customer",
          livePilotProjectId: "other_pilot_project",
        },
        transport,
      ),
    });
    try {
      const rr = env.stack.revenueRecoveryService;
      await rr.putConfiguration(
        rrConfigFor(ids, {
          allowedChannels: ["EMAIL"],
          cooldownMinutes: 0,
        }),
      );
      const template = await rr.saveTemplate({
        customerAccountId: ids.customerAccountId,
        projectId: ids.projectId,
        channel: "EMAIL",
        version: 1,
        body: "Hi {{firstName}}",
        allowedVariables: ["firstName"],
        enabled: true,
      });
      const { lead } = await rr.ingestLead({
        customerAccountId: ids.customerAccountId,
        projectId: ids.projectId,
        externalLeadId: ids.externalLeadId,
        source: "FAKE_TEST_SOURCE",
        createdAt: RR_LEAD_CREATED_AT,
        email: PILOT_EMAIL,
        firstName: "X",
        consent: { emailOptIn: true },
      });
      const { recoveryCase } = await rr.detectAndOpenRecoveryCase({
        leadId: lead.leadId,
        customerAccountId: ids.customerAccountId,
        projectId: ids.projectId,
      });
      expect(recoveryCase).toBeTruthy();
      await expect(
        rr.actuateRecoveryOutreachFromPhase7({
          actionType: "SEND_RECOVERY_EMAIL",
          args: {
            recoveryCaseId: recoveryCase!.recoveryCaseId,
            leadId: lead.leadId,
            templateId: template.templateId,
            templateVersion: 1,
          },
          runId: "run_lp8",
          executionAttemptId: "exec_lp8",
          stepId: "step_lp8",
          stepIdempotencyKey: "idem_lp8",
        }),
      ).rejects.toMatchObject({ code: "LIVE_PILOT_TENANT_DENIED" });
      expect(transport.calls).toHaveLength(0);
      void messaging;
    } finally {
      await env.close();
    }
  }, 120_000);

  it("9–10: delivery webhook updates exact attempt; duplicate is idempotent", async () => {
    const { env, transport } = await createLivePilotEnv("lp910");
    try {
      const { recoveryCase } = await seedWebLeadAndEmailCase(env);
      const routed = await routeEmailRun(
        env,
        "lp910",
        recoveryCase.recoveryCaseId,
      );
      const approved = await approveAwaitingRun(env.stack, {
        runId: routed.runId,
        approvalRequestId: routed.approvalRequestId,
        request: routed.request,
      });
      await env.stack.execution.execute(approved.runId);
      expect(transport.calls).toHaveLength(1);

      const detailBefore =
        await env.stack.revenueRecoveryService.getCaseDetail({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          customerAccountId: env.ids.customerAccountId,
          projectId: env.ids.projectId,
        });
      const providerMessageId = detailBefore.attempts[0]!.providerMessageId!;
      expect(providerMessageId).toBeTruthy();

      const eventKey = uniquePostgresTestId("svix_lp910");
      const first =
        await env.stack.revenueRecoveryService.applyResendWebhookEvent({
          providerEventKey: eventKey,
          eventKind: "email.delivered",
          providerMessageId,
          occurredAt: RR_MONDAY_IN_WINDOW,
        });
      const second =
        await env.stack.revenueRecoveryService.applyResendWebhookEvent({
          providerEventKey: eventKey,
          eventKind: "email.delivered",
          providerMessageId,
          occurredAt: RR_MONDAY_IN_WINDOW,
        });
      expect(first.applied).toBe(true);
      expect(second.replayed).toBe(true);

      const detailAfter =
        await env.stack.revenueRecoveryService.getCaseDetail({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          customerAccountId: env.ids.customerAccountId,
          projectId: env.ids.projectId,
        });
      expect(detailAfter.attempts).toHaveLength(1);
      expect(detailAfter.attempts[0]!.deliveryState).toBe("DELIVERED");
      expect(detailAfter.attempts[0]!.providerMessageId).toBe(
        providerMessageId,
      );
    } finally {
      await env.close();
    }
  }, 180_000);
});
