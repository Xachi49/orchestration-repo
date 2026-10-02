/**
 * Planning-path regression for the pilot replacement-run failure:
 * a malformed model rr_template: suggestion must not block canonical binding.
 *
 * MODEL PROPOSAL != TARGET AUTHORITY.
 * MALFORMED MODEL METADATA != MALFORMED CANONICAL PLAN.
 * WELL-FORMED CONFLICTING MODEL AUTHORITY != IGNORABLE.
 */
import { describe, expect, it } from "vitest";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
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
import {
  createRecoveryEmailPlanningModel,
  RECOVERY_EMAIL_POSTCONDITION,
  type RecoveryEmailPlanBinding,
} from "./recovery-email-planning-model.js";
import { RevenueRecoveryTargetBinder } from "./target-binder.js";
import { validateRecoveryStepsTargetGrammar } from "./target-grammar.js";

const PILOT_TEMPLATE = "rtpl_continuum_rr_email_followup";

async function ingestedRecoveryRun() {
  const binding: RecoveryEmailPlanBinding = {
    recoveryCaseId: "",
    leadId: "",
    templateId: "",
    templateVersion: 1,
  };
  const stack = createLocalExecutionStack({
    projects: [{ ...EXAMPLE_PROJECT, executionMode: "SUPERVISED" }],
    planningModel: createRecoveryEmailPlanningModel(binding),
    actuator: new FakeSafeActuator(),
    approvalDelivery: new FakeApprovalDeliveryService(),
    clockIso: RR_MONDAY_IN_WINDOW,
  });
  const { service, repos } = createMemoryRevenueRecoveryService({
    nowIso: () => RR_MONDAY_IN_WINDOW,
    admission: stack.admission,
    orchestrator: stack,
  });
  await service.putConfiguration(
    demoRecoveryConfig({
      timezone: "UTC",
      contactWindow: { startHourLocal: 9, endHourLocal: 17, daysOfWeek: [1, 2, 3, 4, 5] },
      cooldownMinutes: 0,
      allowedChannels: ["EMAIL"],
      maxEmailAttempts: 1,
    }),
  );
  await service.saveTemplate({
    templateId: PILOT_TEMPLATE,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    channel: "EMAIL",
    version: 1,
    body: "Hi {{firstName}} — checking in from {{businessName}}.",
    allowedVariables: ["firstName", "businessName"],
    enabled: true,
  });
  const { lead } = await service.ingestLead(demoLead({ createdAt: RR_LEAD_CREATED_AT }));
  const opened = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  const recoveryCaseId = opened.recoveryCase!.recoveryCaseId;
  Object.assign(binding, { recoveryCaseId, leadId: lead.leadId, templateId: PILOT_TEMPLATE });
  const binder = new RevenueRecoveryTargetBinder({
    runs: stack.runs,
    objectives: stack.objectives,
    cases: repos.cases,
    leads: repos.leads,
    templates: repos.templates,
  });
  stack.planning.bindRecoveryTargetBinder(binder);
  stack.validation.bindRecoveryTargetBinder(binder);

  const objectiveId = `obj_rr_${recoveryCaseId}`;
  const admitted = await stack.admission.admit(
    exampleAdmissionRequest({
      objectiveId,
      requestedOutcome: "Recover one unanswered inbound lead",
      acceptanceCriteria: [RECOVERY_EMAIL_POSTCONDITION],
      constraints: ["Allowed channels: EMAIL", "Max email attempts: 1"],
    }),
  );
  if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
  const runId = admitted.runId;
  const fresh = (await repos.cases.getById(recoveryCaseId))!;
  await repos.cases.save({
    ...fresh,
    status: "IN_ORCHESTRATION",
    objectiveId,
    orchestratorRunId: runId,
    updatedAt: RR_MONDAY_IN_WINDOW,
    recordRevision: fresh.recordRevision + 1,
  });
  await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
  return { stack, binding, runId, recoveryCaseId, leadId: lead.leadId, repos };
}

describe("planning — untrusted rr_template normalization", () => {
  it("malformed model template version → plan binds rr_template:<canonical>@1 and validates", async () => {
    const r = await ingestedRecoveryRun();
    r.binding.templateVersion = 0;
    const templateBefore = await r.repos.templates.listEnabled({
      customerAccountId: RR_CUSTOMER,
      projectId: RR_PROJECT,
      channel: "EMAIL",
    });

    const planned = await r.stack.planning.plan(r.runId);
    expect(planned).toMatchObject({ outcome: "PLANNED", runState: "VALIDATING" });
    const stored = (await r.stack.plans.getByRunId(r.runId))!;
    const email = stored.plan.steps.find((s) => s.actionType === "SEND_RECOVERY_EMAIL")!;
    expect(email.targetIds).toEqual([
      `rr_case:${r.recoveryCaseId}`,
      `rr_lead:${r.leadId}`,
      `rr_template:${PILOT_TEMPLATE}@1`,
    ]);
    expect(validateRecoveryStepsTargetGrammar(stored.plan.steps)).toMatchObject({ ok: true });

    const validated = await r.stack.validation.validate(r.runId);
    expect(["VALIDATED_PASS", "VALIDATED_APPROVAL_REQUIRED"]).toContain(validated.planStatus);
    expect(
      await r.repos.templates.listEnabled({
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        channel: "EMAIL",
      }),
    ).toEqual(templateBefore);
  });

  it("well-formed conflicting template still fails closed; the PLANNING run re-plans on a retryable fence", async () => {
    const r = await ingestedRecoveryRun();
    r.binding.templateVersion = 2;

    await expect(r.stack.planning.plan(r.runId)).rejects.toMatchObject({
      code: "RECOVERY_TARGET_BINDING_FAILED",
      details: { binderCode: "MODEL_TARGET_CONFLICT" },
    });
    expect((await r.stack.runs.getById(r.runId))!.state).toBe("PLANNING");
    expect(await r.stack.plans.getByRunId(r.runId)).toBeNull();
    expect(await r.stack.planningCoordinator.get(r.runId)).toMatchObject({
      status: "FAILED",
      attempt: 1,
      failureCode: "RECOVERY_TARGET_BINDING_FAILED",
      retryable: true,
    });

    // Same state as the stranded pilot run: PLANNING + retryable FAILED fence.
    r.binding.templateVersion = 0;
    const replanned = await r.stack.planning.plan(r.runId);
    expect(replanned).toMatchObject({ outcome: "PLANNED", runState: "VALIDATING" });
    expect(await r.stack.planningCoordinator.get(r.runId)).toMatchObject({
      status: "PLANNED",
      attempt: 2,
    });
    const stored = (await r.stack.plans.getByRunId(r.runId))!;
    expect(
      stored.plan.steps.find((s) => s.actionType === "SEND_RECOVERY_EMAIL")!.targetIds,
    ).toContain(`rr_template:${PILOT_TEMPLATE}@1`);
  });
});
