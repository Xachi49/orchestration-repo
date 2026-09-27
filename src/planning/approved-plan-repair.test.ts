/**
 * Approved-plan repair for structurally unexecutable Revenue Recovery plans.
 * Does not call OpenAI/Resend. Does not mutate production.
 */
import { describe, expect, it } from "vitest";
import { createLocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  ApprovedPlanRepairService,
  InMemoryApprovedPlanRepairCoordinator,
} from "../planning/approved-plan-repair.js";
import { RevenueRecoveryTargetBinder } from "../revenue-recovery/target-binder.js";
import { createMemoryRevenueRecoveryService } from "../api/revenue-recovery-factory.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import { createRecoveryEmailPlanningModel } from "../revenue-recovery/recovery-email-planning-model.js";
import { FakePlanningModel } from "../planning/fake-planning-model.js";
import type { PlanningContext } from "../planning/context.js";
import type { PlanningModelOutput } from "../planning/model.js";
import type { GapAnalysis, PlanProposal } from "../planning/proposal.js";
import { parsePlanProposal } from "../planning/proposal.js";
import { proposeBindingsForSteps } from "../planning/verification-bindings.js";
import { DryRunCompiler } from "../execution/dry-run.js";
import { TestProfileRegistry } from "../execution/test-profiles.js";
import { executionFenceKey } from "../execution/coordinator.js";
import { buildServer } from "../api/server.js";
import { FakeSafeActuator } from "../infrastructure/execution/actuators.js";
import { RevenueRecoveryPhase7Actuator } from "../revenue-recovery/phase7-actuator.js";
import { validateRecoveryStepsTargetGrammar } from "../revenue-recovery/target-grammar.js";

const MONDAY = "2026-09-14T15:00:00.000Z";
const LEAD_CREATED = "2026-09-14T12:00:00.000Z";
const CRITERION = "Bounded recovery outreach attempt recorded";

/** OpenAI-shaped model: proposes SEND_RECOVERY_EMAIL with empty targetIds. */
class EmptyTargetEmailPlanningModel extends FakePlanningModel {
  override async proposePlan(input: {
    context: PlanningContext;
    gapAnalysis: GapAnalysis;
    promptVersion: string;
  }): Promise<PlanningModelOutput<PlanProposal>> {
    this.callCount += 1;
    const steps: PlanProposal["steps"] = [
      {
        stepId: "step_recovery_email",
        actionType: "SEND_RECOVERY_EMAIL",
        description: "Send one bounded recovery email",
        targetIds: [],
        evidenceRefs: input.context.contextMetadata.selectedEvidenceIds.slice(
          0,
          2,
        ),
        dependsOn: [],
        preconditions: ["Recovery case is active"],
        expectedPostconditions: [CRITERION],
        resourceEstimate: {
          durationMs: 20_000,
          tokenEstimate: 200,
          costEstimateUsd: 0.01,
        },
        risk: { level: "MEDIUM", categories: ["external-communication"] },
        validationChecks: ["Recovery attempt recorded"],
        rollbackStrategy: "NONE",
      },
    ];
    return {
      value: parsePlanProposal({
        gapAnalysis: input.gapAnalysis,
        workstreams: [
          {
            workstreamId: "ws_recovery_email",
            name: "Recovery email",
            stepIds: ["step_recovery_email"],
          },
        ],
        steps,
        successDefinition: [...input.context.objective.acceptanceCriteria],
        assumptions: [...input.gapAnalysis.assumptions],
        unknowns: [...input.gapAnalysis.unknowns],
        proposedRisks: [],
        proposedVerificationChecks: [CRITERION],
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
        conciseRationale: "Bounded recovery email with binder-owned targets.",
      }),
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    };
  }
}

async function seedProduct() {
  const { service, messaging, repos } = createMemoryRevenueRecoveryService({
    nowIso: () => MONDAY,
    pilotConfig: { mode: "SHADOW", livePilotRecipientAllowlist: [] },
  });
  await service.putConfiguration(
    demoRecoveryConfig({
      timezone: "UTC",
      contactWindow: {
        startHourLocal: 9,
        endHourLocal: 17,
        daysOfWeek: [1, 2, 3, 4, 5],
      },
      cooldownMinutes: 0,
    }),
  );
  const template = await service.saveTemplate({
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    channel: "EMAIL",
    version: 1,
    body: "Hi {{firstName}} — checking in from {{businessName}}.",
    allowedVariables: ["firstName", "businessName"],
    enabled: true,
  });
  const { lead } = await service.ingestLead(
    demoLead({ createdAt: LEAD_CREATED }),
  );
  const { recoveryCase } = await service.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
  });
  if (!recoveryCase) throw new Error("expected recovery case");
  return { service, messaging, repos, template, lead, recoveryCase };
}

describe("deterministic binder + planning gate", () => {
  it("OpenAI-shaped empty targets become canonically bound before plan hash", async () => {
    const product = await seedProduct();
    const delivery = new FakeApprovalDeliveryService();
    const stack = createLocalExecutionStack({
      projects: [{ ...EXAMPLE_PROJECT, executionMode: "SUPERVISED" }],
      planningModel: new EmptyTargetEmailPlanningModel(),
      approvalDelivery: delivery,
      clockIso: MONDAY,
    });
    const binder = new RevenueRecoveryTargetBinder({
      runs: stack.runs,
      objectives: stack.objectives,
      cases: product.repos.cases,
      leads: product.repos.leads,
      templates: product.repos.templates,
    });
    stack.planning.bindRecoveryTargetBinder(binder);
    stack.validation.bindRecoveryTargetBinder(binder);

    const admitted = await stack.admission.admit(
      exampleAdmissionRequest({
        objectiveId: `obj_rr_${product.recoveryCase.recoveryCaseId}`,
        requestedOutcome: "Recover unanswered lead",
        acceptanceCriteria: [CRITERION],
      }),
    );
    if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
    const runId = admitted.runId;
    await product.repos.cases.save({
      ...product.recoveryCase,
      orchestratorRunId: runId,
      objectiveId: `obj_rr_${product.recoveryCase.recoveryCaseId}`,
      updatedAt: MONDAY,
      recordRevision: product.recoveryCase.recordRevision + 1,
    });

    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    const planned = await stack.planning.plan(runId);
    expect(planned.outcome).toBe("PLANNED");
    const plan = await stack.plans.getByRunId(runId);
    expect(plan?.plan.steps[0]?.targetIds).toEqual([
      `rr_case:${product.recoveryCase.recoveryCaseId}`,
      `rr_lead:${product.lead.leadId}`,
      `rr_template:${product.template.templateId}@1`,
    ]);
    expect(plan?.planHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("model conflicting rr_case fails closed at planning", async () => {
    const product = await seedProduct();
    const model = createRecoveryEmailPlanningModel({
      recoveryCaseId: "rcase_attacker",
      leadId: "lead_attacker",
      templateId: product.template.templateId,
      templateVersion: 1,
    });
    const stack = createLocalExecutionStack({
      projects: [{ ...EXAMPLE_PROJECT, executionMode: "SUPERVISED" }],
      planningModel: model,
      clockIso: MONDAY,
    });
    const binder = new RevenueRecoveryTargetBinder({
      runs: stack.runs,
      objectives: stack.objectives,
      cases: product.repos.cases,
      leads: product.repos.leads,
      templates: product.repos.templates,
    });
    stack.planning.bindRecoveryTargetBinder(binder);

    const admitted = await stack.admission.admit(
      exampleAdmissionRequest({
        objectiveId: `obj_rr_${product.recoveryCase.recoveryCaseId}`,
        acceptanceCriteria: [CRITERION],
      }),
    );
    if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
    await product.repos.cases.save({
      ...product.recoveryCase,
      orchestratorRunId: admitted.runId,
      objectiveId: `obj_rr_${product.recoveryCase.recoveryCaseId}`,
      updatedAt: MONDAY,
      recordRevision: product.recoveryCase.recordRevision + 1,
    });
    await stack.ingestion.ingest(
      admitted.runId,
      EXAMPLE_PROJECT_ID,
      EXAMPLE_ENVIRONMENT,
    );
    await expect(stack.planning.plan(admitted.runId)).rejects.toMatchObject({
      code: "RECOVERY_TARGET_BINDING_FAILED",
    });
  });
});

describe("execution readiness + dry-run shared grammar", () => {
  it("shared grammar rejects empty email targets; dry-run rejects", () => {
    const steps = [
      {
        stepId: "step_recovery_email",
        actionType: "SEND_RECOVERY_EMAIL",
        targetIds: [] as string[],
      },
    ];
    const grammar = validateRecoveryStepsTargetGrammar(steps);
    expect(grammar.ok).toBe(false);

    const dry = new DryRunCompiler(new TestProfileRegistry());
    expect(() =>
      dry.compile({
        plan: {
          planId: "plan_x",
          planVersion: 1,
          objectiveId: "obj",
          objectiveVersion: 1,
          repositoryCommitSha: "abc",
          repositoryFingerprint: "fp",
          policyBundleId: "pol",
          policyBundleHash: "ph",
          schemaVersion: "1.0.0",
          assumptions: [],
          unknowns: [],
          successDefinition: ["x"],
          resourceTotals: {},
          criticalPath: ["step_recovery_email"],
          workstreams: [
            {
              workstreamId: "ws",
              name: "ws",
              stepIds: ["step_recovery_email"],
            },
          ],
          steps: [
            {
              stepId: "step_recovery_email",
              actionType: "SEND_RECOVERY_EMAIL",
              description: "email",
              targetIds: [],
              evidenceRefs: [],
              dependsOn: [],
              preconditions: [],
              expectedPostconditions: ["x"],
              resourceEstimate: {},
              risk: { level: "MEDIUM", categories: [] },
              validation: { checks: [] },
              rollback: { strategy: "NONE" },
              idempotencyKey: "plan_x:step_recovery_email",
            },
          ],
          approvalRequirements: [],
          failurePolicy: { onStepFailure: "BLOCK", maxRetries: 0 },
          acceptanceCriterionVerificationBindings: [],
          planHash: "deadbeef",
        } as never,
        workspaceRoot: "/tmp",
        capabilityIdsByAction: new Map([
          ["SEND_RECOVERY_EMAIL", "SEND_RECOVERY_EMAIL"],
        ]),
      }),
    ).toThrow(/rr_case/);
  });
});

describe("approved plan repair", () => {
  async function approvedBrokenRecoveryRun() {
    const product = await seedProduct();
    const delivery = new FakeApprovalDeliveryService();
    const actuator = new FakeSafeActuator();
    actuator.attachRevenueRecovery(
      new RevenueRecoveryPhase7Actuator(product.service),
    );
    // Plan with binder so we can approve a valid plan first, then we will
    // reconstruct the incident by saving an empty-target plan under a separate path.
    // Instead: plan without binder using empty model fails — so build via binder,
    // then replace latest plan content is impossible without hash break.
    // Construct: use binder to plan valid v0... Actually create empty-target plan
    // by planning with EmptyTarget model WITHOUT binder, but gate blocks.
    // Fixture: manually craft APPROVED state from a binder-planned run is wrong.
    //
    // Approach: plan WITH binder (valid targets), approve, then manually create
    // a sibling broken plan is not the incident.
    //
    // Correct fixture for incident: save broken plan before validation by
    // temporarily skipping binder — plan() fails. So inject plan after ingest:
    const stack = createLocalExecutionStack({
      projects: [{ ...EXAMPLE_PROJECT, executionMode: "SUPERVISED" }],
      planningModel: createRecoveryEmailPlanningModel({
        recoveryCaseId: product.recoveryCase.recoveryCaseId,
        leadId: product.lead.leadId,
        templateId: product.template.templateId,
        templateVersion: 1,
      }),
      approvalDelivery: delivery,
      actuator,
      clockIso: MONDAY,
    });
    const binder = new RevenueRecoveryTargetBinder({
      runs: stack.runs,
      objectives: stack.objectives,
      cases: product.repos.cases,
      leads: product.repos.leads,
      templates: product.repos.templates,
    });
    stack.planning.bindRecoveryTargetBinder(binder);

    const admitted = await stack.admission.admit(
      exampleAdmissionRequest({
        objectiveId: `obj_rr_${product.recoveryCase.recoveryCaseId}`,
        requestedOutcome: "Recover unanswered lead",
        acceptanceCriteria: [CRITERION],
      }),
    );
    if (admitted.outcome !== "ADMITTED") throw new Error("admit failed");
    const runId = admitted.runId;
    await product.repos.cases.save({
      ...product.recoveryCase,
      orchestratorRunId: runId,
      objectiveId: `obj_rr_${product.recoveryCase.recoveryCaseId}`,
      updatedAt: MONDAY,
      recordRevision: product.recoveryCase.recordRevision + 1,
    });
    await stack.ingestion.ingest(runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT);
    await stack.planning.plan(runId);

    // Corrupt targets to empty and re-persist with new hash while still VALIDATING
    const plan = (await stack.plans.getByRunId(runId))!;
    const { Sha256PlanHasher } = await import("../domain/plan/plan-hasher.js");
    const hasher = new Sha256PlanHasher();
    const brokenSteps = plan.plan.steps.map((s) =>
      s.actionType === "SEND_RECOVERY_EMAIL"
        ? { ...s, targetIds: [] as string[] }
        : s,
    );
    const forHash = { ...plan.plan, steps: brokenSteps };
    delete (forHash as { planHash?: string }).planHash;
    const planHash = hasher.hash(forHash);
    const brokenPlan = {
      ...plan,
      plan: { ...plan.plan, steps: brokenSteps, planHash },
      planHash,
    };
    await stack.plans.save(brokenPlan);

    expect(
      validateRecoveryStepsTargetGrammar(brokenPlan.plan.steps).ok,
    ).toBe(false);

    // Validate without recovery binder so REVISE cannot heal empty targets.
    await stack.validation.validate(runId);
    const afterValidate = (await stack.plans.getByRunId(runId))!;
    expect(
      validateRecoveryStepsTargetGrammar(afterValidate.plan.steps).ok,
    ).toBe(false);
    const routed = await stack.authorizationRouting.route(runId);
    if (routed.outcome !== "PENDING_APPROVAL") {
      throw new Error(`expected PENDING_APPROVAL got ${routed.outcome}`);
    }
    await stack.humanAuthorization.decide({
      approvalRequestId: routed.approvalRequestId,
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: delivery.nonceFor(routed.approvalRequestId)!,
    });

    const authz = await stack.authorizationRecords.getLatestByRun(runId);
    if (!authz) throw new Error("missing authz");
    const livePlan = (await stack.plans.getByRunId(runId))!;

    // Simulate failed execute: begin fence then markFailed (no attempt)
    const fenceKey = {
      runId,
      planId: livePlan.planId,
      planVersion: livePlan.planVersion,
      planHash: livePlan.planHash,
      authorizationRecordId: authz.authorizationRecordId,
    };
    const begin = await stack.executionCoordinator.begin(
      fenceKey,
      stack.clock.nowIso(),
    );
    if (begin.outcome !== "STARTED") throw new Error("expected STARTED fence");
    await stack.executionCoordinator.markFailed(
      fenceKey,
      begin.ownerToken,
      stack.clock.nowIso(),
      "EXECUTION_ARGUMENT_INVALID",
    );
    const fenceCheck = await stack.executionCoordinator.get(fenceKey);
    if (
      fenceCheck?.status !== "FAILED" ||
      fenceCheck.failureCode !== "EXECUTION_ARGUMENT_INVALID"
    ) {
      throw new Error(
        `expected FAILED fence, got ${fenceCheck?.status}/${fenceCheck?.failureCode}`,
      );
    }

    const repair = new ApprovedPlanRepairService({
      runs: stack.runs,
      plans: stack.plans,
      authorizationRecords: stack.authorizationRecords,
      approvalRequests: stack.approvalRequests,
      executionAttempts: stack.executionAttempts,
      executionCoordinator: stack.executionCoordinator,
      recoveryAttempts: product.repos.attempts,
      recoveryTargetBinder: binder,
      coordinator: new InMemoryApprovedPlanRepairCoordinator(),
      clock: stack.clock,
      identities: {
        nextPlanId: () => `plan_repaired_${Date.now()}`,
      },
    });

    return {
      product,
      stack,
      delivery,
      repair,
      binder,
      runId,
      brokenPlan: livePlan,
      authz,
      fenceKey,
      approvalRequestId: routed.approvalRequestId,
    };
  }

  it("repairs empty targets to plan v2 and leaves v1 authz historical", async () => {
    const ctx = await approvedBrokenRecoveryRun();
    const v1PlanId = ctx.brokenPlan.planId;
    const v1Hash = ctx.brokenPlan.planHash;
    const v1AuthzId = ctx.authz.authorizationRecordId;

    const result = await ctx.repair.repairApprovedPlan({
      runId: ctx.runId,
      reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
    });
    expect(result.outcome).toBe("REPAIRED");
    if (result.outcome !== "REPAIRED") return;

    expect(result.repairedPlanVersion).toBe(2);
    expect(result.repairedPlanId).not.toBe(v1PlanId);
    expect(result.repairedPlanHash).not.toBe(v1Hash);
    expect(result.runState).toBe("VALIDATING");

    const v1 = await ctx.stack.plans.getById(v1PlanId);
    expect(v1?.status).toBe("SUPERSEDED");
    expect(v1?.plan.steps[0]?.targetIds).toEqual([]);

    const v2 = await ctx.stack.plans.getByRunId(ctx.runId);
    expect(v2?.planId).toBe(result.repairedPlanId);
    expect(v2?.supersedesPlanId).toBe(v1PlanId);
    expect(v2?.status).toBe("READY_FOR_VALIDATION");
    expect(v2?.plan.steps[0]?.targetIds).toEqual([
      `rr_case:${ctx.product.recoveryCase.recoveryCaseId}`,
      `rr_lead:${ctx.product.lead.leadId}`,
      `rr_template:${ctx.product.template.templateId}@1`,
    ]);

    const authzStill = (
      await ctx.stack.authorizationRecords.listByRun(ctx.runId)
    ).find((r) => r.authorizationRecordId === v1AuthzId);
    expect(authzStill).toEqual(ctx.authz);
    expect(authzStill?.planHash).toBe(v1Hash);

    const readiness = await ctx.stack.executionReadiness.assess(ctx.runId);
    expect(readiness.ready).toBe(false);

    const approval = await ctx.stack.approvalRequests.getById(
      ctx.approvalRequestId,
    );
    expect(approval?.status).toBe("APPROVED");

    const oldFence = await ctx.stack.executionCoordinator.get(ctx.fenceKey);
    expect(oldFence?.status).toBe("FAILED");
    expect(oldFence?.failureCode).toBe("EXECUTION_ARGUMENT_INVALID");

    const again = await ctx.repair.repairApprovedPlan({
      runId: ctx.runId,
      reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
    });
    expect(again.outcome).toBe("ALREADY_REPAIRED");
    if (again.outcome === "ALREADY_REPAIRED") {
      expect(again.repairedPlanId).toBe(result.repairedPlanId);
    }

    const concurrent = await Promise.all([
      ctx.repair.repairApprovedPlan({
        runId: ctx.runId,
        reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
      }),
      ctx.repair.repairApprovedPlan({
        runId: ctx.runId,
        reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
      }),
    ]);
    expect(
      concurrent.every(
        (r) =>
          r.outcome === "ALREADY_REPAIRED" &&
          r.repairedPlanId === result.repairedPlanId,
      ),
    ).toBe(true);

    expect(ctx.product.messaging.sent).toHaveLength(0);
    expect(executionFenceKey(ctx.fenceKey)).toContain(v1Hash);
  });

  it("denies repair when ExecutionAttempt already exists", async () => {
    const ctx = await approvedBrokenRecoveryRun();
    await ctx.stack.executionAttempts.save({
      executionAttemptId: "att_block",
      runId: ctx.runId,
      planId: ctx.brokenPlan.planId,
      planVersion: ctx.brokenPlan.planVersion,
      planHash: ctx.brokenPlan.planHash,
      authorizationRecordId: ctx.authz.authorizationRecordId,
      attemptNumber: 1,
      startedAt: MONDAY,
      status: "FAILED",
    });
    await expect(
      ctx.repair.repairApprovedPlan({
        runId: ctx.runId,
        reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
      }),
    ).rejects.toMatchObject({ code: "REPAIR_NOT_ELIGIBLE" });
  });

  it("API refuses caller-supplied targetIds", async () => {
    const ctx = await approvedBrokenRecoveryRun();
    const app = await buildServer({
      approvedPlanRepair: ctx.repair,
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/runs/${ctx.runId}/repair-approved-plan`,
      payload: {
        reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
        targetIds: ["rr_case:x"],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("REPAIR_SEMANTIC_CHANGE_DENIED");
    await app.close();
  });

  it("scheduler cannot execute after repair leaves APPROVED", async () => {
    const ctx = await approvedBrokenRecoveryRun();
    await ctx.repair.repairApprovedPlan({
      runId: ctx.runId,
      reason: "UNEXECUTABLE_RECOVERY_TARGET_BINDING",
    });
    const run = await ctx.stack.runs.getById(ctx.runId);
    expect(run?.state).toBe("VALIDATING");
    await expect(ctx.stack.execution.execute(ctx.runId)).rejects.toMatchObject({
      code: "EXECUTION_NOT_READY",
    });
    expect(ctx.product.messaging.sent).toHaveLength(0);
  });
});
