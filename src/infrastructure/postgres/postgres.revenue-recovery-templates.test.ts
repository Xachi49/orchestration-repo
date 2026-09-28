/**
 * Governed RecoveryMessageTemplate provisioning against durable Postgres.
 * Run via `npm run test:postgres` against a reachable TEST_DATABASE_URL.
 *
 * TEMPLATE PROVISIONED != OUTREACH AUTHORIZED. No OpenAI/Resend calls.
 */
import { describe, expect, it } from "vitest";
import { buildServer } from "../../api/server.js";
import { ApprovedPlanRepairError } from "../../planning/approved-plan-repair.js";
import { RevenueRecoveryError } from "../../revenue-recovery/errors.js";
import {
  createRrPostgresEnv,
  rrAdmissionRequest,
  rrConfigFor,
  rrLeadFor,
  rrObjectiveId,
  RR_LEAD_CREATED_AT,
  seedSupervisedRecoveryProject,
  uniqueRrIds,
  type RrPostgresEnv,
} from "./postgres.revenue-recovery.helpers.js";
import { PostgresRecoveryCaseRepository } from "./repositories/revenue-recovery.js";
import { uniquePostgresTestId } from "./test-helpers.js";

function templateInput(
  env: RrPostgresEnv,
  overrides: Record<string, unknown> = {},
) {
  return {
    templateId: `rtpl_${uniqueSuffix(env)}_email_followup`,
    version: 1,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
    channel: "EMAIL",
    body: "Hi {{firstName}} — {{businessName}} following up on {{serviceRequested}}.",
    allowedVariables: ["firstName", "businessName", "serviceRequested"],
    enabled: true,
    ...overrides,
  };
}

/** Template ids have a narrow grammar; derive a lowercase suffix from unique ids. */
function uniqueSuffix(env: RrPostgresEnv): string {
  return env.ids.projectId.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

async function bindCaseToRun(env: RrPostgresEnv, label: string) {
  const rr = env.stack.revenueRecoveryService;
  const { lead } = await rr.ingestLead(
    rrLeadFor(env.ids, { createdAt: RR_LEAD_CREATED_AT }),
  );
  const { recoveryCase } = await rr.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
  });
  if (!recoveryCase) throw new Error("expected an open recovery case");
  const admitted = await env.stack.admission.admit(
    rrAdmissionRequest({
      label,
      projectId: env.ids.projectId,
      recoveryCaseId: recoveryCase.recoveryCaseId,
    }),
  );
  if (admitted.outcome !== "ADMITTED" || !admitted.runId) {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  const cases = new PostgresRecoveryCaseRepository(env.db);
  await cases.save({
    ...recoveryCase,
    status: "IN_ORCHESTRATION",
    objectiveId: rrObjectiveId(recoveryCase.recoveryCaseId),
    orchestratorRunId: admitted.runId,
    updatedAt: env.clock.nowIso(),
    recordRevision: recoveryCase.recordRevision + 1,
  });
  return { runId: admitted.runId, recoveryCase, lead };
}

describe("Revenue Recovery template provisioning (Postgres)", () => {
  it("provisions through the composed stack and HTTP route; replay is idempotent", async () => {
    const env = await createRrPostgresEnv({
      label: "tpl_http",
      withRecoverySmsPlan: false,
    });
    try {
      const rr = env.stack.revenueRecoveryService;
      await rr.putConfiguration(rrConfigFor(env.ids));
      const app = await buildServer({ revenueRecovery: rr });
      const payload = templateInput(env);

      const created = await app.inject({
        method: "POST",
        url: "/v1/revenue-recovery/templates",
        payload,
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().outcome).toBe("CREATED");

      const replay = await app.inject({
        method: "POST",
        url: "/v1/revenue-recovery/templates",
        payload,
      });
      expect(replay.statusCode).toBe(200);
      expect(replay.json().outcome).toBe("ALREADY_EXISTS");
      expect(replay.json().template).toEqual(created.json().template);

      const divergent = await app.inject({
        method: "POST",
        url: "/v1/revenue-recovery/templates",
        payload: { ...payload, body: "Changed {{firstName}}", allowedVariables: ["firstName"] },
      });
      expect(divergent.statusCode).toBe(409);
      expect(divergent.json().error).toBe("RECOVERY_TEMPLATE_VERSION_CONFLICT");

      const listed = await app.inject({
        method: "GET",
        url: `/v1/revenue-recovery/templates?customerAccountId=${env.ids.customerAccountId}&projectId=${env.ids.projectId}&channel=EMAIL`,
      });
      expect(listed.statusCode).toBe(200);
      expect(listed.json().templates).toHaveLength(1);
      expect(listed.json().templates[0].body).toBe(payload.body);
      await app.close();
    } finally {
      await env.close();
    }
  }, 60_000);

  it("enforces identity, version, and cross-project rules; binder picks the highest version", async () => {
    const env = await createRrPostgresEnv({
      label: "tpl_rules",
      withRecoverySmsPlan: false,
    });
    const otherIds = uniqueRrIds("tpl_rules_other");
    try {
      const rr = env.stack.revenueRecoveryService;
      await rr.putConfiguration(rrConfigFor(env.ids));
      await seedSupervisedRecoveryProject(env.db, otherIds.projectId);
      await rr.putConfiguration(
        rrConfigFor({ ...otherIds, customerAccountId: env.ids.customerAccountId }),
      );
      const { runId } = await bindCaseToRun(env, "tpl_rules");

      await expect(
        env.stack.recoveryTargetBinder.resolveCanonicalBinding({ runId, channel: "EMAIL" }),
      ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_UNRESOLVED" });

      const v1 = templateInput(env);
      await rr.provisionTemplate(v1);
      await expect(
        rr.provisionTemplate({ ...v1, version: 3 }),
      ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_VERSION_CONFLICT" });
      const v2 = await rr.provisionTemplate({
        ...v1,
        version: 2,
        body: "v2 {{firstName}}",
        allowedVariables: ["firstName"],
      });
      expect(v2.outcome).toBe("CREATED");
      await expect(
        rr.provisionTemplate({ ...v1, version: 1, body: "lower {{firstName}}", allowedVariables: ["firstName"] }),
      ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_VERSION_CONFLICT" });

      await expect(
        rr.provisionTemplate({ ...v1, templateId: `${v1.templateId}_second` }),
      ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_IDENTITY_CONFLICT" });

      await expect(
        rr.provisionTemplate({ ...v1, projectId: otherIds.projectId, version: 3 }),
      ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_IDENTITY_CONFLICT" });
      const otherTemplateId = `${v1.templateId}_other_project`;
      await rr.provisionTemplate({
        ...v1,
        templateId: otherTemplateId,
        projectId: otherIds.projectId,
      });
      const listed = await rr.listTemplates({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
      });
      expect(listed.map((t) => `${t.templateId}@${t.version}`)).toEqual([
        `${v1.templateId}@1`,
        `${v1.templateId}@2`,
      ]);
      await expect(
        rr.getTemplate({
          templateId: otherTemplateId,
          version: 1,
          customerAccountId: env.ids.customerAccountId,
          projectId: env.ids.projectId,
        }),
      ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });

      const binding = await env.stack.recoveryTargetBinder.resolveCanonicalBinding({
        runId,
        channel: "EMAIL",
      });
      expect(binding.templateId).toBe(v1.templateId);
      expect(binding.templateVersion).toBe(2);
    } finally {
      await env.close();
    }
  }, 90_000);

  it("serializes concurrent provisioning within one scope", async () => {
    const env = await createRrPostgresEnv({
      label: "tpl_concurrent",
      withRecoverySmsPlan: false,
    });
    try {
      const rr = env.stack.revenueRecoveryService;
      await rr.putConfiguration(rrConfigFor(env.ids));
      const base = templateInput(env);

      const identical = await Promise.all([
        rr.provisionTemplate(base),
        rr.provisionTemplate(base),
      ]);
      expect(identical.map((r) => r.outcome).sort()).toEqual([
        "ALREADY_EXISTS",
        "CREATED",
      ]);

      const racingIdentities = await Promise.allSettled([
        rr.provisionTemplate({ ...base, templateId: `${base.templateId}_a`, channel: "SMS" }),
        rr.provisionTemplate({ ...base, templateId: `${base.templateId}_b`, channel: "SMS" }),
      ]);
      expect(racingIdentities.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = racingIdentities.find((r) => r.status === "rejected");
      expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
        code: "RECOVERY_TEMPLATE_IDENTITY_CONFLICT",
      });
      const sms = await rr.listTemplates({
        customerAccountId: env.ids.customerAccountId,
        projectId: env.ids.projectId,
        channel: "SMS",
      });
      expect(sms).toHaveLength(1);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("withTransaction preserves repair and recovery domain errors", async () => {
    const env = await createRrPostgresEnv({
      label: "tpl_tx",
      withRecoverySmsPlan: false,
    });
    try {
      const repairError = new ApprovedPlanRepairError(
        "REPAIR_BINDING_FAILED",
        "No enabled EMAIL template for recovery case tenant/project",
        { binderCode: "RECOVERY_TEMPLATE_UNRESOLVED" },
      );
      await expect(
        env.db.withTransaction(async () => {
          await env.db.query("SELECT 1");
          throw repairError;
        }),
      ).rejects.toBe(repairError);

      const recoveryError = new RevenueRecoveryError(
        "RECOVERY_TEMPLATE_IDENTITY_CONFLICT",
        uniquePostgresTestId("tx_conflict"),
      );
      await expect(
        env.db.withTransaction(async () => {
          throw recoveryError;
        }),
      ).rejects.toBe(recoveryError);
    } finally {
      await env.close();
    }
  }, 60_000);
});
