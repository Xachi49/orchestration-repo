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

  it.each([
    ["rr_template:foo", "RECOVERY_TEMPLATE_MALFORMED"],
    ["rr_template:@1", "RECOVERY_TEMPLATE_MALFORMED"],
    ["rr_template:foo@", "RECOVERY_TEMPLATE_VERSION_INVALID"],
    ["rr_template:foo@0", "RECOVERY_TEMPLATE_VERSION_INVALID"],
    ["rr_template:foo@abc", "RECOVERY_TEMPLATE_VERSION_INVALID"],
  ])("stays strict for compiled/execution targets: %s → %s", (template, code) => {
    expect(
      parseRecoveryOutreachTargets(["rr_case:c", "rr_lead:l", template], {
        requireTemplate: true,
      }),
    ).toMatchObject({ ok: false, code });
    expect(
      validateRecoveryStepsTargetGrammar([
        {
          stepId: "step_recovery_email",
          actionType: "SEND_RECOVERY_EMAIL",
          targetIds: ["rr_case:c", "rr_lead:l", template],
        },
      ]),
    ).toMatchObject({ ok: false, code });
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
  async function seed(emailTemplateId = "rtpl_email_1") {
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
        templateId: emailTemplateId,
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
    await repos.templates.save(
      parseRecoveryMessageTemplate({
        templateId: "rtpl_sms_1",
        customerAccountId: "cust_a",
        projectId: "proj_a",
        channel: "SMS",
        version: 3,
        body: "Hi {{firstName}}",
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

  it("generic plan: NO-OP without RecoveryCase repository lookup", async () => {
    let caseLookups = 0;
    const repos = createInMemoryRevenueRecoveryRepos();
    const runs = new InMemoryRunRepository();
    const objectives = new InMemoryObjectiveRepository();
    const cases: typeof repos.cases = {
      getById: async (id) => {
        caseLookups += 1;
        return repos.cases.getById(id);
      },
      getByGapIdentity: async (key) => {
        caseLookups += 1;
        return repos.cases.getByGapIdentity(key);
      },
      getByOrchestratorRunId: async (runId) => {
        caseLookups += 1;
        return repos.cases.getByOrchestratorRunId(runId);
      },
      listOpenByLead: (leadId) => repos.cases.listOpenByLead(leadId),
      listByProject: (input) => repos.cases.listByProject(input),
      save: (c) => repos.cases.save(c),
      compareAndSetOrchestratorRunBinding: (swap) =>
        repos.cases.compareAndSetOrchestratorRunBinding(swap),
    };
    const binder = new RevenueRecoveryTargetBinder({
      runs,
      objectives,
      cases,
      leads: repos.leads,
      templates: repos.templates,
    });
    const steps = [
      {
        stepId: "step_read",
        actionType: "READ_FILE",
        description: "Read a file",
        targetIds: ["file:readme"],
        evidenceRefs: [],
        dependsOn: [],
        preconditions: [],
        expectedPostconditions: ["read"],
        resourceEstimate: { durationMs: 1 },
        risk: { level: "LOW", categories: [] },
        validationChecks: [],
        rollbackStrategy: "NONE",
      },
    ] as never;
    const bound = await binder.bindProposalSteps({
      runId: "run_generic",
      steps,
    });
    expect(bound).toEqual(steps);
    expect(caseLookups).toBe(0);
  });

  it("RR plan without RecoveryCase fails closed", async () => {
    const repos = createInMemoryRevenueRecoveryRepos();
    const runs = new InMemoryRunRepository();
    const objectives = new InMemoryObjectiveRepository();
    const now = "2026-09-14T15:00:00.000Z";
    const runId = "run_unbound";
    await runs.create(
      runFixture({
        runId,
        projectId: "proj_a",
        objectiveId: "obj_generic_not_rr",
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
      binder.bindProposalSteps({
        runId,
        steps: [
          {
            stepId: "step_recovery_sms",
            actionType: "SEND_RECOVERY_SMS",
            description: "Send recovery SMS",
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
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_CASE_NOT_BOUND",
    });
  });

  it("mixed plan: generic steps untouched; RR steps get canonical targets", async () => {
    const { binder, recoveryCaseId, leadId, runId } = await seed();
    const bound = await binder.bindProposalSteps({
      runId,
      steps: [
        {
          stepId: "step_read",
          actionType: "READ_FILE",
          description: "Read a file",
          targetIds: ["file:readme"],
          evidenceRefs: [],
          dependsOn: [],
          preconditions: [],
          expectedPostconditions: ["read"],
          resourceEstimate: { durationMs: 1 },
          risk: { level: "LOW", categories: [] },
          validationChecks: [],
          rollbackStrategy: "NONE",
        },
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
    expect(bound[0]?.targetIds).toEqual(["file:readme"]);
    expect(bound[1]?.targetIds).toEqual([
      formatRecoveryCaseTarget(recoveryCaseId),
      formatRecoveryLeadTarget(leadId),
      formatRecoveryTemplateTarget("rtpl_email_1", 1),
    ]);
  });

  it("mixed plan without RecoveryCase still fails closed on RR step", async () => {
    const repos = createInMemoryRevenueRecoveryRepos();
    const runs = new InMemoryRunRepository();
    const objectives = new InMemoryObjectiveRepository();
    const now = "2026-09-14T15:00:00.000Z";
    const runId = "run_mixed_unbound";
    await runs.create(
      runFixture({
        runId,
        projectId: "proj_a",
        objectiveId: "obj_no_case",
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
      binder.bindProposalSteps({
        runId,
        steps: [
          {
            stepId: "step_read",
            actionType: "READ_FILE",
            description: "Read",
            targetIds: ["file:x"],
            evidenceRefs: [],
            dependsOn: [],
            preconditions: [],
            expectedPostconditions: [],
            resourceEstimate: { durationMs: 1 },
            risk: { level: "LOW", categories: [] },
            validationChecks: [],
            rollbackStrategy: "NONE",
          },
          {
            stepId: "step_recovery_email",
            actionType: "SEND_RECOVERY_EMAIL",
            description: "Send",
            targetIds: [],
            evidenceRefs: [],
            dependsOn: [],
            preconditions: [],
            expectedPostconditions: [],
            resourceEstimate: { durationMs: 1 },
            risk: { level: "MEDIUM", categories: [] },
            validationChecks: [],
            rollbackStrategy: "NONE",
          },
        ] as never,
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_CASE_NOT_BOUND" });
  });

  describe("untrusted model target normalization", () => {
    const PILOT_TEMPLATE = "rtpl_continuum_rr_email_followup";
    const MALFORMED_TEMPLATES = [
      "rr_template:foo",
      "rr_template:foo@",
      "rr_template:foo@0",
      "rr_template:foo@abc",
      "rr_template:@1",
      `rr_template:${PILOT_TEMPLATE}@0`,
      `rr_template:${PILOT_TEMPLATE}@NaN`,
      `rr_template:${PILOT_TEMPLATE}@v1`,
      `rr_template:${PILOT_TEMPLATE}@1.5`,
      `rr_template:${PILOT_TEMPLATE}@-1`,
      `rr_template:${PILOT_TEMPLATE}`,
    ];

    function step(actionType: string, targetIds: string[]) {
      return {
        stepId: `step_${actionType.toLowerCase()}`,
        actionType,
        description: actionType,
        targetIds,
        evidenceRefs: [],
        dependsOn: [],
        preconditions: [],
        expectedPostconditions: ["done"],
        resourceEstimate: { durationMs: 1 },
        risk: { level: "MEDIUM", categories: [] },
        validationChecks: [],
        rollbackStrategy: "NONE",
      };
    }

    async function bindOne(
      seeded: Awaited<ReturnType<typeof seed>>,
      actionType: string,
      targetIds: string[],
    ) {
      const bound = await seeded.binder.bindProposalSteps({
        runId: seeded.runId,
        steps: [step(actionType, targetIds)] as never,
      });
      return bound[0]!;
    }

    function expectStrictGrammar(bound: { stepId: string; actionType: string; targetIds: readonly string[] }) {
      expect(validateRecoveryStepsTargetGrammar([bound])).toMatchObject({ ok: true });
    }

    it("pilot incident: malformed rr_template version is replaced by the canonical template", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      const malformed = `rr_template:${PILOT_TEMPLATE}@0`;
      // The suggestion itself is rejected by the strict shared grammar.
      expect(
        parseRecoveryOutreachTargets(
          [
            formatRecoveryCaseTarget(seeded.recoveryCaseId),
            formatRecoveryLeadTarget(seeded.leadId),
            malformed,
          ],
          { requireTemplate: true },
        ),
      ).toMatchObject({ ok: false, code: "RECOVERY_TEMPLATE_VERSION_INVALID" });

      for (const modelTargets of [
        [
          formatRecoveryCaseTarget(seeded.recoveryCaseId),
          formatRecoveryLeadTarget(seeded.leadId),
          malformed,
        ],
        [malformed],
      ]) {
        const bound = await bindOne(seeded, "SEND_RECOVERY_EMAIL", modelTargets);
        expect(bound.targetIds).toEqual([
          `rr_case:${seeded.recoveryCaseId}`,
          `rr_lead:${seeded.leadId}`,
          `rr_template:${PILOT_TEMPLATE}@1`,
        ]);
        expectStrictGrammar(bound);
        expect(
          parseRecoveryOutreachTargets(bound.targetIds, { requireTemplate: true }),
        ).toEqual({
          ok: true,
          value: {
            recoveryCaseId: seeded.recoveryCaseId,
            leadId: seeded.leadId,
            templateId: PILOT_TEMPLATE,
            templateVersion: 1,
          },
        });
      }
    });

    it.each(MALFORMED_TEMPLATES)(
      "correct case + lead + malformed %s → canonicalized",
      async (malformed) => {
        const seeded = await seed(PILOT_TEMPLATE);
        const bound = await bindOne(seeded, "SEND_RECOVERY_EMAIL", [
          formatRecoveryCaseTarget(seeded.recoveryCaseId),
          formatRecoveryLeadTarget(seeded.leadId),
          malformed,
        ]);
        expect(bound.targetIds).toEqual([
          formatRecoveryCaseTarget(seeded.recoveryCaseId),
          formatRecoveryLeadTarget(seeded.leadId),
          formatRecoveryTemplateTarget(PILOT_TEMPLATE, 1),
        ]);
        expectStrictGrammar(bound);
      },
    );

    it("SMS: malformed rr_template is replaced by the canonical SMS template", async () => {
      const seeded = await seed();
      const bound = await bindOne(seeded, "SEND_RECOVERY_SMS", [
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
        "rr_template:rtpl_sms_1@abc",
      ]);
      expect(bound.targetIds).toEqual([
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
        formatRecoveryLeadTarget(seeded.leadId),
        formatRecoveryTemplateTarget("rtpl_sms_1", 3),
      ]);
      expectStrictGrammar(bound);
    });

    it("missing template → canonicalized", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      const bound = await bindOne(seeded, "SEND_RECOVERY_EMAIL", [
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
        formatRecoveryLeadTarget(seeded.leadId),
      ]);
      expect(bound.targetIds).toEqual([
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
        formatRecoveryLeadTarget(seeded.leadId),
        formatRecoveryTemplateTarget(PILOT_TEMPLATE, 1),
      ]);
      expectStrictGrammar(bound);
    });

    it("well-formed canonical template → succeeds and is rewritten from the binding", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      const bound = await bindOne(seeded, "SEND_RECOVERY_EMAIL", [
        "rr_note:keep",
        formatRecoveryTemplateTarget(PILOT_TEMPLATE, 1),
        formatRecoveryLeadTarget(seeded.leadId),
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
      ]);
      expect(bound.targetIds).toEqual([
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
        formatRecoveryLeadTarget(seeded.leadId),
        formatRecoveryTemplateTarget(PILOT_TEMPLATE, 1),
        "rr_note:keep",
      ]);
      expectStrictGrammar(bound);
    });

    it.each([
      ["wrong templateId", "rr_template:rtpl_other@1"],
      ["wrong templateVersion", `rr_template:${PILOT_TEMPLATE}@2`],
    ])("well-formed %s → MODEL_TARGET_CONFLICT", async (_label, template) => {
      const seeded = await seed(PILOT_TEMPLATE);
      for (const modelTargets of [
        [
          formatRecoveryCaseTarget(seeded.recoveryCaseId),
          formatRecoveryLeadTarget(seeded.leadId),
          template,
        ],
        [template],
      ]) {
        await expect(
          bindOne(seeded, "SEND_RECOVERY_EMAIL", modelTargets),
        ).rejects.toMatchObject({
          code: "MODEL_TARGET_CONFLICT",
          message: "Model rr_template: conflicts with canonical template binding",
        });
      }
    });

    it.each([
      ["wrong case", { case: "rcase_wrong" }, "Model rr_case: conflicts with canonical RecoveryCase"],
      ["wrong lead", { lead: "lead_wrong" }, "Model rr_lead: conflicts with canonical Lead"],
      [
        "wrong case + wrong lead",
        { case: "rcase_wrong", lead: "lead_wrong" },
        "Model rr_case: conflicts with canonical RecoveryCase",
      ],
    ])(
      "%s + malformed template → still MODEL_TARGET_CONFLICT",
      async (_label, wrong: { case?: string; lead?: string }, message) => {
        const seeded = await seed(PILOT_TEMPLATE);
        await expect(
          bindOne(seeded, "SEND_RECOVERY_EMAIL", [
            formatRecoveryCaseTarget(wrong.case ?? seeded.recoveryCaseId),
            formatRecoveryLeadTarget(wrong.lead ?? seeded.leadId),
            "rr_template:foo@abc",
          ]),
        ).rejects.toMatchObject({ code: "MODEL_TARGET_CONFLICT", message });
      },
    );

    it("a lone conflicting case or lead claim fails closed even when the other is absent", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      for (const modelTargets of [
        ["rr_case:rcase_wrong", "rr_template:foo@abc"],
        ["rr_lead:lead_wrong"],
      ]) {
        await expect(
          bindOne(seeded, "SEND_RECOVERY_EMAIL", modelTargets),
        ).rejects.toMatchObject({ code: "MODEL_TARGET_CONFLICT" });
      }
    });

    it("empty case/lead/template values are incomplete, not claims → canonicalized", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      const bound = await bindOne(seeded, "SEND_RECOVERY_EMAIL", [
        "rr_case:",
        "rr_lead:",
        "rr_template:",
      ]);
      expect(bound.targetIds).toEqual([
        formatRecoveryCaseTarget(seeded.recoveryCaseId),
        formatRecoveryLeadTarget(seeded.leadId),
        formatRecoveryTemplateTarget(PILOT_TEMPLATE, 1),
      ]);
      expectStrictGrammar(bound);
    });

    it("callback: malformed or arbitrary rr_template is ignored; case/lead canonical; no template emitted", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      for (const template of ["rr_template:foo@abc", "rr_template:rtpl_other@9"]) {
        const bound = await bindOne(seeded, "CREATE_CALLBACK_TASK", [
          formatRecoveryCaseTarget(seeded.recoveryCaseId),
          template,
          "rr_note:call after 5pm",
        ]);
        expect(bound.targetIds).toEqual([
          formatRecoveryCaseTarget(seeded.recoveryCaseId),
          formatRecoveryLeadTarget(seeded.leadId),
          "rr_note:call after 5pm",
        ]);
        expect(bound.targetIds.some((t) => t.startsWith("rr_template:"))).toBe(false);
        expectStrictGrammar(bound);
      }
    });

    it("callback: conflicting case or lead still blocks", async () => {
      const seeded = await seed(PILOT_TEMPLATE);
      for (const modelTargets of [
        ["rr_case:rcase_wrong", "rr_template:foo@abc"],
        [formatRecoveryCaseTarget(seeded.recoveryCaseId), "rr_lead:lead_wrong"],
      ]) {
        await expect(
          bindOne(seeded, "CREATE_CALLBACK_TASK", modelTargets),
        ).rejects.toMatchObject({ code: "MODEL_TARGET_CONFLICT" });
      }
    });
  });
});
