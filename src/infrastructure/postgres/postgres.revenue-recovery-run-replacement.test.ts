/**
 * Durable governed same-objective run replacement.
 *
 * Production Postgres atomicity is authoritative. A thrown audit append rolls
 * the replacement, supersession, case pointer, and lineage back together.
 * No OpenAI or Resend calls.
 */
import { describe, expect, it } from "vitest";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import { PROJECT_RUN_REPLACEMENT_ADMITTED } from "../../admission/event-store.js";
import { commitRunTransition } from "../../admission/run-transition.js";
import { objectiveIdempotencyKey } from "../../domain/objective/idempotency.js";
import { runReplacementIdempotencyKey } from "../../domain/run/replacement-identity.js";
import { isDurabilityError } from "../../durability/errors.js";
import { UuidAdmissionIdentityGenerator } from "../admission/identity.js";
import {
  PostgresIdempotencyStore,
  PostgresProjectLockService,
} from "./repositories/admission.js";
import { PostgresPlanningUsageLedger } from "./repositories/phase-stores.js";
import { PostgresLeaseStore } from "./leases.js";
import { PostgresPlanningCoordinator } from "./coordinators.js";
import {
  PostgresExecutionAttemptRepository,
  PostgresPlanRepository,
} from "./repositories/phase-stores.js";
import {
  PostgresProductAuditRepository,
  PostgresRecoveryAttemptRepository,
  PostgresRecoveryCaseRepository,
} from "./repositories/revenue-recovery.js";
import { RevenueRecoveryError } from "../../revenue-recovery/errors.js";
import { RecoveryRunReplacementService } from "../../revenue-recovery/run-replacement.js";
import { EXAMPLE_BUDGET } from "../../control-plane/fixtures.js";
import {
  createRrPostgresEnv,
  EXAMPLE_ENVIRONMENT,
  rrConfigFor,
  rrLeadFor,
  type RrPostgresEnv,
} from "./postgres.revenue-recovery.helpers.js";

const REASON = "SYSTEM_DEFECT_RETRY";

async function objectiveV2PlanningCase(label: string) {
  const env = await createRrPostgresEnv({
    label,
    withRecoverySmsPlan: false,
    withRecoveryEmailPlan: false,
  });
  const rr = env.stack.revenueRecoveryService;
  await rr.putConfiguration(rrConfigFor(env.ids, { cooldownMinutes: 0 }));
  const { lead } = await rr.ingestLead(rrLeadFor(env.ids));
  const opened = await rr.detectAndOpenRecoveryCase({
    leadId: lead.leadId,
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
  });
  if (!opened.recoveryCase) throw new Error("expected recovery case");
  const cases = new PostgresRecoveryCaseRepository(env.db);
  const recoveryCaseId = opened.recoveryCase.recoveryCaseId;
  await cases.save({
    ...opened.recoveryCase,
    recoveryObjectiveVersion: 2,
    recordRevision: opened.recoveryCase.recordRevision + 1,
    updatedAt: env.clock.nowIso(),
  });
  await rr.prepareRecoveryObjective({
    recoveryCaseId,
    requesterId: EXAMPLE_REQUESTER_ID,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    admit: true,
  });
  const bound = await cases.getById(recoveryCaseId);
  const runId = bound?.orchestratorRunId;
  if (!runId) throw new Error("expected bound run");
  let run = await env.stack.runs.getById(runId);
  if (!run) throw new Error("missing run");
  run = await commitRunTransition(env.stack.runs, run, "INGESTING", env.clock.nowIso());
  await commitRunTransition(env.stack.runs, run, "PLANNING", env.clock.nowIso());
  const objectiveId = `obj_rr_${recoveryCaseId}`;
  return { env, rr, cases, recoveryCaseId, runId, objectiveId, leadId: lead.leadId };
}

async function seedTokenExhaustion(env: RrPostgresEnv, runId: string) {
  const usage = new PostgresPlanningUsageLedger(env.db);
  const now = env.clock.nowIso();
  for (const [index, operation] of (
    ["GAP_ANALYSIS", "PLAN_PROPOSAL"] as const
  ).entries()) {
    const reserved = await usage.reserve({
      callId: `${runId}_${operation}`,
      runId,
      planningAttempt: 1,
      operation,
      provider: "fake",
      model: "fake",
      reservedTokens: 100,
      startedAt: now,
      maximumLlmCalls: EXAMPLE_BUDGET.maximumLlmCalls,
      maximumTotalTokens: EXAMPLE_BUDGET.maximumTotalTokens,
      budgetProfileId: EXAMPLE_BUDGET.budgetProfileId,
    });
    await usage.settle(reserved.callId, {
      outcome: "SUCCESS",
      completedAt: now,
      charging: "ACTUAL",
      totalUsage: 100_000,
      inputUsage: 50,
      outputUsage: 99_950,
    });
    void index;
  }
  const fence = {
    runId,
    status: "FAILED",
    attempt: 1,
    lastUpdatedAt: now,
    failureCode: "PLANNING_MODEL_BUDGET_EXCEEDED",
    failedAt: now,
    retryable: true,
  };
  await env.db.query(
    `INSERT INTO coordinator_fences (
       coordination_key, phase, run_id, fence_token, owner_id, owner_token, status, payload
     ) VALUES ($1, 'planning', $2, 1, 'rr-replacement-test', 'token', 'FAILED', $3::jsonb)`,
    [`planning:${runId}`, runId, JSON.stringify(fence)],
  );
}

function bodyFor(env: RrPostgresEnv) {
  return {
    customerAccountId: env.ids.customerAccountId,
    projectId: env.ids.projectId,
    reason: REASON,
  };
}

describe("Postgres — governed run replacement", () => {
  it("keeps ordinary admission on attempt 1 and allows a second attempt column", async () => {
    const t = await objectiveV2PlanningCase("rr_attempt_schema");
    try {
      const original = await t.env.stack.runs.getById(t.runId);
      expect(original?.runAttempt).toBe(1);
      expect(original?.idempotencyKey).toBe(
        objectiveIdempotencyKey({
          projectId: t.env.ids.projectId,
          objectiveId: t.objectiveId,
          objectiveVersion: 2,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
        }),
      );
      const objective = await t.env.stack.objectives.getByRunBinding(t.runId);
      const duplicate = await t.env.stack.admission.admit({
        objectiveId: objective!.objectiveId,
        objectiveVersion: objective!.objectiveVersion,
        projectId: objective!.projectId,
        requestedOutcome: objective!.requestedOutcome,
        acceptanceCriteria: [...objective!.acceptanceCriteria],
        nonGoals: [...objective!.nonGoals],
        constraints: [...objective!.constraints],
        priority: objective!.priority,
        requesterId: objective!.requesterId,
        requestedEnvironment: original!.requestedEnvironment,
        submittedAt: t.env.clock.nowIso(),
        ...(objective!.deadline !== undefined
          ? { deadline: objective!.deadline }
          : {}),
      });
      expect(duplicate.outcome).toBe("ACTIVE_DUPLICATE");
      if (duplicate.outcome === "ACTIVE_DUPLICATE") {
        expect(duplicate.runId).toBe(t.runId);
      }

      await t.env.stack.runs.create({
        ...original!,
        runId: `run_schema_attempt_2_${t.runId}`,
        runAttempt: 2,
        idempotencyKey: `schema-attempt-2-${t.runId}`,
        state: "ADMITTED",
        recordRevision: 1,
      });
      await expect(
        t.env.stack.runs.create({
          ...original!,
          runId: `run_schema_attempt_2b_${t.runId}`,
          runAttempt: 2,
          idempotencyKey: `schema-attempt-2b-${t.runId}`,
          state: "ADMITTED",
          recordRevision: 1,
        }),
      ).rejects.toSatisfy((error: unknown) => {
        expect(isDurabilityError(error)).toBe(true);
        expect(error).toMatchObject({ code: "DURABLE_CONFLICT" });
        return true;
      });

      await t.env.db.query(
        `UPDATE runs SET payload = payload - 'runAttempt' WHERE run_id = $1`,
        [t.runId],
      );
      expect((await t.env.stack.runs.getById(t.runId))?.runAttempt).toBe(1);
      await t.env.db.query(
        `UPDATE runs SET payload = jsonb_set(payload, '{runAttempt}', '9'::jsonb) WHERE run_id = $1`,
        [t.runId],
      );
      await expect(t.env.stack.runs.getById(t.runId)).rejects.toMatchObject({
        code: "PERSISTED_RECORD_INVALID",
      });
    } finally {
      await t.env.close();
    }
  });

  it("supersedes the predecessor, admits attempt 2, and replays without copying authority", async () => {
    const t = await objectiveV2PlanningCase("rr_replace_happy");
    try {
      await seedTokenExhaustion(t.env, t.runId);
      const usage = new PostgresPlanningUsageLedger(t.env.db);
      const beforeUsage = await usage.listByRunId(t.runId);
      const beforeObjective = await t.env.stack.objectives.getById(t.objectiveId, 2);
      const result = await t.rr.replaceRecoveryRun({
        recoveryCaseId: t.recoveryCaseId,
        body: bodyFor(t.env),
        principalId: "operator_pg",
      });
      expect(result).toMatchObject({
        outcome: "REPLACED",
        objectiveVersion: 2,
        predecessorRunId: t.runId,
        predecessorRunAttempt: 1,
        predecessorRunState: "SUPERSEDED",
        replacementRunAttempt: 2,
        replacementRunState: "ADMITTED",
      });
      const predecessor = await t.env.stack.runs.getById(t.runId);
      const replacement = await t.env.stack.runs.getById(result.replacementRunId);
      expect(predecessor?.state).toBe("SUPERSEDED");
      expect(replacement).toMatchObject({
        state: "ADMITTED",
        runAttempt: 2,
        objectiveVersion: 2,
        objectiveId: t.objectiveId,
      });
      expect(replacement?.idempotencyKey).toBe(
        runReplacementIdempotencyKey({
          projectId: t.env.ids.projectId,
          objectiveId: t.objectiveId,
          objectiveVersion: 2,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
          predecessorRunId: t.runId,
          replacementReason: "SYSTEM_DEFECT_RETRY",
        }),
      );
      expect(await t.env.stack.objectives.getById(t.objectiveId, 2)).toEqual(
        beforeObjective,
      );
      const bound = await t.env.stack.objectives.getByRunBinding(
        result.replacementRunId,
      );
      expect(bound).toEqual(beforeObjective);
      const recoveryCase = await t.cases.getById(t.recoveryCaseId);
      expect(recoveryCase?.orchestratorRunId).toBe(result.replacementRunId);
      expect(recoveryCase?.recoveryObjectiveVersion).toBe(2);

      const plans = new PostgresPlanRepository(t.env.db);
      const attempts = new PostgresExecutionAttemptRepository(t.env.db);
      expect(await plans.listByRunId(result.replacementRunId)).toEqual([]);
      expect(
        await t.env.stack.approvalRequests.listByRun(result.replacementRunId),
      ).toEqual([]);
      expect(
        await t.env.stack.authorizationRecords.listByRun(result.replacementRunId),
      ).toEqual([]);
      expect(await attempts.listByRun(result.replacementRunId)).toEqual([]);
      expect(await usage.listByRunId(t.runId)).toEqual(beforeUsage);
      expect(await usage.listByRunId(result.replacementRunId)).toEqual([]);

      const events = await t.env.stack.events.listByRunId(result.replacementRunId);
      expect(events.map((event) => event.eventType)).toEqual([
        PROJECT_RUN_REPLACEMENT_ADMITTED,
      ]);
      const audits = new PostgresProductAuditRepository(t.env.db);
      const lineage = (await audits.listByCase(t.recoveryCaseId)).filter(
        (event) => event.kind === "RECOVERY_RUN_REPLACED",
      );
      expect(lineage).toHaveLength(1);

      const replay = await t.rr.replaceRecoveryRun({
        recoveryCaseId: t.recoveryCaseId,
        body: bodyFor(t.env),
      });
      expect(replay).toMatchObject({
        outcome: "ALREADY_REPLACED",
        replacementRunId: result.replacementRunId,
      });
      expect(
        (await audits.listByCase(t.recoveryCaseId)).filter(
          (event) => event.kind === "RECOVERY_RUN_REPLACED",
        ),
      ).toHaveLength(1);

      const current = await t.cases.getById(t.recoveryCaseId);
      await t.cases.compareAndSetOrchestratorRunBinding({
        recoveryCaseId: t.recoveryCaseId,
        expectedOrchestratorRunId: result.replacementRunId,
        expectedObjectiveVersion: 2,
        expectedRecordRevision: current!.recordRevision,
        orchestratorRunId: "run_moved_away",
        objectiveId: t.objectiveId,
        objectiveVersion: 2,
        updatedAt: t.env.clock.nowIso(),
      });
      await expect(
        t.rr.replaceRecoveryRun({
          recoveryCaseId: t.recoveryCaseId,
          body: bodyFor(t.env),
        }),
      ).rejects.toMatchObject({ code: "RUN_REPLACEMENT_LIMIT_REACHED" });
      const count = await t.env.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE objective_id = $1`,
        [t.objectiveId],
      );
      expect(count.rows[0]?.n).toBe(2);
    } finally {
      await t.env.close();
    }
  });

  it("converges concurrent replacements to one successor", async () => {
    const t = await objectiveV2PlanningCase("rr_replace_race");
    try {
      await seedTokenExhaustion(t.env, t.runId);
      const [a, b] = await Promise.all([
        t.rr.replaceRecoveryRun({
          recoveryCaseId: t.recoveryCaseId,
          body: bodyFor(t.env),
        }),
        t.rr.replaceRecoveryRun({
          recoveryCaseId: t.recoveryCaseId,
          body: bodyFor(t.env),
        }),
      ]);
      expect(a.replacementRunId).toBe(b.replacementRunId);
      const count = await t.env.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE objective_id = $1`,
        [t.objectiveId],
      );
      expect(count.rows[0]?.n).toBe(2);
      const audits = new PostgresProductAuditRepository(t.env.db);
      expect(
        (await audits.listByCase(t.recoveryCaseId)).filter(
          (event) => event.kind === "RECOVERY_RUN_REPLACED",
        ),
      ).toHaveLength(1);
      expect((await t.cases.getById(t.recoveryCaseId))?.orchestratorRunId).toBe(
        a.replacementRunId,
      );
    } finally {
      await t.env.close();
    }
  });

  it("rolls back a failed replacement so the predecessor stays current", async () => {
    const t = await objectiveV2PlanningCase("rr_replace_rollback");
    try {
      await seedTokenExhaustion(t.env, t.runId);
      const innerAudits = new PostgresProductAuditRepository(t.env.db);
      const service = new RecoveryRunReplacementService({
        nowIso: () => t.env.clock.nowIso(),
        cases: t.cases,
        attempts: new PostgresRecoveryAttemptRepository(t.env.db),
        audits: {
          listByCase: (id) => innerAudits.listByCase(id),
          append: async (event) => {
            if (event.kind === "RECOVERY_RUN_REPLACED") {
              throw new RevenueRecoveryError(
                "RUN_REPLACEMENT_CONFLICT",
                "injected audit failure",
              );
            }
            await innerAudits.append(event);
          },
        },
        identities: new UuidAdmissionIdentityGenerator(),
        withReplacementLock: (recoveryCaseId, fn) =>
          t.env.db.withTransaction(async () => {
            await t.env.db.query(
              `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
              [`rr-run-replacement:${recoveryCaseId}`],
            );
            return fn();
          }),
        orchestrator: {
          runs: t.env.stack.runs,
          objectives: t.env.stack.objectives,
          plans: new PostgresPlanRepository(t.env.db),
          approvalRequests: t.env.stack.approvalRequests,
          authorizationRecords: t.env.stack.authorizationRecords,
          executionAttempts: new PostgresExecutionAttemptRepository(t.env.db),
          planning: new PostgresPlanningCoordinator(
            t.env.db,
            new PostgresLeaseStore(t.env.db),
            "rr-replacement-rollback",
          ),
          usage: new PostgresPlanningUsageLedger(t.env.db),
          controlPlane: t.env.stack.controlPlane,
          events: t.env.stack.events,
          idempotency: new PostgresIdempotencyStore(t.env.db),
          locks: new PostgresProjectLockService(t.env.db),
        },
      });
      await expect(
        service.replace({
          recoveryCaseId: t.recoveryCaseId,
          body: bodyFor(t.env),
        }),
      ).rejects.toMatchObject({
        code: "RUN_REPLACEMENT_CONFLICT",
        message: "injected audit failure",
      });
      expect((await t.env.stack.runs.getById(t.runId))?.state).toBe("PLANNING");
      expect((await t.cases.getById(t.recoveryCaseId))?.orchestratorRunId).toBe(
        t.runId,
      );
      const count = await t.env.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM runs WHERE objective_id = $1`,
        [t.objectiveId],
      );
      expect(count.rows[0]?.n).toBe(1);
      expect(
        (await innerAudits.listByCase(t.recoveryCaseId)).filter(
          (event) => event.kind === "RECOVERY_RUN_REPLACED",
        ),
      ).toEqual([]);
      const events = await t.env.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM events
          WHERE event_type = $1 AND project_id = $2`,
        [PROJECT_RUN_REPLACEMENT_ADMITTED, t.env.ids.projectId],
      );
      expect(events.rows[0]?.n).toBe(0);
    } finally {
      await t.env.close();
    }
  });
});
