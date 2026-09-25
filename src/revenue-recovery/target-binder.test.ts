import { describe, expect, it } from "vitest";
import {
  parseRecoveryOutreachTargets,
  validateRecoveryStepsTargetGrammar,
  formatRecoveryCaseTarget,
  formatRecoveryLeadTarget,
  formatRecoveryTemplateTarget,
} from "./target-grammar.js";
import {
  RevenueRecoveryTargetBinder,
  RecoveryTargetBinderError,
} from "./target-binder.js";
import { createInMemoryRevenueRecoveryRepos } from "./memory-repositories.js";
import { InMemoryRunRepository } from "../infrastructure/admission/in-memory-run-repository.js";
import { InMemoryObjectiveRepository } from "../infrastructure/admission/in-memory-objective-repository.js";
import { parseRecoveryCase } from "./recovery-case.js";
import { parseLead } from "./lead.js";
import { parseRecoveryMessageTemplate } from "./recovery-template.js";
import { RunRecordSchema } from "../admission/run-repository.js";

function leadFixture(input: {
  leadId: string;
  customerAccountId: string;
  projectId: string;
  externalLeadId: string;
  now: string;
}) {
  return parseLead({
    leadId: input.leadId,
    customerAccountId: input.customerAccountId,
    projectId: input.projectId,
    source: "WEBHOOK",
    externalLeadId: input.externalLeadId,
    createdAt: input.now,
    firstName: "Alex",
    email: "alex@example.com",
    phone: "+15551234567",
    consent: { smsOptIn: true, emailOptIn: true, callOptIn: true },
    materialFingerprint: "mfp",
    recordRevision: 1,
    ingestedAt: input.now,
  });
}

function runFixture(input: {
  runId: string;
  projectId: string;
  objectiveId: string;
  now: string;
  state?: "PLANNING" | "APPROVED" | "VALIDATING";
}) {
  return RunRecordSchema.parse({
    runId: input.runId,
    projectId: input.projectId,
    objectiveId: input.objectiveId,
    objectiveVersion: 1,
    idempotencyKey: `idem_${input.runId}`,
    requesterId: "req",
    requestedEnvironment: "development",
    state: input.state ?? "PLANNING",
    recordRevision: 1,
    createdAt: input.now,
    updatedAt: input.now,
    correlationId: "corr",
    traceId: "trace",
  });
}

describe("recovery target grammar", () => {
  it("parses canonical rr_case/rr_lead/rr_template", () => {
    const parsed = parseRecoveryOutreachTargets(
      [
        "rr_case:rcase_1",
        "rr_lead:lead_1",
        "rr_template:rtpl_1@2",
      ],
      { requireTemplate: true },
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual({
        recoveryCaseId: "rcase_1",
        leadId: "lead_1",
        templateId: "rtpl_1",
        templateVersion: 2,
      });
    }
  });

  it("fails closed on empty targetIds", () => {
    const parsed = parseRecoveryOutreachTargets([], { requireTemplate: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("RECOVERY_TARGETS_MISSING");
    }
  });

  it("requires template for email/sms contract", () => {
    const parsed = parseRecoveryOutreachTargets(
      ["rr_case:c", "rr_lead:l"],
      { requireTemplate: true },
    );
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("RECOVERY_TEMPLATE_REQUIRED");
    }
  });

  it("validateRecoveryStepsTargetGrammar rejects empty email targets", () => {
    const result = validateRecoveryStepsTargetGrammar([
      {
        stepId: "step_recovery_email",
        actionType: "SEND_RECOVERY_EMAIL",
        targetIds: [],
      },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("RevenueRecoveryTargetBinder", () => {
  async function seed() {
    const repos = createInMemoryRevenueRecoveryRepos();
    const runs = new InMemoryRunRepository();
    const objectives = new InMemoryObjectiveRepository();
    const now = "2026-09-14T15:00:00.000Z";
    const recoveryCaseId = "rcase_bind_1";
    const leadId = "lead_bind_1";
    const runId = "run_bind_1";
    const objectiveId = `obj_rr_${recoveryCaseId}`;

    await repos.leads.save(
      leadFixture({
        leadId,
        customerAccountId: "cust_a",
        projectId: "proj_a",
        externalLeadId: "ext_1",
        now,
      }),
    );
    await repos.cases.save(
      parseRecoveryCase({
        recoveryCaseId,
        gapIdentityKey: "gap_1",
        leadId,
        customerAccountId: "cust_a",
        projectId: "proj_a",
        gapDetectedAt: now,
        reasonCode: "NO_RESPONSE",
        status: "IN_ORCHESTRATION",
        configId: "cfg_1",
        configVersion: 1,
        configFingerprint: "fp",
        orchestratorRunId: runId,
        objectiveId,
        createdAt: now,
        updatedAt: now,
        recordRevision: 1,
      }),
    );
    await repos.templates.save(
      parseRecoveryMessageTemplate({
        templateId: "rtpl_email_1",
        customerAccountId: "cust_a",
        projectId: "proj_a",
        channel: "EMAIL",
        version: 1,
        body: "Hello {{firstName}}",
        allowedVariables: ["firstName"],
        enabled: true,
        createdAt: now,
      }),
    );
    await runs.create(
      runFixture({
        runId,
        projectId: "proj_a",
        objectiveId,
        now,
      }),
    );

    const binder = new RevenueRecoveryTargetBinder({
      runs,
      objectives,
      cases: repos.cases,
      leads: repos.leads,
      templates: repos.templates,
    });
    return { binder, recoveryCaseId, leadId, runId };
  }

  it("fills empty model targets from canonical records", async () => {
    const { binder, recoveryCaseId, leadId, runId } = await seed();
    const steps = await binder.bindProposalSteps({
      runId,
      steps: [
        {
          stepId: "step_recovery_email",
          actionType: "SEND_RECOVERY_EMAIL",
          description: "Send recovery email",
          targetIds: [],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: ["done"],
          resourceEstimate: { durationMs: 1 },
          risk: { level: "MEDIUM", categories: [] },
          validationChecks: [],
          rollbackStrategy: "NONE",
        },
      ] as never,
    });
    expect(steps[0]?.targetIds).toEqual([
      formatRecoveryCaseTarget(recoveryCaseId),
      formatRecoveryLeadTarget(leadId),
      formatRecoveryTemplateTarget("rtpl_email_1", 1),
    ]);
  });

  it("rejects model-selected conflicting case/lead", async () => {
    const { binder, runId } = await seed();
    await expect(
      binder.bindProposalSteps({
        runId,
        steps: [
          {
            stepId: "step_recovery_email",
            actionType: "SEND_RECOVERY_EMAIL",
            description: "Send recovery email",
            targetIds: [
              "rr_case:rcase_other",
              "rr_lead:lead_other",
              "rr_template:rtpl_email_1@1",
            ],
            evidenceRefs: [],
            dependsOn: [],
            preconditions: [],
            expectedPostconditions: ["done"],
            resourceEstimate: { durationMs: 1 },
            risk: { level: "MEDIUM", categories: [] },
            validationChecks: [],
            rollbackStrategy: "NONE",
          },
        ] as never,
      }),
    ).rejects.toMatchObject({
      code: "MODEL_TARGET_CONFLICT",
    });
  });

  it("fails closed when no enabled template exists", async () => {
    const repos = createInMemoryRevenueRecoveryRepos();
    const runs = new InMemoryRunRepository();
    const objectives = new InMemoryObjectiveRepository();
    const now = "2026-09-14T15:00:00.000Z";
    const recoveryCaseId = "rcase_notpl";
    const leadId = "lead_notpl";
    const runId = "run_notpl";
    await repos.leads.save(
      leadFixture({
        leadId,
        customerAccountId: "cust_a",
        projectId: "proj_a",
        externalLeadId: "ext_2",
        now,
      }),
    );
    await repos.cases.save(
      parseRecoveryCase({
        recoveryCaseId,
        gapIdentityKey: "gap_2",
        leadId,
        customerAccountId: "cust_a",
        projectId: "proj_a",
        gapDetectedAt: now,
        reasonCode: "NO_RESPONSE",
        status: "IN_ORCHESTRATION",
        configId: "cfg_1",
        configVersion: 1,
        configFingerprint: "fp",
        orchestratorRunId: runId,
        objectiveId: `obj_rr_${recoveryCaseId}`,
        createdAt: now,
        updatedAt: now,
        recordRevision: 1,
      }),
    );
    await runs.create(
      runFixture({
        runId,
        projectId: "proj_a",
        objectiveId: `obj_rr_${recoveryCaseId}`,
        now,
      }),
    );
    const binder = new RevenueRecoveryTargetBinder({
      runs,
      objectives,
      cases: repos.cases,
      leads: repos.leads,
      templates: repos.templates,
    });
    await expect(
      binder.resolveCanonicalBinding({ runId, channel: "EMAIL" }),
    ).rejects.toBeInstanceOf(RecoveryTargetBinderError);
  });
});
