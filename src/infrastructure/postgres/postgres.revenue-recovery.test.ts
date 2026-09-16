/**
 * Product PostgreSQL acceptance scenarios for Continuum Revenue Recovery.
 * Excluded from default `npm test` (postgres.*.test.ts pattern); run via
 * `npm run test:postgres` against a reachable TEST_DATABASE_URL.
 *
 * RESPONSE GAP != AUTHORIZATION TO CONTACT. ELIGIBLE != AUTHORIZED.
 * APPROVED != SENT. EVENT KIND != TRUST PROVENANCE.
 * ESTIMATED != BOOKED != COLLECTED.
 *
 * Every scenario executes against durable Postgres with unique tenant,
 * project, and lead identity. Nothing is truncated, dropped, or cleaned.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AdmissionRequest } from "../../admission/request.js";
import type { LeadIngestInput } from "../../revenue-recovery/lead.js";
import type { RecoveryConfigurationInput } from "../../revenue-recovery/recovery-config.js";
import { computeRecoveryRecordHash } from "../../revenue-recovery/recovery-record.js";
import { RECOVERY_SMS_POSTCONDITION } from "../../revenue-recovery/recovery-sms-planning-model.js";
import {
  advanceToAwaitingApproval,
  approveAwaitingRun,
} from "./postgres-lifecycle-helpers.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import {
  EXAMPLE_ENVIRONMENT,
  PRODUCT_POSTGRES_SCENARIOS,
  RR_LEAD_CREATED_AT,
  RR_MONDAY_IN_WINDOW,
  RR_SATURDAY_OUTSIDE_WINDOW,
  createRrPostgresEnv,
  rrAdmissionRequest,
  rrConfigFor,
  rrLeadFor,
  uniqueRrIds,
  type RrPostgresEnv,
} from "./postgres.revenue-recovery.helpers.js";

const RAW_LEAD_PHONE = "+15551234567";
const RAW_LEAD_EMAIL = "alex@example.com";

const TEMPLATE_BODY =
  "Hi {{firstName}} — {{businessName}} can still help with {{serviceRequested}}. Book: {{bookingLink}}";
const TEMPLATE_VARIABLES = [
  "firstName",
  "businessName",
  "serviceRequested",
  "bookingLink",
];

/** Disposable artifact root for direct Phase7 SafeActuator invocations. */
function artifactRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "rr-pg-"));
}

/**
 * Durable configuration + SMS template + lead + open RecoveryCase, with the
 * plan binding filled so a later plan() names this case/lead/template only.
 */
async function seedRecoveryCase(
  env: RrPostgresEnv,
  options: {
    configOverrides?: Partial<RecoveryConfigurationInput>;
    leadOverrides?: Partial<LeadIngestInput>;
  } = {},
) {
  const rr = env.stack.revenueRecoveryService;
  await rr.putConfiguration(rrConfigFor(env.ids, options.configOverrides ?? {}));
  const template = await rr.saveTemplate({
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
    channel: "SMS",
    version: 1,
    body: TEMPLATE_BODY,
    allowedVariables: TEMPLATE_VARIABLES,
    enabled: true,
  });
  const { lead } = await rr.ingestLead(
    rrLeadFor(env.ids, options.leadOverrides ?? {}),
  );
  const { gap, recoveryCase } = await rr.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
  });
  if (!recoveryCase) {
    throw new Error(`expected an open recovery case (${gap.reasonCode})`);
  }
  env.planBinding.recoveryCaseId = recoveryCase.recoveryCaseId;
  env.planBinding.leadId = lead.leadId;
  env.planBinding.templateId = template.templateId;
  env.planBinding.templateVersion = template.version;
  return {
    rr,
    messaging: env.stack.revenueRecoveryMessaging,
    template,
    lead,
    recoveryCase,
    gap,
  };
}

/**
 * Canonical objective for bounded recovery outreach. The acceptance criterion
 * matches the single postcondition the recovery planning model proposes.
 */
function recoveryAdmissionRequest(
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
    requestedOutcome: "Recover one unanswered inbound service lead",
    acceptanceCriteria: [RECOVERY_SMS_POSTCONDITION],
    constraints: ["No contact after opt-out"],
    nonGoals: ["Contacting leads who opted out"],
  };
}

/** Phase2 → Phase5: routed to AWAITING_APPROVAL with no AuthorizationRecord. */
async function routeRecoveryRun(
  env: RrPostgresEnv,
  label: string,
  recoveryCaseId: string,
) {
  const request = recoveryAdmissionRequest(env, label, recoveryCaseId);
  const awaiting = await advanceToAwaitingApproval(env.stack, request);
  return { request, ...awaiting };
}

/** Phase2 → Phase6 → Phase7 for one bounded outreach step. */
async function executeGovernedOutreach(
  env: RrPostgresEnv,
  label: string,
  recoveryCaseId: string,
) {
  const routed = await routeRecoveryRun(env, label, recoveryCaseId);
  const approved = await approveAwaitingRun(env.stack, {
    runId: routed.runId,
    approvalRequestId: routed.approvalRequestId,
    request: routed.request,
  });
  const result = await env.stack.execution.execute(approved.runId);
  return { ...approved, result };
}

function caseDetail(env: RrPostgresEnv, recoveryCaseId: string) {
  return env.stack.revenueRecoveryService.getCaseDetail({
    recoveryCaseId,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
  });
}

describe("Revenue Recovery product Postgres scenarios (catalog)", () => {
  it("declares scenarios A–O + economic headline", () => {
    expect(PRODUCT_POSTGRES_SCENARIOS).toContain("A_GAP_TO_RECOVERY");
    expect(PRODUCT_POSTGRES_SCENARIOS).toContain("O_TENANT_ISOLATION");
    expect(PRODUCT_POSTGRES_SCENARIOS).toContain("ECONOMIC_HEADLINE_4800");
    expect(PRODUCT_POSTGRES_SCENARIOS.length).toBeGreaterThanOrEqual(16);
  });
});

describe("Revenue Recovery durable recovery lifecycle (Postgres)", () => {
  it("A: response gap opens a durable case and binds an orchestrator run", async () => {
    const env = await createRrPostgresEnv({
      label: "a",
      withRecoverySmsPlan: false,
    });
    try {
      const rr = env.stack.revenueRecoveryService;
      await rr.putConfiguration(rrConfigFor(env.ids));
      const { lead } = await rr.ingestLead(
        rrLeadFor(env.ids, { createdAt: RR_LEAD_CREATED_AT }),
      );

      // Threshold not elapsed: a gap that has not matured is not a case.
      env.clock.set("2026-09-14T12:10:00.000Z");
      const early = await rr.detectAndOpenRecoveryCase({
        leadId: lead.leadId,
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(early.gap.eligible).toBe(false);
      expect(early.gap.reasonCode).toBe("THRESHOLD_NOT_ELAPSED");
      expect(early.recoveryCase).toBeNull();

      env.clock.set(RR_MONDAY_IN_WINDOW);
      const detected = await rr.detectAndOpenRecoveryCase({
        leadId: lead.leadId,
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(detected.gap.eligible).toBe(true);
      const recoveryCase = detected.recoveryCase;
      expect(recoveryCase?.status).toBe("OPEN");
      expect(recoveryCase?.estimatedRecoverableValue).toBe(4800);
      expect(recoveryCase?.gapDetectedAt).toBe(RR_MONDAY_IN_WINDOW);

      // Same episode re-detected yields the same durable case identity.
      const again = await rr.detectAndOpenRecoveryCase({
        leadId: lead.leadId,
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(again.recoveryCase?.recoveryCaseId).toBe(
        recoveryCase!.recoveryCaseId,
      );

      const prepared = await rr.prepareRecoveryObjective({
        recoveryCaseId: recoveryCase!.recoveryCaseId,
        requesterId: "user_local",
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        admit: true,
      });
      const admitted = prepared.admissionResult as {
        outcome: string;
        runId?: string;
      };
      expect(admitted.outcome).toBe("ADMITTED");
      const runId = admitted.runId!;
      expect(await env.stack.runs.getById(runId)).toMatchObject({
        projectId: env.ids.projectId,
      });

      const detail = await caseDetail(env, recoveryCase!.recoveryCaseId);
      expect(detail.recoveryCase.status).toBe("IN_ORCHESTRATION");
      expect(detail.recoveryCase.objectiveId).toBe(
        `obj_rr_${recoveryCase!.recoveryCaseId}`,
      );
      expect(detail.recoveryCase.orchestratorRunId).toBe(runId);

      // Admission is not authorization: nothing has been sent or authorized.
      expect(await env.stack.authorizationRecords.getLatestByRun(runId)).toBeNull();
      expect(env.stack.revenueRecoveryMessaging.sent).toHaveLength(0);
      expect(detail.attempts).toHaveLength(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("B: DO_NOT_CONTACT consent denies outreach with zero attempts and zero sends", async () => {
    const env = await createRrPostgresEnv({
      label: "b",
      withRecoverySmsPlan: false,
    });
    try {
      const { messaging, template, lead, recoveryCase } = await seedRecoveryCase(
        env,
        {
          leadOverrides: {
            consent: { smsOptIn: true, emailOptIn: true, doNotContact: true },
          },
        },
      );

      const policy =
        await env.stack.revenueRecoveryService.evaluateCaseContactPolicy(
          recoveryCase.recoveryCaseId,
        );
      expect(policy.eligible).toBe(false);
      expect(policy.reasonCodes).toContain("DO_NOT_CONTACT");

      await expect(
        env.stack.actuator.sendRecoverySms({
          runId: "run_rr_dnc",
          executionAttemptId: "exa_rr_dnc",
          stepId: "step_rr_dnc",
          stepIdempotencyKey: "idem_rr_dnc",
          artifactRoot: artifactRoot(),
          args: {
            recoveryCaseId: recoveryCase.recoveryCaseId,
            leadId: lead.leadId,
            templateId: template.templateId,
            templateVersion: 1,
          },
          nowIso: env.clock.nowIso(),
          runtime: { timeoutMs: 30_000 },
        }),
      ).rejects.toMatchObject({
        code: "EXECUTION_PRECONDITION_FAILED",
        details: { revenueRecoveryCode: "CONTACT_NOT_PERMITTED" },
      });

      expect(messaging.sent).toHaveLength(0);
      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.attempts).toHaveLength(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("C: governed Phase6 → Phase7 outreach records exactly one durable attempt", async () => {
    const env = await createRrPostgresEnv({ label: "c" });
    try {
      const { messaging, template, lead, recoveryCase } =
        await seedRecoveryCase(env);
      const routed = await routeRecoveryRun(
        env,
        "c",
        recoveryCase.recoveryCaseId,
      );

      expect((await env.stack.runs.getById(routed.runId))?.state).toBe(
        "AWAITING_APPROVAL",
      );
      expect(
        await env.stack.authorizationRecords.getLatestByRun(routed.runId),
      ).toBeNull();
      await expect(
        env.stack.execution.execute(routed.runId),
      ).rejects.toMatchObject({ code: "EXECUTION_NOT_READY" });
      expect(messaging.sent).toHaveLength(0);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(0);

      const approved = await approveAwaitingRun(env.stack, {
        runId: routed.runId,
        approvalRequestId: routed.approvalRequestId,
        request: routed.request,
      });
      const authorization = await env.stack.authorizationRecords.getLatestByRun(
        approved.runId,
      );
      expect(authorization?.decision).toBe("APPROVE");

      const result = await env.stack.execution.execute(approved.runId);
      expect(result.status).toBe("EXECUTION_SUCCEEDED");

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.attempts).toHaveLength(1);
      expect(detail.attempts[0]).toMatchObject({
        channel: "SMS",
        deliveryOutcome: "SIMULATED",
        templateId: template.templateId,
        templateVersion: 1,
        leadId: lead.leadId,
        runId: approved.runId,
      });
      // Recipient is masked on the durable attempt, resolved from the lead.
      expect(detail.attempts[0]?.recipientRef).toBe("***4567");
      expect(detail.attempts[0]?.recipientRef).not.toContain(RAW_LEAD_PHONE);
      expect(messaging.sent).toHaveLength(1);
      expect(messaging.sent[0]?.action).toMatchObject({
        recipientPhone: RAW_LEAD_PHONE,
      });
      expect(detail.events.map((e) => e.kind)).toContain("OUTBOUND_ATTEMPT");
    } finally {
      await env.close();
    }
  }, 120_000);

  it("D: an action whose leadId is not the case lead is contained before send", async () => {
    const env = await createRrPostgresEnv({
      label: "d",
      withRecoverySmsPlan: false,
    });
    try {
      const { rr, messaging, template, recoveryCase } =
        await seedRecoveryCase(env);
      const other = await rr.ingestLead(
        rrLeadFor(env.ids, {
          externalLeadId: uniquePostgresTestId("rr_ext_d_other"),
        }),
      );

      await expect(
        env.stack.actuator.sendRecoverySms({
          runId: "run_rr_mismatch",
          executionAttemptId: "exa_rr_mismatch",
          stepId: "step_rr_mismatch",
          stepIdempotencyKey: "idem_rr_mismatch",
          artifactRoot: artifactRoot(),
          args: {
            recoveryCaseId: recoveryCase.recoveryCaseId,
            leadId: other.lead.leadId,
            templateId: template.templateId,
            templateVersion: 1,
          },
          nowIso: env.clock.nowIso(),
          runtime: { timeoutMs: 30_000 },
        }),
      ).rejects.toMatchObject({
        code: "EXECUTION_TARGET_INVALID",
        details: { revenueRecoveryCode: "RECOVERY_ACTION_TARGET_MISMATCH" },
      });

      expect(messaging.sent).toHaveLength(0);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("E: an inbound response stops further authorized outreach", async () => {
    const env = await createRrPostgresEnv({ label: "e" });
    try {
      const { rr, messaging, template, lead, recoveryCase } =
        await seedRecoveryCase(env);
      const executed = await executeGovernedOutreach(
        env,
        "e",
        recoveryCase.recoveryCaseId,
      );
      expect(executed.result.status).toBe("EXECUTION_SUCCEEDED");
      expect(messaging.sent).toHaveLength(1);

      await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "INBOUND_MESSAGE",
        occurredAt: RR_MONDAY_IN_WINDOW,
        externalEventId: uniquePostgresTestId("rr_inbound_e"),
        source: "WEBHOOK",
        channel: "SMS",
      });
      const engaged = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(engaged.recoveryCase.status).toBe("ENGAGED");
      expect(engaged.contactPolicy.eligible).toBe(false);
      expect(engaged.contactPolicy.reasonCodes).toContain(
        "LEAD_ALREADY_RESPONDED",
      );

      // A distinct authorized step is still denied at time of actuation.
      await expect(
        env.stack.actuator.sendRecoverySms({
          runId: executed.runId,
          executionAttemptId: "exa_rr_after_inbound",
          stepId: "step_rr_after_inbound",
          stepIdempotencyKey: "idem_rr_after_inbound",
          artifactRoot: artifactRoot(),
          args: {
            recoveryCaseId: recoveryCase.recoveryCaseId,
            leadId: lead.leadId,
            templateId: template.templateId,
            templateVersion: 1,
          },
          nowIso: env.clock.nowIso(),
          runtime: { timeoutMs: 30_000 },
        }),
      ).rejects.toMatchObject({ code: "EXECUTION_PRECONDITION_FAILED" });

      expect(messaging.sent).toHaveLength(1);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("K: the SMS attempt ceiling denies a second authorized step", async () => {
    const env = await createRrPostgresEnv({ label: "k" });
    try {
      const { messaging, template, lead, recoveryCase } = await seedRecoveryCase(
        env,
        { configOverrides: { maxSmsAttempts: 1 } },
      );
      const executed = await executeGovernedOutreach(
        env,
        "k",
        recoveryCase.recoveryCaseId,
      );
      expect(executed.result.status).toBe("EXECUTION_SUCCEEDED");
      expect(messaging.sent).toHaveLength(1);

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(
        detail.contactPolicy.channels.find((c) => c.channel === "SMS")
          ?.reasonCodes,
      ).toContain("ATTEMPT_LIMIT_REACHED");

      await expect(
        env.stack.actuator.sendRecoverySms({
          runId: executed.runId,
          executionAttemptId: "exa_rr_ceiling_2",
          stepId: "step_rr_ceiling_2",
          stepIdempotencyKey: "idem_rr_ceiling_2",
          artifactRoot: artifactRoot(),
          args: {
            recoveryCaseId: recoveryCase.recoveryCaseId,
            leadId: lead.leadId,
            templateId: template.templateId,
            templateVersion: 1,
          },
          nowIso: env.clock.nowIso(),
          runtime: { timeoutMs: 30_000 },
        }),
      ).rejects.toMatchObject({
        code: "EXECUTION_PRECONDITION_FAILED",
        details: { revenueRecoveryCode: "CONTACT_NOT_PERMITTED" },
      });

      expect(messaging.sent).toHaveLength(1);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("L: a closed contact window denies outreach with zero sends", async () => {
    const env = await createRrPostgresEnv({
      label: "l",
      clockIso: RR_SATURDAY_OUTSIDE_WINDOW,
      withRecoverySmsPlan: false,
    });
    try {
      const { messaging, template, lead, recoveryCase } = await seedRecoveryCase(
        env,
        { leadOverrides: { createdAt: "2026-09-12T12:00:00.000Z" } },
      );

      const policy =
        await env.stack.revenueRecoveryService.evaluateCaseContactPolicy(
          recoveryCase.recoveryCaseId,
        );
      expect(policy.eligible).toBe(false);
      expect(policy.reasonCodes).toContain("CONTACT_WINDOW_CLOSED");

      await expect(
        env.stack.actuator.sendRecoverySms({
          runId: "run_rr_window",
          executionAttemptId: "exa_rr_window",
          stepId: "step_rr_window",
          stepIdempotencyKey: "idem_rr_window",
          artifactRoot: artifactRoot(),
          args: {
            recoveryCaseId: recoveryCase.recoveryCaseId,
            leadId: lead.leadId,
            templateId: template.templateId,
            templateVersion: 1,
          },
          nowIso: env.clock.nowIso(),
          runtime: { timeoutMs: 30_000 },
        }),
      ).rejects.toMatchObject({
        code: "EXECUTION_PRECONDITION_FAILED",
        details: { revenueRecoveryCode: "CONTACT_WINDOW_CLOSED" },
      });

      expect(messaging.sent).toHaveLength(0);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("M: the product service holds no authorization or execution authority", async () => {
    const env = await createRrPostgresEnv({ label: "m" });
    try {
      const { rr, messaging, recoveryCase } = await seedRecoveryCase(env);

      // CALLER ASSERTION != AUTHORIZATION: no self-authorization surface.
      const surface = new Set(
        Object.getOwnPropertyNames(Object.getPrototypeOf(rr) as object),
      );
      for (const forbidden of [
        "humanAuthorizationConfirmed",
        "confirmHumanAuthorization",
        "approve",
        "authorize",
        "execute",
        "completeRecovery",
      ]) {
        expect(surface.has(forbidden)).toBe(false);
      }
      expect(
        (rr as unknown as Record<string, unknown>)[
          "humanAuthorizationConfirmed"
        ],
      ).toBeUndefined();
      expect(surface.has("actuateRecoveryOutreachFromPhase7")).toBe(true);

      const routed = await routeRecoveryRun(
        env,
        "m",
        recoveryCase.recoveryCaseId,
      );
      expect(
        await env.stack.authorizationRecords.getLatestByRun(routed.runId),
      ).toBeNull();
      await expect(
        env.stack.execution.execute(routed.runId),
      ).rejects.toMatchObject({ code: "EXECUTION_NOT_READY" });
      expect(messaging.sent).toHaveLength(0);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(0);

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
      expect(messaging.sent).toHaveLength(1);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("PHASE7_RETRY_IDEMPOTENCY: re-driven execution and step replay yield one delivery", async () => {
    const env = await createRrPostgresEnv({ label: "retry" });
    try {
      const { messaging, template, lead, recoveryCase } =
        await seedRecoveryCase(env);
      const executed = await executeGovernedOutreach(
        env,
        "retry",
        recoveryCase.recoveryCaseId,
      );
      expect(executed.result.status).toBe("EXECUTION_SUCCEEDED");
      expect(messaging.sent).toHaveLength(1);

      // Terminal execution fence replays the prior result.
      const replayedRun = await env.stack.execution.execute(executed.runId);
      expect(replayedRun.executionAttemptId).toBe(
        executed.result.executionAttemptId,
      );
      expect(messaging.sent).toHaveLength(1);

      // Same authorized step identity re-driven through the SafeActuator.
      const invocation = env.stack.actuator.invocations.find(
        (i) => i.method === "sendRecoverySms",
      )?.input as {
        executionAttemptId: string;
        stepId: string;
        stepIdempotencyKey: string;
      };
      const replayedStep = await env.stack.actuator.sendRecoverySms({
        runId: executed.runId,
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
        nowIso: env.clock.nowIso(),
        runtime: { timeoutMs: 30_000 },
      });
      expect(replayedStep.replayed).toBe(true);

      expect(messaging.sent).toHaveLength(1);
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).attempts,
      ).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 120_000);
});

describe("Revenue Recovery durable lead identity (Postgres)", () => {
  it("I: repeated webhook ingest of identical lead material is idempotent", async () => {
    const env = await createRrPostgresEnv({
      label: "i",
      withRecoverySmsPlan: false,
    });
    try {
      const rr = env.stack.revenueRecoveryService;
      const first = await rr.ingestLead(rrLeadFor(env.ids));
      expect(first.created).toBe(true);

      const second = await rr.ingestLead(rrLeadFor(env.ids));
      expect(second.created).toBe(false);
      expect(second.lead.leadId).toBe(first.lead.leadId);
      expect(second.lead.recordRevision).toBe(1);
      expect(second.lead.materialFingerprint).toBe(
        first.lead.materialFingerprint,
      );

      const third = await rr.ingestLead(rrLeadFor(env.ids));
      expect(third.created).toBe(false);
      expect(third.lead.ingestedAt).toBe(first.lead.ingestedAt);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("J: divergent material on the same lead identity is rejected", async () => {
    const env = await createRrPostgresEnv({
      label: "j",
      withRecoverySmsPlan: false,
    });
    try {
      const rr = env.stack.revenueRecoveryService;
      const first = await rr.ingestLead(rrLeadFor(env.ids));

      await expect(
        rr.ingestLead(rrLeadFor(env.ids, { firstName: "Jordan" })),
      ).rejects.toMatchObject({ code: "LEAD_SOURCE_CONFLICT" });
      await expect(
        rr.ingestLead(rrLeadFor(env.ids, { estimatedValue: 9900 })),
      ).rejects.toMatchObject({ code: "LEAD_SOURCE_CONFLICT" });

      const unchanged = await rr.ingestLead(rrLeadFor(env.ids));
      expect(unchanged.lead.firstName).toBe(first.lead.firstName);
      expect(unchanged.lead.estimatedValue).toBe(4800);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("O: cross-tenant case reads and dashboards are denied", async () => {
    const env = await createRrPostgresEnv({
      label: "o",
      withRecoverySmsPlan: false,
    });
    try {
      const { rr, recoveryCase } = await seedRecoveryCase(env);
      const otherIds = uniqueRrIds("o_other");

      await expect(
        rr.getCaseDetail({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          customerAccountId: otherIds.customerAccountId,
          projectId: env.ids.projectId,
        }),
      ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });
      await expect(
        rr.getCaseDetail({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          customerAccountId: env.ids.customerAccountId,
          projectId: otherIds.projectId,
        }),
      ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });

      // A second durable tenant on the same stack sees only its own case.
      await rr.putConfiguration(rrConfigFor(otherIds));
      const otherLead = await rr.ingestLead(rrLeadFor(otherIds));
      const otherCase = await rr.detectAndOpenRecoveryCase({
        leadId: otherLead.lead.leadId,
        customerAccountId: otherIds.customerAccountId,
        projectId: otherIds.projectId,
      });
      expect(otherCase.recoveryCase).toBeTruthy();

      await expect(
        rr.getCaseDetail({
          recoveryCaseId: otherCase.recoveryCase!.recoveryCaseId,
          customerAccountId: env.ids.customerAccountId,
          projectId: env.ids.projectId,
        }),
      ).rejects.toMatchObject({ code: "TENANT_ISOLATION_VIOLATION" });

      const dashboardA = await rr.getDashboard({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      const dashboardB = await rr.getDashboard({
        customerAccountId: otherIds.customerAccountId,
        projectId: otherIds.projectId,
      });
      expect(dashboardA.cases.map((c) => c.recoveryCaseId)).toEqual([
        recoveryCase.recoveryCaseId,
      ]);
      expect(dashboardB.cases.map((c) => c.recoveryCaseId)).toEqual([
        otherCase.recoveryCase!.recoveryCaseId,
      ]);
    } finally {
      await env.close();
    }
  }, 120_000);
});

describe("Revenue Recovery durable economics (Postgres)", () => {
  it("F: a booked appointment is ESTIMATED value, never booked or collected", async () => {
    const env = await createRrPostgresEnv({
      label: "f",
      withRecoverySmsPlan: false,
    });
    try {
      const { rr, lead, recoveryCase } = await seedRecoveryCase(env);

      await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "INBOUND_MESSAGE",
        occurredAt: RR_MONDAY_IN_WINDOW,
        externalEventId: uniquePostgresTestId("rr_inbound_f"),
        source: "WEBHOOK",
        channel: "SMS",
      });
      const appointment = await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "APPOINTMENT_BOOKED",
        occurredAt: "2026-09-14T16:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_appt_f"),
        source: "WEBHOOK",
      });

      const attribution = await rr.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: appointment.event.eventId,
      });
      expect(attribution.confidenceClass).toBe("ESTIMATED");
      expect(attribution.attributionType).toBe("APPOINTMENT_VALUE_ESTIMATE");
      expect(attribution.amount).toBe(4800);

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.recoveryCase.status).toBe("APPOINTMENT_BOOKED");
      expect(detail.economics.estimatedRecoverableValue).toBe(4800);
      expect(detail.economics.bookedRecoveredRevenue).toBeNull();
      expect(detail.economics.confirmedCollectedRevenue).toBeNull();
      expect(detail.economics.operatorAttestedRevenue).toBeNull();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("G: a TRUSTED_CRM sale confirms booked revenue but never collection", async () => {
    const env = await createRrPostgresEnv({
      label: "g",
      withRecoverySmsPlan: false,
    });
    try {
      const { rr, lead, recoveryCase } = await seedRecoveryCase(env);

      const sale = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-15T12:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_sale_g"),
        source: "CRM",
        amount: 4200,
        currency: "USD",
        trustProvenance: "TRUSTED_CRM",
      });
      expect(sale.event.trustProvenance).toBe("TRUSTED_CRM");

      const attribution = await rr.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: sale.event.eventId,
      });
      expect(attribution.confidenceClass).toBe("CONFIRMED_SALE");
      expect(attribution.amount).toBe(4200);

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.economics.bookedRecoveredRevenue).toBe(4200);
      // BOOKED != COLLECTED: a confirmed sale is not confirmed cash.
      expect(detail.economics.confirmedCollectedRevenue).toBeNull();

      // A payment-trusted source cannot mint sale truth.
      const crossClaim = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-15T13:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_cross_sale_g"),
        source: "PAYMENT_WEBHOOK",
        amount: 9900,
        currency: "USD",
        trustProvenance: "TRUSTED_PAYMENT_SOURCE",
      });
      await expect(
        rr.attributeFromEvent({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          eventId: crossClaim.event.eventId,
        }),
      ).rejects.toMatchObject({ code: "ATTRIBUTION_INVALID" });
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).economics
          .bookedRecoveredRevenue,
      ).toBe(4200);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("H: a TRUSTED_PAYMENT_SOURCE payment confirms collected revenue exactly", async () => {
    const env = await createRrPostgresEnv({
      label: "h",
      withRecoverySmsPlan: false,
    });
    try {
      const { rr, lead, recoveryCase } = await seedRecoveryCase(env);

      const payment = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-16T12:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_pay_h"),
        source: "PAYMENT_WEBHOOK",
        amount: 2100,
        currency: "USD",
        trustProvenance: "TRUSTED_PAYMENT_SOURCE",
      });
      const attribution = await rr.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: payment.event.eventId,
      });
      expect(attribution.confidenceClass).toBe("CONFIRMED_PAYMENT");

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.economics.confirmedCollectedRevenue).toBe(2100);
      // No sale was confirmed, so nothing is booked.
      expect(detail.economics.bookedRecoveredRevenue).toBeNull();

      // A CRM cannot mint confirmed cash collection.
      const crmPayment = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-16T13:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_crm_pay_h"),
        source: "CRM",
        amount: 5000,
        currency: "USD",
        trustProvenance: "TRUSTED_CRM",
      });
      await expect(
        rr.attributeFromEvent({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          eventId: crmPayment.event.eventId,
        }),
      ).rejects.toMatchObject({ code: "ATTRIBUTION_INVALID" });

      // FAKE_TEST provenance is durable only because this runtime is TEST.
      const fakePayment = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-16T14:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_fake_pay_h"),
        source: "FAKE_TEST_SOURCE",
        amount: 100,
        currency: "USD",
        trustProvenance: "FAKE_TEST",
      });
      expect(fakePayment.event.trustProvenance).toBe("FAKE_TEST");
      expect(
        (await caseDetail(env, recoveryCase.recoveryCaseId)).economics
          .confirmedCollectedRevenue,
      ).toBe(2100);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("MANUAL_PROVENANCE_NEGATIVE: trusted-sounding source labels stay ATTESTED", async () => {
    const env = await createRrPostgresEnv({
      label: "manual-prov",
      withRecoverySmsPlan: false,
    });
    try {
      const { rr, lead, recoveryCase } = await seedRecoveryCase(env);

      // SOURCE LABEL != TRUST PROVENANCE.
      const stripe = await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-15T12:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_stripe_mp"),
        source: "Stripe",
        amount: 2600,
        currency: "USD",
      });
      expect(stripe.event.trustProvenance).toBe("MANUAL_ATTESTATION");
      const stripeAttribution = await rr.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: stripe.event.eventId,
      });
      expect(stripeAttribution.confidenceClass).toBe("ATTESTED_PAYMENT");

      const salesforce = await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-15T13:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_salesforce_mp"),
        source: "Salesforce",
        amount: 9900,
        currency: "USD",
      });
      expect(salesforce.event.trustProvenance).toBe("MANUAL_ATTESTATION");
      const saleAttribution = await rr.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: salesforce.event.eventId,
      });
      expect(saleAttribution.confidenceClass).toBe("ATTESTED_SALE");

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.economics.bookedRecoveredRevenue).toBeNull();
      expect(detail.economics.confirmedCollectedRevenue).toBeNull();
      expect(detail.economics.operatorAttestedRevenue).toBe(12500);

      const dashboard = await rr.getDashboard({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(dashboard.funnel.bookedRecoveredRevenue).toBe(0);
      expect(dashboard.funnel.confirmedRecoveredRevenue).toBe(0);
      expect(dashboard.funnel.operatorAttestedRevenue).toBe(12500);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("N: the control tower read model masks PII and separates economics", async () => {
    const env = await createRrPostgresEnv({ label: "n" });
    try {
      const { rr, lead, recoveryCase } = await seedRecoveryCase(env);
      const executed = await executeGovernedOutreach(
        env,
        "n",
        recoveryCase.recoveryCaseId,
      );
      expect(executed.result.status).toBe("EXECUTION_SUCCEEDED");

      await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "INBOUND_MESSAGE",
        occurredAt: RR_MONDAY_IN_WINDOW,
        externalEventId: uniquePostgresTestId("rr_inbound_n"),
        source: "WEBHOOK",
        channel: "SMS",
      });
      const sale = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-15T12:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_sale_n"),
        source: "CRM",
        amount: 4200,
        currency: "USD",
        trustProvenance: "TRUSTED_CRM",
      });
      await rr.attributeFromEvent({
        recoveryCaseId: recoveryCase.recoveryCaseId,
        eventId: sale.event.eventId,
      });

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(Object.keys(detail.lead)).not.toContain("phone");
      expect(Object.keys(detail.lead)).not.toContain("email");
      expect(detail.lead.phoneMasked).toBe("***4567");
      expect(detail.lead.emailMasked).toBe("a***@example.com");
      expect(JSON.stringify(detail)).not.toContain(RAW_LEAD_PHONE);
      expect(JSON.stringify(detail)).not.toContain(RAW_LEAD_EMAIL);

      expect(detail.economics).toMatchObject({
        estimatedRecoverableValue: 4800,
        bookedRecoveredRevenue: 4200,
        confirmedCollectedRevenue: null,
        operatorAttestedRevenue: null,
      });
      expect(detail.attributions[0]).toMatchObject({
        trustProvenance: "TRUSTED_CRM",
        confidenceClass: "CONFIRMED_SALE",
        sourceEventId: sale.event.eventId,
      });
      expect(detail.attributions[0]?.attributionRuleVersion).toBeTruthy();
      expect(detail.doctrine.estimatedNotBooked).toBeTruthy();
      expect(detail.attempts).toHaveLength(1);

      const dashboard = await rr.getDashboard({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(dashboard.runtimeEnvironment).toBe("TEST");
      expect(dashboard.cases).toHaveLength(1);
      expect(dashboard.funnel.bookedRecoveredRevenue).toBe(4200);
      expect(dashboard.funnel.confirmedRecoveredRevenue).toBe(0);
      expect(dashboard.funnel.estimatedPipelineRecovered).toBe(4800);
      expect(JSON.stringify(dashboard)).not.toContain(RAW_LEAD_PHONE);
      expect(JSON.stringify(dashboard)).not.toContain(RAW_LEAD_EMAIL);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("ECONOMIC_HEADLINE_4800: estimated 4800, booked 4200, collected 2100 sealed with lineage", async () => {
    const env = await createRrPostgresEnv({ label: "headline" });
    try {
      const { rr, messaging, lead, recoveryCase } = await seedRecoveryCase(env);
      const executed = await executeGovernedOutreach(
        env,
        "headline",
        recoveryCase.recoveryCaseId,
      );
      expect(executed.result.status).toBe("EXECUTION_SUCCEEDED");
      expect(messaging.sent).toHaveLength(1);

      await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "INBOUND_MESSAGE",
        occurredAt: RR_MONDAY_IN_WINDOW,
        externalEventId: uniquePostgresTestId("rr_inbound_headline"),
        source: "WEBHOOK",
        channel: "SMS",
      });
      const appointment = await rr.appendLeadEvent({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "APPOINTMENT_BOOKED",
        occurredAt: "2026-09-14T16:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_appt_headline"),
        source: "WEBHOOK",
      });
      const sale = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-15T12:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_sale_headline"),
        source: "CRM",
        amount: 4200,
        currency: "USD",
        trustProvenance: "TRUSTED_CRM",
      });
      const payment = await rr.appendLeadEventWithProvenance({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        leadId: lead.leadId,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-16T12:00:00.000Z",
        externalEventId: uniquePostgresTestId("rr_pay_headline"),
        source: "PAYMENT_WEBHOOK",
        amount: 2100,
        currency: "USD",
        trustProvenance: "TRUSTED_PAYMENT_SOURCE",
      });
      for (const eventId of [
        appointment.event.eventId,
        sale.event.eventId,
        payment.event.eventId,
      ]) {
        await rr.attributeFromEvent({
          recoveryCaseId: recoveryCase.recoveryCaseId,
          eventId,
        });
      }

      const detail = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(detail.economics.estimatedRecoverableValue).toBe(4800);
      expect(detail.economics.bookedRecoveredRevenue).toBe(4200);
      expect(detail.economics.confirmedCollectedRevenue).toBe(2100);
      expect(detail.economics.operatorAttestedRevenue).toBeNull();

      const record = await rr.sealRecoveryRecord({
        recoveryCaseId: recoveryCase.recoveryCaseId,
      });
      expect(record.outcome).toBe("CONVERTED");
      expect(record.estimatedRecoverableValue).toBe(4800);
      expect(record.bookedRecoveredRevenue).toBe(4200);
      expect(record.confirmedCollectedRevenue).toBe(2100);
      expect(record.outreachAttemptIds).toEqual([
        detail.attempts[0]!.attemptId,
      ]);
      expect(record.attributionLineage.map((l) => l.trustProvenance)).toEqual(
        expect.arrayContaining([
          "MANUAL_ATTESTATION",
          "TRUSTED_CRM",
          "TRUSTED_PAYMENT_SOURCE",
        ]),
      );

      const { recordHash, ...draft } = record;
      expect(computeRecoveryRecordHash(draft)).toBe(recordHash);
      await expect(
        rr.sealRecoveryRecord({
          recoveryCaseId: recoveryCase.recoveryCaseId,
        }),
      ).rejects.toMatchObject({ code: "RECOVERY_RECORD_CONFLICT" });

      const reread = await caseDetail(env, recoveryCase.recoveryCaseId);
      expect(reread.recoveryRecord?.recordHash).toBe(recordHash);
    } finally {
      await env.close();
    }
  }, 120_000);
});
