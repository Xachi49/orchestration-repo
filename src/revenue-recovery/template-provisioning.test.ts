/**
 * Governed RecoveryMessageTemplate provisioning.
 *
 * TEMPLATE CONTENT != EXECUTION AUTHORITY
 * TEMPLATE PROVISIONED != OUTREACH AUTHORIZED
 * TEMPLATE ENABLED != CONTACT PERMITTED
 * MODEL OUTPUT != TEMPLATE AUTHORITY
 * RECIPIENT != TEMPLATE INPUT
 * IMMUTABLE VERSION != MUTABLE CONFIG
 */
import { describe, expect, it } from "vitest";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryRunRepository } from "../infrastructure/admission/in-memory-run-repository.js";
import { InMemoryObjectiveRepository } from "../infrastructure/admission/in-memory-objective-repository.js";
import { EXAMPLE_PROJECT } from "../control-plane/fixtures.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import { RunRecordSchema } from "../admission/run-repository.js";
import { parseRecoveryCase } from "./recovery-case.js";
import { RevenueRecoveryTargetBinder } from "./target-binder.js";
import { formatRecoveryTemplateTarget } from "./target-grammar.js";
import { renderTemplate } from "./recovery-template.js";

const NOW = "2026-09-14T15:00:00.000Z";
const OTHER_PROJECT = "rr-template-other-project";
const TEMPLATE_ID = "rtpl_continuum_rr_email_followup";

function templateInput(overrides: Record<string, unknown> = {}) {
  return {
    templateId: TEMPLATE_ID,
    version: 1,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    channel: "EMAIL",
    body: "Hi {{firstName}}, following up on your {{serviceRequested}} request. Book: {{bookingLink}}",
    allowedVariables: ["firstName", "serviceRequested", "bookingLink"],
    enabled: true,
    ...overrides,
  };
}

async function harness(options: { withProjects?: boolean } = {}) {
  const projects = new InMemoryProjectRegistry([
    EXAMPLE_PROJECT,
    { ...EXAMPLE_PROJECT, projectId: OTHER_PROJECT },
  ]);
  const product = createMemoryRevenueRecoveryService({
    nowIso: () => NOW,
    ...(options.withProjects === false ? {} : { projects }),
  });
  await product.service.putConfiguration(demoRecoveryConfig());
  await product.service.putConfiguration(
    demoRecoveryConfig({ projectId: OTHER_PROJECT }),
  );
  return product;
}

async function seedBoundCase(product: Awaited<ReturnType<typeof harness>>) {
  const { lead } = await product.service.ingestLead(demoLead());
  const recoveryCaseId = "rcase_tpl_1";
  const runId = "run_tpl_1";
  const objectiveId = `obj_rr_${recoveryCaseId}`;
  await product.repos.cases.save(
    parseRecoveryCase({
      recoveryCaseId,
      gapIdentityKey: "gap_tpl_1",
      leadId: lead.leadId,
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      gapDetectedAt: NOW,
      reasonCode: "NO_RESPONSE",
      status: "IN_ORCHESTRATION",
      configId: "cfg_1",
      configVersion: 1,
      configFingerprint: "fp",
      orchestratorRunId: runId,
      objectiveId,
      createdAt: NOW,
      updatedAt: NOW,
      recordRevision: 1,
    }),
  );
  const runs = new InMemoryRunRepository();
  await runs.create(
    RunRecordSchema.parse({
      runId,
      projectId: RR_PROJECT,
      objectiveId,
      objectiveVersion: 1,
      idempotencyKey: `idem_${runId}`,
      requesterId: "req",
      requestedEnvironment: "development",
      state: "PLANNING",
      recordRevision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      correlationId: "corr",
      traceId: "trace",
    }),
  );
  const binder = new RevenueRecoveryTargetBinder({
    runs,
    objectives: new InMemoryObjectiveRepository(),
    cases: product.repos.cases,
    leads: product.repos.leads,
    templates: product.repos.templates,
  });
  return { binder, runId, recoveryCaseId, lead };
}

describe("governed template provisioning", () => {
  it("provisions the first template version", async () => {
    const { service } = await harness();
    const result = await service.provisionTemplate(templateInput(), {
      principalId: "operator_static",
    });
    expect(result.outcome).toBe("CREATED");
    expect(result.template).toEqual({
      ...templateInput(),
      createdAt: NOW,
    });
  });

  it("replays an identical request as ALREADY_EXISTS without a second write", async () => {
    const { service, repos } = await harness();
    const first = await service.provisionTemplate(templateInput());
    const replay = await service.provisionTemplate(templateInput());
    expect(replay.outcome).toBe("ALREADY_EXISTS");
    expect(replay.template).toEqual(first.template);
    const audits = repos.audits
      .listAll()
      .filter((e) => e.kind === "RECOVERY_TEMPLATE_PROVISIONED");
    expect(audits).toHaveLength(1);
  });

  it("rejects the same (templateId, version) with divergent content", async () => {
    const { service } = await harness();
    await service.provisionTemplate(templateInput());
    await expect(
      service.provisionTemplate(
        templateInput({ body: "Hi {{firstName}}, different wording." , allowedVariables: ["firstName"] }),
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_VERSION_CONFLICT" });
  });

  it("accepts the next version of the same identity; binder picks the highest", async () => {
    const product = await harness();
    const { binder, runId } = await seedBoundCase(product);
    await expect(
      binder.resolveCanonicalBinding({ runId, channel: "EMAIL" }),
    ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_UNRESOLVED" });

    await product.service.provisionTemplate(templateInput());
    const v2 = await product.service.provisionTemplate(
      templateInput({
        version: 2,
        body: "Hi {{firstName}} — {{businessName}} here about {{serviceRequested}}.",
        allowedVariables: ["firstName", "businessName", "serviceRequested"],
      }),
    );
    expect(v2.outcome).toBe("CREATED");

    const binding = await binder.resolveCanonicalBinding({
      runId,
      channel: "EMAIL",
    });
    expect(binding.templateId).toBe(TEMPLATE_ID);
    expect(binding.templateVersion).toBe(2);
    expect(
      formatRecoveryTemplateTarget(binding.templateId, binding.templateVersion),
    ).toBe(`rr_template:${TEMPLATE_ID}@2`);
  });

  it("rejects duplicate, lower, and non-contiguous versions", async () => {
    const { service } = await harness();
    await expect(
      service.provisionTemplate(templateInput({ version: 2 })),
    ).rejects.toMatchObject({
      code: "RECOVERY_TEMPLATE_VERSION_CONFLICT",
      details: { expectedVersion: 1 },
    });
    await service.provisionTemplate(templateInput());
    await service.provisionTemplate(templateInput({ version: 2 , body: "v2 {{firstName}}", allowedVariables: ["firstName"] }));
    await expect(
      service.provisionTemplate(
        templateInput({ version: 1, body: "lower {{firstName}}", allowedVariables: ["firstName"] }),
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_VERSION_CONFLICT" });
    await expect(
      service.provisionTemplate(templateInput({ version: 4 })),
    ).rejects.toMatchObject({
      code: "RECOVERY_TEMPLATE_VERSION_CONFLICT",
      details: { expectedVersion: 3 },
    });
  });

  it("rejects a second enabled identity in the same tenant/project/channel", async () => {
    const product = await harness();
    const { binder, runId } = await seedBoundCase(product);
    await product.service.provisionTemplate(templateInput());
    await expect(
      product.service.provisionTemplate(
        templateInput({ templateId: "rtpl_continuum_rr_email_other" }),
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_TEMPLATE_IDENTITY_CONFLICT",
      details: { enabledTemplateIds: [TEMPLATE_ID] },
    });
    const binding = await binder.resolveCanonicalBinding({
      runId,
      channel: "EMAIL",
    });
    expect(binding.templateId).toBe(TEMPLATE_ID);
  });

  it("allows a distinct SMS identity alongside the EMAIL identity", async () => {
    const { service } = await harness();
    await service.provisionTemplate(templateInput());
    const sms = await service.provisionTemplate(
      templateInput({ templateId: "rtpl_continuum_rr_sms_followup", channel: "SMS" }),
    );
    expect(sms.outcome).toBe("CREATED");
  });

  it("isolates projects: no cross-project identity reuse, listing, or lookup", async () => {
    const { service } = await harness();
    await service.provisionTemplate(templateInput());

    await expect(
      service.provisionTemplate(templateInput({ projectId: OTHER_PROJECT })),
    ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_IDENTITY_CONFLICT" });
    await expect(
      service.provisionTemplate(
        templateInput({ projectId: OTHER_PROJECT, version: 2 }),
      ),
    ).rejects.toMatchObject({ code: "RECOVERY_TEMPLATE_IDENTITY_CONFLICT" });

    const other = await service.provisionTemplate(
      templateInput({
        templateId: "rtpl_other_project_email",
        projectId: OTHER_PROJECT,
      }),
    );
    expect(other.outcome).toBe("CREATED");

    const listed = await service.listTemplates({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(listed.map((t) => t.templateId)).toEqual([TEMPLATE_ID]);
    await expect(
      service.getTemplate({
        templateId: "rtpl_other_project_email",
        version: 1,
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("rejects an unsupported variable such as {{arbitraryModelField}}", async () => {
    const { service, repos } = await harness();
    await expect(
      service.provisionTemplate(
        templateInput({
          body: "Hi {{arbitraryModelField}}",
          allowedVariables: ["arbitraryModelField"],
        }),
      ),
    ).rejects.toMatchObject({
      code: "TEMPLATE_VARIABLE_UNSUPPORTED",
      details: { reason: "UNSUPPORTED_VARIABLE", variables: ["arbitraryModelField"] },
    });
    await expect(
      service.provisionTemplate(
        templateInput({
          body: "Hi {{firstName}} {{arbitraryModelField}}",
          allowedVariables: ["firstName"],
        }),
      ),
    ).rejects.toMatchObject({
      code: "TEMPLATE_VARIABLE_UNSUPPORTED",
      details: { reason: "UNSUPPORTED_VARIABLE" },
    });
    expect(await repos.templates.listByTemplateId(TEMPLATE_ID)).toEqual([]);
  });

  it("rejects a placeholder omitted from allowedVariables", async () => {
    const { service } = await harness();
    await expect(
      service.provisionTemplate(
        templateInput({
          body: "Hi {{firstName}}, book at {{bookingLink}}",
          allowedVariables: ["firstName"],
        }),
      ),
    ).rejects.toMatchObject({
      code: "TEMPLATE_VARIABLE_UNSUPPORTED",
      details: { reason: "UNDECLARED_PLACEHOLDER", variables: ["bookingLink"] },
    });
  });

  it("rejects malformed placeholders, duplicates, and recipient-shaped fields", async () => {
    const { service } = await harness();
    await expect(
      service.provisionTemplate(
        templateInput({ body: "Hi {{ first-name }}", allowedVariables: [] }),
      ),
    ).rejects.toMatchObject({
      code: "TEMPLATE_INVALID",
      details: { reason: "MALFORMED_PLACEHOLDER" },
    });
    await expect(
      service.provisionTemplate(
        templateInput({
          body: "Hi {{firstName}}",
          allowedVariables: ["firstName", "firstName"],
        }),
      ),
    ).rejects.toMatchObject({
      code: "TEMPLATE_INVALID",
      details: { reason: "DUPLICATE_VARIABLE" },
    });
    await expect(
      service.provisionTemplate(templateInput({ recipientEmail: "x@example.com" })),
    ).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
    await expect(
      service.provisionTemplate(
        templateInput({ body: "Hi {{email}}", allowedVariables: ["email"] }),
      ),
    ).rejects.toMatchObject({ code: "TEMPLATE_VARIABLE_UNSUPPORTED" });
  });

  it("rejects caller-set createdAt, disabled templates, and bad templateId grammar", async () => {
    const { service } = await harness();
    await expect(
      service.provisionTemplate(templateInput({ createdAt: NOW })),
    ).rejects.toMatchObject({
      code: "TEMPLATE_INVALID",
      details: { fields: ["(root)"] },
    });
    await expect(
      service.provisionTemplate(templateInput({ enabled: false })),
    ).rejects.toMatchObject({ code: "TEMPLATE_INVALID", details: { fields: ["enabled"] } });
    for (const templateId of ["Bad ID", "tpl_missing_prefix", "rtpl_", "rtpl_UPPER", undefined]) {
      await expect(
        service.provisionTemplate(templateInput({ templateId })),
      ).rejects.toMatchObject({ code: "TEMPLATE_INVALID" });
    }
  });

  it("fails closed without the project registry, for unknown projects, and without config", async () => {
    const noRegistry = await harness({ withProjects: false });
    await expect(
      noRegistry.service.provisionTemplate(templateInput()),
    ).rejects.toMatchObject({ code: "TEMPLATE_PROVISIONING_UNAVAILABLE" });

    const { service } = await harness();
    await expect(
      service.provisionTemplate(templateInput({ projectId: "unregistered-project" })),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(
      service.provisionTemplate(templateInput({ customerAccountId: "other_tenant" })),
    ).rejects.toMatchObject({ code: "RECOVERY_CONFIG_MISSING" });
  });

  it("lists read-only, filtered by channel, sorted by templateId then version", async () => {
    const { service } = await harness();
    await service.provisionTemplate(
      templateInput({ templateId: "rtpl_z_sms", channel: "SMS" }),
    );
    await service.provisionTemplate(templateInput());
    await service.provisionTemplate(
      templateInput({ version: 2, body: "v2 {{firstName}}", allowedVariables: ["firstName"] }),
    );

    const all = await service.listTemplates({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
    });
    expect(all.map((t) => `${t.templateId}@${t.version}`)).toEqual([
      `${TEMPLATE_ID}@1`,
      `${TEMPLATE_ID}@2`,
      "rtpl_z_sms@1",
    ]);
    const email = await service.listTemplates({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      channel: "EMAIL",
    });
    expect(email.every((t) => t.channel === "EMAIL")).toBe(true);
    expect(email).toHaveLength(2);
    expect(
      await service.listTemplates({
        customerAccountId: "other_tenant",
        projectId: RR_PROJECT,
      }),
    ).toEqual([]);
  });

  it("renders provisioned content only from server-supplied allowlisted values", async () => {
    const { service } = await harness();
    const { template } = await service.provisionTemplate(templateInput());
    const rendered = renderTemplate(template.body, template.allowedVariables, {
      firstName: "Alex",
      serviceRequested: "roof repair",
      bookingLink: "https://example.com/book",
    });
    expect(rendered).toBe(
      "Hi Alex, following up on your roof repair request. Book: https://example.com/book",
    );
  });

  it("creates no attempt, send, approval, or authorization; consent and provider mode unchanged", async () => {
    const product = await harness();
    const { recoveryCaseId, lead } = await seedBoundCase(product);
    const providerModeBefore = process.env["RECOVERY_PROVIDER_MODE"];
    const auditsBefore = product.repos.audits.listAll().length;

    await product.service.provisionTemplate(templateInput());
    await product.service.provisionTemplate(
      templateInput({ version: 2, body: "v2 {{firstName}}", allowedVariables: ["firstName"] }),
    );

    expect(await product.repos.attempts.listByCase(recoveryCaseId)).toEqual([]);
    expect(
      (product.messaging as { sent?: unknown[] }).sent ?? [],
    ).toHaveLength(0);
    expect(product.pilotConfig.mode).toBe("FAKE");
    expect(process.env["RECOVERY_PROVIDER_MODE"]).toBe(providerModeBefore);

    const leadAfter = await product.repos.leads.getById(lead.leadId);
    expect(leadAfter?.consent).toEqual(lead.consent);
    expect(leadAfter?.recordRevision).toBe(lead.recordRevision);
    const caseAfter = await product.repos.cases.getById(recoveryCaseId);
    expect(caseAfter?.status).toBe("IN_ORCHESTRATION");
    expect(caseAfter?.recordRevision).toBe(1);

    const newAudits = product.repos.audits.listAll().slice(auditsBefore);
    expect(newAudits.map((e) => e.kind)).toEqual([
      "RECOVERY_TEMPLATE_PROVISIONED",
      "RECOVERY_TEMPLATE_PROVISIONED",
    ]);
  });
});
