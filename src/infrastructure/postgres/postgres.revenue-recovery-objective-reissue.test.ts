/**
 * Governed Revenue Recovery objective reissue against durable Postgres.
 * Run via `npm run test:postgres` against a reachable TEST_DATABASE_URL.
 *
 * Admission, case CAS rebind, and audit share one transaction: either the
 * replacement exists and the case points at it, or nothing was committed.
 * No OpenAI/Resend calls.
 */
import { describe, expect, it } from "vitest";
import type { ObjectiveAdmissionService } from "../../admission/service.js";
import { createPostgresRevenueRecoveryService } from "../../api/revenue-recovery-factory.js";
import type { FakeApprovalDeliveryService } from "../../authorization/delivery.js";
import { RevenueRecoveryError } from "../../revenue-recovery/errors.js";
import { FakeRecoveryMessagingProvider } from "../../revenue-recovery/messaging.js";
import type { RecoveryObjectiveReissueOrchestratorPorts } from "../../revenue-recovery/objective-reissue.js";
import { RECOVERY_EMAIL_POSTCONDITION } from "../../revenue-recovery/recovery-email-planning-model.js";
import { deliveredNonce } from "./postgres-lifecycle-helpers.js";
import {
  advanceBoundRecoveryToAwaitingApproval,
  createRrPostgresEnv,
  rrAdmissionRequest,
  rrConfigFor,
  rrLeadFor,
  rrObjectiveId,
  type RrPostgresEnv,
} from "./postgres.revenue-recovery.helpers.js";
import {
  PostgresExecutionAttemptRepository,
  PostgresPlanRepository,
} from "./repositories/phase-stores.js";
import {
  PostgresProductAuditRepository,
  PostgresRecoveryCaseRepository,
} from "./repositories/revenue-recovery.js";

const REASON = "OBJECTIVE_MAPPING_CORRECTION";

async function rejectedEmailCase(label: string) {
  const env = await createRrPostgresEnv({
    label,
    withRecoverySmsPlan: false,
    withRecoveryEmailPlan: true,
  });
  const rr = env.stack.revenueRecoveryService;
  await rr.putConfiguration(
    rrConfigFor(env.ids, {
      allowedChannels: ["EMAIL"],
      maxEmailAttempts: 1,
    }),
  );
  const template = await rr.saveTemplate({
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
    channel: "EMAIL",
    version: 1,
    body: "Hi {{firstName}} — {{businessName}} can still help.",
    allowedVariables: ["firstName", "businessName"],
    enabled: true,
  });
  const { lead } = await rr.ingestLead(rrLeadFor(env.ids));
  const { recoveryCase } = await rr.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
  });
  if (!recoveryCase) throw new Error("expected open recovery case");
  Object.assign(env.emailPlanBinding, {
    recoveryCaseId: recoveryCase.recoveryCaseId,
    leadId: lead.leadId,
    templateId: template.templateId,
    templateVersion: template.version,
  });

  // Pre-fix v1 content, as the pilot objective was before the mapping fix.
  const { runId, approvalRequestId } =
    await advanceBoundRecoveryToAwaitingApproval(
      env,
      {
        ...rrAdmissionRequest({
          label,
          projectId: env.ids.projectId,
          recoveryCaseId: recoveryCase.recoveryCaseId,
        }),
        acceptanceCriteria: [RECOVERY_EMAIL_POSTCONDITION],
        constraints: ["Allowed channels: SMS,EMAIL,CALL_TASK", "Max SMS attempts: 3"],
      },
      recoveryCase.recoveryCaseId,
    );
  await env.stack.humanAuthorization.decide({
    approvalRequestId,
    approverId: "approver_bootstrap",
    decision: "REJECT",
    submittedAt: env.clock.nowIso(),
    decisionNonce: deliveredNonce(
      env.stack.approvalDelivery as FakeApprovalDeliveryService,
      approvalRequestId,
    ),
  });

  const recoveryCaseId = recoveryCase.recoveryCaseId;
  const objectiveId = rrObjectiveId(recoveryCaseId);
  const cases = new PostgresRecoveryCaseRepository(env.db);
  const audits = new PostgresProductAuditRepository(env.db);
  const body = {
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
    reason: REASON,
  };
  return {
    env,
    rr,
    runId,
    approvalRequestId,
    recoveryCaseId,
    objectiveId,
    cases,
    body,
    reissueAudits: async () =>
      (await audits.listByCase(recoveryCaseId)).filter(
        (e) => e.kind === "RECOVERY_OBJECTIVE_REISSUED",
      ),
    runCountAt: async (objectiveVersion: number) => {
      const result = await env.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs
          WHERE project_id = $1 AND objective_id = $2 AND objective_version = $3`,
        [env.ids.projectId, objectiveId, objectiveVersion],
      );
      return result.rows[0]!.n;
    },
  };
}

function orchestratorPorts(env: RrPostgresEnv): RecoveryObjectiveReissueOrchestratorPorts {
  return {
    runs: env.stack.runs,
    objectives: env.stack.objectives,
    plans: new PostgresPlanRepository(env.db),
    approvalRequests: env.stack.approvalRequests,
    authorizationRecords: env.stack.authorizationRecords,
    executionAttempts: new PostgresExecutionAttemptRepository(env.db),
  };
}

describe("Postgres — Revenue Recovery objective reissue", () => {
  it("commits objective v2, replacement run, case CAS, and audit together; replays idempotently", async () => {
    const t = await rejectedEmailCase("reissue_atomic");
    try {
      const approvalBefore = await t.env.stack.approvalRequests.getById(
        t.approvalRequestId,
      );
      const recordsBefore = await t.env.stack.authorizationRecords.listByRun(t.runId);
      const caseBefore = (await t.cases.getById(t.recoveryCaseId))!;

      const result = await t.rr.reissueRecoveryObjective({
        recoveryCaseId: t.recoveryCaseId,
        body: t.body,
        principalId: "operator_pg_test",
      });

      expect(result).toMatchObject({
        outcome: "REISSUED",
        sourceObjectiveVersion: 1,
        targetObjectiveVersion: 2,
        predecessorRunId: t.runId,
        replacementRunState: "ADMITTED",
      });
      const v2 = await t.env.stack.objectives.getByRunBinding(
        result.replacementRunId,
      );
      expect(v2!.objectiveVersion).toBe(2);
      expect(v2!.constraints).toContain("Allowed channels: EMAIL");
      expect(v2!.constraints).toContain("Max email attempts: 1");
      expect(v2!.constraints.some((c) => /\bSMS\b/.test(c))).toBe(false);

      const caseAfter = (await t.cases.getById(t.recoveryCaseId))!;
      expect(caseAfter).toMatchObject({
        orchestratorRunId: result.replacementRunId,
        recoveryObjectiveVersion: 2,
        recordRevision: caseBefore.recordRevision + 1,
      });
      expect((await t.env.stack.runs.getById(t.runId))!.state).toBe("REJECTED");
      expect(
        await t.env.stack.approvalRequests.getById(t.approvalRequestId),
      ).toEqual(approvalBefore);
      expect(await t.env.stack.authorizationRecords.listByRun(t.runId)).toEqual(
        recordsBefore,
      );
      expect(await t.reissueAudits()).toHaveLength(1);

      const replay = await t.rr.reissueRecoveryObjective({
        recoveryCaseId: t.recoveryCaseId,
        body: t.body,
      });
      expect(replay).toEqual({ ...result, outcome: "ALREADY_REISSUED" });
      expect(await t.cases.getById(t.recoveryCaseId)).toEqual(caseAfter);
      expect(await t.reissueAudits()).toHaveLength(1);
      expect(await t.runCountAt(2)).toBe(1);
    } finally {
      await t.env.close();
    }
  });

  it("concurrent reissues produce exactly one objective v2, one run, one pointer move", async () => {
    const t = await rejectedEmailCase("reissue_concurrent");
    try {
      const revisionBefore = (await t.cases.getById(t.recoveryCaseId))!
        .recordRevision;
      const results = await Promise.all(
        [0, 1, 2].map(() =>
          t.rr.reissueRecoveryObjective({
            recoveryCaseId: t.recoveryCaseId,
            body: t.body,
          }),
        ),
      );
      expect(results.map((r) => r.outcome).sort()).toEqual([
        "ALREADY_REISSUED",
        "ALREADY_REISSUED",
        "REISSUED",
      ]);
      expect(new Set(results.map((r) => r.replacementRunId)).size).toBe(1);
      expect(await t.runCountAt(2)).toBe(1);
      expect(await t.reissueAudits()).toHaveLength(1);
      expect((await t.cases.getById(t.recoveryCaseId))!.recordRevision).toBe(
        revisionBefore + 1,
      );
    } finally {
      await t.env.close();
    }
  });

  it("a failure after admission rolls back the run and objective: no orphan, no pointer move", async () => {
    const t = await rejectedEmailCase("reissue_rollback");
    try {
      const failing = createPostgresRevenueRecoveryService({
        db: t.env.db,
        nowIso: () => t.env.clock.nowIso(),
        runtimeEnvironment: "TEST",
        pilotConfig: { mode: "FAKE", livePilotRecipientAllowlist: [] },
        messaging: new FakeRecoveryMessagingProvider(),
        orchestrator: orchestratorPorts(t.env),
        admission: {
          admit: async (input: unknown) => {
            const admitted = await t.env.stack.admission.admit(input);
            expect(admitted.outcome).toBe("ADMITTED");
            throw new RevenueRecoveryError(
              "RECOVERY_STATE_CONFLICT",
              "injected failure after admission",
            );
          },
        } as unknown as ObjectiveAdmissionService,
      }).service;
      const caseBefore = await t.cases.getById(t.recoveryCaseId);

      await expect(
        failing.reissueRecoveryObjective({
          recoveryCaseId: t.recoveryCaseId,
          body: t.body,
        }),
      ).rejects.toMatchObject({
        code: "RECOVERY_STATE_CONFLICT",
        message: "injected failure after admission",
      });

      expect(await t.cases.getById(t.recoveryCaseId)).toEqual(caseBefore);
      expect(await t.env.stack.objectives.getById(t.objectiveId, 2)).toBeNull();
      expect(await t.runCountAt(2)).toBe(0);
      expect(await t.reissueAudits()).toEqual([]);

      // Idempotency reservation rolled back too: the retry admits fresh.
      const retried = await t.rr.reissueRecoveryObjective({
        recoveryCaseId: t.recoveryCaseId,
        body: t.body,
      });
      expect(retried.outcome).toBe("REISSUED");
      expect((await t.reissueAudits())[0]!.payload).toMatchObject({
        admissionOutcome: "ADMITTED",
      });
      expect(await t.runCountAt(2)).toBe(1);
    } finally {
      await t.env.close();
    }
  });

  it("a stale case revision fails the durable CAS and the optimistic save", async () => {
    const t = await rejectedEmailCase("reissue_cas");
    try {
      const current = (await t.cases.getById(t.recoveryCaseId))!;
      const swap = {
        recoveryCaseId: t.recoveryCaseId,
        expectedOrchestratorRunId: t.runId,
        expectedObjectiveVersion: 1,
        expectedRecordRevision: current.recordRevision,
        orchestratorRunId: "run_pg_cas_next",
        objectiveId: t.objectiveId,
        objectiveVersion: 2,
        updatedAt: t.env.clock.nowIso(),
      };
      expect(
        await t.cases.compareAndSetOrchestratorRunBinding({
          ...swap,
          expectedRecordRevision: current.recordRevision - 1,
        }),
      ).toBeNull();
      expect(
        await t.cases.compareAndSetOrchestratorRunBinding({
          ...swap,
          expectedOrchestratorRunId: "run_other",
        }),
      ).toBeNull();
      expect(
        await t.cases.compareAndSetOrchestratorRunBinding({
          ...swap,
          expectedObjectiveVersion: 2,
        }),
      ).toBeNull();
      expect(await t.cases.getById(t.recoveryCaseId)).toEqual(current);
      await expect(
        t.cases.save({ ...current, recordRevision: current.recordRevision + 5 }),
      ).rejects.toMatchObject({ code: "RECOVERY_CAS_CONFLICT" });
      expect(await t.cases.getById(t.recoveryCaseId)).toEqual(current);
    } finally {
      await t.env.close();
    }
  });
});
