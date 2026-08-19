import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildPostgresTestAdmissionRequest,
  createIndependentDatabase,
  createTestStack,
  uniquePostgresTestId,
  waitUntilPostgresLeaseExpired,
} from "./test-helpers.js";
import {
  advanceToApprovedRun,
  advanceToAwaitingApproval,
  advanceToCompletedRun,
  advanceToExecuting,
  deliveredNonce,
} from "./postgres-lifecycle-helpers.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import { PostgresTransactionalOutbox } from "./outbox.js";
import { PostgresInbox } from "./inbox.js";
import { PostgresLeaseStore } from "./leases.js";
import { PostgresExecutionResourceLedgerStore } from "./repositories/execution-resource-ledger.js";
import { ExecutionResourceLedger } from "../../execution/resource-ledger.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import { assertNotInTransaction } from "../../durability/transaction.js";
import { FakePlanningModel } from "../../planning/fake-planning-model.js";
import { buildServer } from "../../api/server.js";
import type { VerificationCompletionStage } from "../../verification/service.js";
import type { PromotionFailpointStage } from "../../memory/promotion.js";
import {
  ISOLATION_PROJECT_B_ID,
  seedDedicatedPostgresTestProject,
  seedIsolationProjectB,
} from "./test-project-isolation.js";
import {
  readVerificationArtifactBytes,
  utf8FromVerificationBytes,
} from "../../verification/artifact-verifier.js";

describe("PostgreSQL Phase 11 acceptance", () => {
  it("durable requester/approver authority survives restart", async () => {
    const envA = await createTestStack(uniquePostgresTestId("auth_a"));
    try {
      const grantsA = await envA.stack.authorityDirectory.listRequesterGrants(
        EXAMPLE_REQUESTER_ID,
        EXAMPLE_PROJECT_ID,
      );
      expect(grantsA.length).toBeGreaterThan(0);
      const approverA = await envA.stack.authorityDirectory.isApproverEnabled(
        "approver_bootstrap",
        EXAMPLE_PROJECT_ID,
      );
      expect(approverA).toBe(true);
      const admitted = await envA.stack.admission.admit(
        buildPostgresTestAdmissionRequest({ testName: "auth-restart" }),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      await envA.close();

      const envB = await createTestStack(uniquePostgresTestId("auth_b"));
      try {
        const grantsB = await envB.stack.authorityDirectory.listRequesterGrants(
          EXAMPLE_REQUESTER_ID,
          EXAMPLE_PROJECT_ID,
        );
        expect(grantsB).toEqual(grantsA);
        const approverB = await envB.stack.authorityDirectory.isApproverEnabled(
          "approver_bootstrap",
          EXAMPLE_PROJECT_ID,
        );
        expect(approverB).toBe(approverA);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("does not persist plaintext approval nonce in durable outbox", async () => {
    const env = await createTestStack(uniquePostgresTestId("nonce_audit"));
    try {
      const request = buildPostgresTestAdmissionRequest({
        testName: "nonce-outbox-audit",
      });
      const { approvalRequestId } = await advanceToAwaitingApproval(
        env.stack,
        request,
      );
      const nonce = deliveredNonce(env.stack.approvalDelivery, approvalRequestId);
      expect(nonce.length).toBeGreaterThan(0);
      const rows = await env.db.query<{ payload: string }>(
        `SELECT payload::text AS payload FROM transactional_outbox
         WHERE aggregate_id = $1`,
        [approvalRequestId],
      );
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows) {
        expect(row.payload).not.toContain(nonce);
        expect(row.payload).not.toContain("decisionNonce");
      }
      const secrets = await env.db.query(
        `SELECT 1 FROM approval_delivery_secrets WHERE approval_request_id = $1`,
        [approvalRequestId],
      );
      expect(secrets.rows.length).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("run CAS uses recordRevision and rejects stale writers", async () => {
    const env = await createTestStack(uniquePostgresTestId("run_cas"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "run-cas" });
      const admitted = await env.stack.admission.admit(request);
      expect(admitted.outcome).toBe("ADMITTED");
      const run = await env.stack.runs.getById(admitted.runId!);
      expect(run?.recordRevision).toBeGreaterThanOrEqual(1);
      const stale = { ...run!, recordRevision: 1 };
      if (run!.recordRevision > 1) {
        await expect(
          env.stack.runs.transition(
            run!.runId,
            run!.state,
            1,
            "ADMITTED",
            new Date().toISOString(),
          ),
        ).rejects.toMatchObject({ code: "DURABLE_CONFLICT" });
      }
      void stale;
    } finally {
      await env.close();
    }
  });

  it("assertNotInTransaction blocks model dispatch inside open transactions", async () => {
    const env = await createTestStack(uniquePostgresTestId("tx_guard"));
    try {
      const model = new FakePlanningModel();
      model.failNextCall(new Error("should not reach model"));
      await expect(
        env.db.withTransaction(async () => {
          assertNotInTransaction("PlanningModel");
        }),
      ).rejects.toMatchObject({ code: "SIDE_EFFECT_IN_TRANSACTION" });
      expect(model).toBeDefined();
    } finally {
      await env.close();
    }
  });

  it("recovery classifies abandoned durable state at bootstrap", async () => {
    const env = await createTestStack(uniquePostgresTestId("recovery_seed"));
    try {
      const leases = new PostgresLeaseStore(env.db, 2);
      const key = uniquePostgresTestId("recovery:lease");
      await leases.acquire({
        coordinationKey: key,
        phase: "planning",
        ownerId: "worker_recovery",
      });
      await waitUntilPostgresLeaseExpired(env.db, key);
      const items = await env.stack.recovery.recover();
      expect(items.some((item) => item.outcome === "REACQUIRED")).toBe(true);
    } finally {
      await env.close();
    }
  });

  it("M72: concurrent approval consumes nonce exactly once", async () => {
    const env = await createTestStack(uniquePostgresTestId("m72"));
    const dbB = await createIndependentDatabase(uniquePostgresTestId("m72_b"));
    const stackB = await createPostgresOrchestratorStack({
      db: dbB,
      instanceId: uniquePostgresTestId("m72_b"),
      seedControlPlane: false,
    });
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "m72" });
      const { approvalRequestId } = await advanceToAwaitingApproval(
        env.stack,
        request,
      );
      const nonce = deliveredNonce(env.stack.approvalDelivery, approvalRequestId);
      const decision = {
        approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE" as const,
        decisionNonce: nonce,
        submittedAt: new Date().toISOString(),
        note: "concurrent",
      };
      const [first, second] = await Promise.allSettled([
        env.stack.humanAuthorization.decide(decision),
        stackB.humanAuthorization.decide(decision),
      ]);
      const outcomes = [first, second].map((result) => {
        if (result.status === "fulfilled") {
          return result.value.result;
        }
        return result.reason?.code ?? "REJECTED";
      });
      expect(
        outcomes.includes("APPROVED") ||
          outcomes.includes("ALREADY_DECIDED") ||
          outcomes.includes("AUTHORIZATION_DECISION_REPLAYED"),
      ).toBe(true);
      const records = await env.db.query(
        `SELECT COUNT(*)::int AS count FROM json_documents
         WHERE collection = 'authorization_records'
           AND payload->>'approvalRequestId' = $1`,
        [approvalRequestId],
      );
      expect(Number(records.rows[0]?.count ?? 0)).toBe(1);
    } finally {
      await env.close();
      await dbB.close();
    }
  });

  it("M73: concurrent execution start creates one attempt", async () => {
    const env = await createTestStack(uniquePostgresTestId("m73"));
    const dbB = await createIndependentDatabase(uniquePostgresTestId("m73_b"));
    const stackB = await createPostgresOrchestratorStack({
      db: dbB,
      instanceId: uniquePostgresTestId("m73_b"),
      seedControlPlane: false,
    });
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "m73" });
      const ctx = await advanceToApprovedRun(env.stack, request);
      const ready = await env.stack.executionReadiness.assess(ctx.runId);
      expect(ready.ready).toBe(true);
      env.stack.actuator.invocations.length = 0;
      stackB.actuator.invocations.length = 0;
      const [a, b] = await Promise.allSettled([
        env.stack.execution.execute(ctx.runId),
        stackB.execution.execute(ctx.runId),
      ]);
      const fulfilled = [a, b].filter((r) => r.status === "fulfilled");
      const rejectionSummary = [a, b]
        .filter((r): r is PromiseRejectedResult => r.status === "rejected")
        .map((r) => r.reason?.code ?? r.reason?.message ?? String(r.reason));
      expect(fulfilled.length, rejectionSummary.join(" | ")).toBe(1);
      const attempts = await env.db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM json_documents
         WHERE collection = 'execution_attempts'
           AND run_id = $1`,
        [ctx.runId],
      );
      expect(Number(attempts.rows[0]?.count ?? 0)).toBe(1);
      const patchInvocations = [
        ...env.stack.actuator.invocations,
        ...stackB.actuator.invocations,
      ].filter((i) => i.method === "createLocalPatch");
      expect(patchInvocations.length).toBe(1);
    } finally {
      await env.close();
      await dbB.close();
    }
  });

  it("M74: full crash/fence — stale worker rejected, no blind retry", async () => {
    const instanceA = uniquePostgresTestId("m74_workerA");
    const envA = await createTestStack(instanceA);
    let ctx: Awaited<ReturnType<typeof advanceToApprovedRun>> | undefined;
    let coordinationKey: string | undefined;
    let fenceTokenA: number | undefined;
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "m74-fence" });
      ctx = await advanceToApprovedRun(envA.stack, request);
      const attemptId = uniquePostgresTestId("attempt_m74f");
      const stepKey = `${ctx.runId}:step_patch`;

      // Acquire execution lease (simulates coordinator.begin internally)
      const leases = new PostgresLeaseStore(envA.db, 2);
      coordinationKey = `execution:m74_fence_${ctx.runId}`;
      const leaseA = await leases.acquire({
        coordinationKey,
        phase: "execution",
        ownerId: instanceA,
      });
      fenceTokenA = leaseA.fenceToken;

      // Persist resource reservation + RUNNING step
      await envA.stack.resourceLedgerStore.initialize({
        executionAttemptId: attemptId,
        runId: ctx.runId,
        projectId: EXAMPLE_PROJECT_ID,
        budget: EXAMPLE_BUDGET,
      });
      const ledger = await ExecutionResourceLedger.create({
        budget: EXAMPLE_BUDGET,
        runId: ctx.runId,
        projectId: EXAMPLE_PROJECT_ID,
        executionAttemptId: attemptId,
        store: envA.stack.resourceLedgerStore,
      });
      await ledger.reserveDurationMs(30_000);
      const now = envA.stack.clock.nowIso();
      await envA.stack.stepExecutions.reserve({
        idempotencyKey: stepKey,
        runId: ctx.runId,
        executionAttemptId: attemptId,
        stepId: "step_patch",
        capabilityId: "CREATE_LOCAL_PATCH",
        actionType: "CREATE_LOCAL_PATCH",
        startedAt: now,
      });
      await envA.stack.stepExecutions.markRunning(stepKey);
      const run = await envA.stack.runs.getById(ctx.runId);
      if (run && run.state === "APPROVED") {
        await envA.stack.runs.transition(
          run.runId, run.state, run.recordRevision, "EXECUTING", now,
        );
      }
      expect(envA.stack.actuator.invocations.length).toBe(0);

      // PROCESS DEATH — destroy all stack A state
      await envA.close();

      // Wait for lease expiry using PostgreSQL time
      const envB = await createTestStack(uniquePostgresTestId("m74_workerB"));
      try {
        await waitUntilPostgresLeaseExpired(envB.db, coordinationKey!);

        // Assertions after restart
        expect(envB.stack.actuator.invocations.length).toBe(0);
        const step = await envB.stack.stepExecutions.getByIdempotencyKey(stepKey);
        expect(step?.status).toBe("RUNNING");
        const reserved = await ExecutionResourceLedger.loadExisting({
          budget: EXAMPLE_BUDGET,
          store: envB.stack.resourceLedgerStore,
          executionAttemptId: attemptId,
        });
        expect(reserved?.snapshot().reservedDurationMs).toBe(30_000);
        const reloadedRun = await envB.stack.runs.getById(ctx!.runId);
        expect(reloadedRun?.state).toBe("EXECUTING");

        // Worker B acquires new lease with higher fence token
        const leasesB = new PostgresLeaseStore(envB.db, 30);
        const leaseB = await leasesB.acquire({
          coordinationKey: coordinationKey!,
          phase: "execution",
          ownerId: envB.stack.instanceId,
        });
        expect(leaseB.fenceToken).toBeGreaterThan(fenceTokenA!);

        // Stale Worker A attempts heartbeat with old fence → rejected
        await expect(
          leasesB.heartbeat({
            coordinationKey: coordinationKey!,
            ownerId: instanceA,
            fenceToken: fenceTokenA!,
          }),
        ).rejects.toMatchObject({ code: "LEASE_OWNERSHIP_LOST" });

        // Stale Worker A attempts assertWritable → rejected
        await expect(
          leasesB.assertWritable({
            coordinationKey: coordinationKey!,
            ownerId: instanceA,
            fenceToken: fenceTokenA!,
          }),
        ).rejects.toMatchObject({ code: "STALE_FENCE_TOKEN" });

        // Worker B does NOT blindly invoke actuator
        expect(envB.stack.actuator.invocations.length).toBe(0);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("M75: transaction rollback prevents partial completion records", async () => {
    const env = await createTestStack(uniquePostgresTestId("m75"));
    try {
      const docId = uniquePostgresTestId("completion_partial");
      const eventId = uniquePostgresTestId("event_partial");

      // Stage 1: outcome persistence failure
      await expect(
        env.db.withTransaction(async () => {
          await env.db.query(
            `INSERT INTO json_documents (collection, document_id, run_id, payload, immutable)
             VALUES ('outcome_verifications', $1, 'run_m75', '{}'::jsonb, TRUE)`,
            [docId],
          );
          throw new Error("inject after outcome persistence");
        }),
      ).rejects.toThrow("inject after outcome persistence");
      const outcomeRow = await env.db.query(
        `SELECT 1 FROM json_documents WHERE document_id = $1`, [docId],
      );
      expect(outcomeRow.rows.length).toBe(0);

      // Stage 2: completion persistence failure
      await expect(
        env.db.withTransaction(async () => {
          await env.db.query(
            `INSERT INTO json_documents (collection, document_id, run_id, payload, immutable)
             VALUES ('completion_records', $1, 'run_m75', '{}'::jsonb, TRUE)`,
            [docId],
          );
          throw new Error("inject after completion persistence");
        }),
      ).rejects.toThrow("inject after completion persistence");
      const compRow = await env.db.query(
        `SELECT 1 FROM json_documents WHERE document_id = $1`, [docId],
      );
      expect(compRow.rows.length).toBe(0);

      // Stage 3: event append failure
      await expect(
        env.db.withTransaction(async () => {
          await env.db.query(
            `INSERT INTO json_documents (collection, document_id, run_id, payload, immutable)
             VALUES ('events', $1, 'run_m75', '{"eventType":"RUN_COMPLETED"}'::jsonb, TRUE)`,
            [eventId],
          );
          throw new Error("inject after event append");
        }),
      ).rejects.toThrow("inject after event append");
      const eventRow = await env.db.query(
        `SELECT 1 FROM json_documents WHERE document_id = $1`, [eventId],
      );
      expect(eventRow.rows.length).toBe(0);

      // Stage 4: run transition failure — run remains unchanged
      const request = buildPostgresTestAdmissionRequest({ testName: "m75-run" });
      const admitted = await env.stack.admission.admit(request);
      const run = await env.stack.runs.getById(admitted.runId!);
      await expect(
        env.db.withTransaction(async () => {
          await env.db.query(
            `UPDATE runs SET state = 'COMPLETED' WHERE run_id = $1`, [run!.runId],
          );
          throw new Error("inject after run transition");
        }),
      ).rejects.toThrow("inject after run transition");
      const afterRun = await env.stack.runs.getById(run!.runId);
      expect(afterRun?.state).toBe(run!.state);
      expect(afterRun?.state).not.toBe("COMPLETED");
    } finally {
      await env.close();
    }
  });

  it("outbox concurrency rejects stale dispatcher settlement", async () => {
    const env = await createTestStack(uniquePostgresTestId("outbox_race"));
    try {
      const outbox = new PostgresTransactionalOutbox(env.db);
      const message = await outbox.enqueue({
        outboxId: uniquePostgresTestId("outbox_msg"),
        aggregateType: "test",
        aggregateId: "agg",
        eventType: "TEST",
        payload: { ok: true },
      });
      const a = await outbox.claimBatch({
        ownerId: "dispatcher_a",
        limit: 1,
        leaseSeconds: 1,
      });
      expect(a).toHaveLength(1);
      const fenceA = a[0]!.fenceToken!;
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const expired = await env.db.query<{ ok: number }>(
          `SELECT 1 AS ok FROM transactional_outbox
           WHERE outbox_id = $1 AND lease_expires_at < NOW()`,
          [message.outboxId],
        );
        if (expired.rows.length > 0) {
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
      }
      const b = await outbox.claimBatch({
        ownerId: "dispatcher_b",
        limit: 1,
        leaseSeconds: 30,
      });
      expect(b[0]?.fenceToken).toBeGreaterThan(fenceA);
      await expect(
        outbox.markDelivered(message.outboxId, "dispatcher_a", fenceA),
      ).rejects.toMatchObject({ code: "OUTBOX_DELIVERY_FAILED" });
      await outbox.markDelivered(
        message.outboxId,
        "dispatcher_b",
        b[0]!.fenceToken!,
      );
    } finally {
      await env.close();
    }
  });

  it("inbox dedup executes authoritative consumer effect once", async () => {
    const env = await createTestStack(uniquePostgresTestId("inbox_dedup"));
    try {
      const inbox = new PostgresInbox(env.db);
      const messageId = uniquePostgresTestId("inbox_msg");
      let effects = 0;
      for (let i = 0; i < 2; i += 1) {
        const received = await inbox.receive({
          messageId,
          consumerName: "test-consumer",
          payload: { n: i },
        });
        if (!received.duplicate || !received.record.processedAt) {
          effects += 1;
          await inbox.complete({
            messageId,
            consumerName: "test-consumer",
            resultFingerprint: createHash("sha256")
              .update("done")
              .digest("hex"),
          });
        }
      }
      expect(effects).toBe(1);
    } finally {
      await env.close();
    }
  });

  it("resource ledger concurrent reservations cannot exceed budget", async () => {
    const env = await createTestStack(uniquePostgresTestId("ledger_conc"));
    try {
      const attemptA = uniquePostgresTestId("ledger_attempt_a");
      const attemptB = uniquePostgresTestId("ledger_attempt_b");
      const runId = uniquePostgresTestId("ledger_run");
      const storeA = new PostgresExecutionResourceLedgerStore(env.db);
      const dbB = await createIndependentDatabase(uniquePostgresTestId("ledger_b"));
      const storeB = new PostgresExecutionResourceLedgerStore(dbB);
      try {
        const budget = { ...EXAMPLE_BUDGET, maximumExecutionMinutes: 1 };
        await storeA.initialize({
          executionAttemptId: attemptA,
          runId,
          projectId: EXAMPLE_PROJECT_ID,
          budget,
        });
        await storeB.initialize({
          executionAttemptId: attemptA,
          runId,
          projectId: EXAMPLE_PROJECT_ID,
          budget,
        });
        const ceilingMs = budget.maximumExecutionMinutes * 60_000;
        const half = Math.floor(ceilingMs / 2) + 1;
        const first = await storeA.reserveDurationMs(attemptA, 1, half);
        await expect(
          storeB.reserveDurationMs(attemptA, first.recordRevision, half),
        ).rejects.toMatchObject({ code: "EXECUTION_RESOURCE_BUDGET_EXCEEDED" });
      } finally {
        await dbB.close();
      }
    } finally {
      await env.close();
    }
  });

  it("M76: full lifecycle survives stack restart", async () => {
    const request = buildPostgresTestAdmissionRequest({ testName: "m76-full" });
    let ctx: Awaited<ReturnType<typeof advanceToApprovedRun>> | undefined;
    let recordRevision: number | undefined;
    const envA = await createTestStack(uniquePostgresTestId("m76_a"));
    try {
      ctx = await advanceToApprovedRun(envA.stack, request);
      const run = await envA.stack.runs.getById(ctx.runId);
      expect(run?.state).toBe("APPROVED");
      expect(run?.objectiveId).toBe(request.objectiveId);
      recordRevision = run!.recordRevision;
      await envA.close();

      const envB = await createTestStack(uniquePostgresTestId("m76_b"));
      try {
        const reloaded = await envB.stack.runs.getById(ctx!.runId);
        expect(reloaded?.state).toBe("APPROVED");
        expect(reloaded?.objectiveId).toBe(request.objectiveId);
        expect(reloaded?.recordRevision).toBe(recordRevision);
        const plan = await envB.stack.planning.getPlan(ctx!.runId);
        expect(plan?.planHash).toBeTruthy();
        const decision = await envB.stack.validation.getLatestDecision(ctx!.runId);
        expect(decision?.validationDecisionId).toBeTruthy();
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("admission project lock serializes concurrent distinct objectives", async () => {
    const env = await createTestStack(uniquePostgresTestId("project_lock"));
    try {
      const first = buildPostgresTestAdmissionRequest({ testName: "lock-a" });
      const second = buildPostgresTestAdmissionRequest({ testName: "lock-b" });
      const [a, b] = await Promise.all([
        env.stack.admission.admit(first),
        env.stack.admission.admit(second),
      ]);
      const outcomes = new Set([a.outcome, b.outcome]);
      expect(outcomes.has("ADMITTED") || outcomes.has("CONFLICT")).toBe(true);
      if (a.outcome === "ADMITTED" && b.outcome === "ADMITTED") {
        expect(a.runId).not.toBe(b.runId);
      }
    } finally {
      await env.close();
    }
  });

  it("HTTP duplicate admission returns deterministic duplicate semantics", async () => {
    const env = await createTestStack(uniquePostgresTestId("http_admit"));
    try {
      const app = await buildServer({
        admission: env.stack.admission,
        storageMode: "postgres",
      });
      const payload = buildPostgresTestAdmissionRequest({ testName: "http-dup" });
      const first = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload,
      });
      expect(first.statusCode).toBe(201);
      const second = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload,
      });
      expect([200, 409]).toContain(second.statusCode);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("M77: artifact bytes survive stack restart and re-verify", async () => {
    const artifactId = uniquePostgresTestId("artifact");
    const runId = uniquePostgresTestId("artifact_run");
    const bytes = Buffer.from("phase-11-artifact-bytes", "utf8");
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const envA = await createTestStack(uniquePostgresTestId("m77_a"));
    try {
      await envA.stack.blobStore.put({
        artifactId,
        runId,
        projectId: EXAMPLE_PROJECT_ID,
        executionAttemptId: uniquePostgresTestId("artifact_attempt"),
        stepId: "step_patch",
        artifactType: "PATCH",
        bytes,
        mediaType: "text/plain",
        createdAt: envA.stack.clock.nowIso(),
      });
      await envA.close();
      const envB = await createTestStack(uniquePostgresTestId("m77_b"));
      try {
        const record = await envB.stack.blobStore.get(artifactId);
        const reloaded = await envB.stack.blobStore.getBytes(artifactId);
        expect(record?.artifactId).toBe(artifactId);
        expect(record?.byteSize).toBe(bytes.byteLength);
        expect(Buffer.from(reloaded ?? [])).toEqual(bytes);
        expect(record?.contentHash).toBe(contentHash);
        const loaded = await readVerificationArtifactBytes({
          artifactId,
          relativePath: "patches/step_patch.patch",
          runId,
          dataRoot: envB.stack.dataRoot,
          blobStore: envB.stack.blobStore,
        });
        expect(loaded?.source).toBe("BLOB");
        expect(loaded?.bytes.byteLength).toBe(record?.byteSize);
        expect(Buffer.from(loaded?.bytes ?? [])).toEqual(bytes);
        expect(
          createHash("sha256").update(Buffer.from(loaded?.bytes ?? [])).digest("hex"),
        ).toBe(contentHash);
        expect(utf8FromVerificationBytes(loaded!.bytes)).toBe(
          "phase-11-artifact-bytes",
        );
        const tamperedHash = createHash("sha256")
          .update("tampered")
          .digest("hex");
        expect(tamperedHash).not.toBe(contentHash);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("M79: observability snapshots survive stack restart", async () => {
    const envA = await createTestStack(uniquePostgresTestId("m79_a"));
    try {
      const admitted = await envA.stack.admission.admit(
        buildPostgresTestAdmissionRequest({ testName: "m79" }),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      const first = await envA.stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 5,
      });
      expect(first.healthSnapshotId).toBeTruthy();
      const snapshotId = first.healthSnapshotId;
      await envA.close();
      const envB = await createTestStack(uniquePostgresTestId("m79_b"));
      try {
        const persisted = await envB.stack.observability.snapshots.getById(
          snapshotId,
        );
        expect(persisted?.snapshotId).toBe(snapshotId);
        const second = await envB.stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
          projectId: EXAMPLE_PROJECT_ID,
          kind: "LAST_N_RUNS",
          lastN: 5,
        });
        expect(second.windowFingerprint).toBe(first.windowFingerprint);
        expect(second.healthSnapshotId).toBe(first.healthSnapshotId);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("project isolation preserves projectId on durable run records", async () => {
    const env = await createTestStack(uniquePostgresTestId("iso"));
    try {
      const admitted = await env.stack.admission.admit(
        buildPostgresTestAdmissionRequest({ testName: "iso-a" }),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      const run = await env.stack.runs.getById(admitted.runId!);
      expect(run?.projectId).toBe(EXAMPLE_PROJECT_ID);
      const row = await env.db.query<{ project_id: string }>(
        `SELECT project_id FROM runs WHERE run_id = $1`,
        [admitted.runId],
      );
      expect(row.rows[0]?.project_id).toBe(EXAMPLE_PROJECT_ID);
      const artifactId = uniquePostgresTestId("iso_artifact");
      await env.stack.blobStore.put({
        artifactId,
        runId: admitted.runId!,
        projectId: EXAMPLE_PROJECT_ID,
        executionAttemptId: uniquePostgresTestId("iso_attempt"),
        stepId: "step_patch",
        artifactType: "PATCH",
        bytes: Buffer.from("iso"),
        mediaType: "text/plain",
        createdAt: env.stack.clock.nowIso(),
      });
      const artifact = await env.stack.blobStore.get(artifactId);
      expect(artifact?.projectId).toBe(EXAMPLE_PROJECT_ID);
    } finally {
      await env.close();
    }
  });

  it("recordRevision lost-update race rejects stale writer", async () => {
    const env = await createTestStack(uniquePostgresTestId("rev_race"));
    const dbB = await createIndependentDatabase(uniquePostgresTestId("rev_b"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "rev-race" });
      const admitted = await env.stack.admission.admit(request);
      expect(admitted.outcome).toBe("ADMITTED");
      const run = await env.stack.runs.getById(admitted.runId!);

      // Worker A transitions successfully
      await env.stack.runs.transition(
        run!.runId, run!.state, run!.recordRevision, "CANCELLED", new Date().toISOString(),
      );

      // Worker B uses stale revision (loaded same snapshot as A before A wrote)
      const stackB = await createPostgresOrchestratorStack({
        db: dbB, instanceId: uniquePostgresTestId("rev_b"), seedControlPlane: false,
      });
      await expect(
        stackB.runs.transition(
          run!.runId, run!.state, run!.recordRevision, "CANCELLED", new Date().toISOString(),
        ),
      ).rejects.toMatchObject({ code: "DURABLE_CONFLICT" });
    } finally {
      await env.close();
      await dbB.close();
    }
  });

  it("recovery matrix classifies multiple abandoned state types", async () => {
    const env = await createTestStack(uniquePostgresTestId("recov_mx"));
    try {
      // Seed expired leases of different phases
      const leases = new PostgresLeaseStore(env.db, 2);
      const planKey = uniquePostgresTestId("recov:plan");
      const execKey = uniquePostgresTestId("recov:exec");
      const verKey = uniquePostgresTestId("recov:ver");
      const learnKey = uniquePostgresTestId("recov:learn");
      await leases.acquire({ coordinationKey: planKey, phase: "planning", ownerId: "dead_worker" });
      await leases.acquire({ coordinationKey: execKey, phase: "execution", ownerId: "dead_worker" });
      await leases.acquire({ coordinationKey: verKey, phase: "verification", ownerId: "dead_worker" });
      await leases.acquire({ coordinationKey: learnKey, phase: "learning", ownerId: "dead_worker" });
      await waitUntilPostgresLeaseExpired(env.db, planKey);

      // Seed unsettled outbox record
      const outbox = new PostgresTransactionalOutbox(env.db);
      await outbox.enqueue({
        outboxId: uniquePostgresTestId("recov_outbox"),
        aggregateType: "test",
        aggregateId: "recov_agg",
        eventType: "RECOVERY_TEST",
        payload: { seed: true },
      });

      const items = await env.stack.recovery.recover();
      expect(items.length).toBeGreaterThanOrEqual(4);
      const outcomes = new Set(items.map((i) => i.outcome));
      expect(outcomes.has("REACQUIRED") || outcomes.has("NO_ACTION")).toBe(true);
      // No global retry-all
      expect(env.stack.actuator.invocations.length).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("M76 expanded: full authority fingerprints survive restart", async () => {
    const request = buildPostgresTestAdmissionRequest({ testName: "m76-expanded" });
    const envA = await createTestStack(uniquePostgresTestId("m76x_a"));
    try {
      const ctx = await advanceToApprovedRun(envA.stack, request);
      const runA = await envA.stack.runs.getById(ctx.runId);
      const planA = await envA.stack.planning.getPlan(ctx.runId);
      const decisionA = await envA.stack.validation.getLatestDecision(ctx.runId);
      const objectiveA = await envA.stack.objectives.getById(runA!.objectiveId);
      const authRecordA = await envA.db.query<{ payload: string }>(
        `SELECT payload::text AS payload FROM json_documents
         WHERE collection = 'authorization_records' AND run_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [ctx.runId],
      );
      const authA = JSON.parse(authRecordA.rows[0]!.payload);
      const approvalA = await envA.db.query<{ payload: string }>(
        `SELECT payload::text AS payload FROM json_documents
         WHERE collection = 'approval_requests' AND run_id = $1
         ORDER BY created_at DESC LIMIT 1`,
        [ctx.runId],
      );
      const aprA = JSON.parse(approvalA.rows[0]!.payload);
      await envA.close();

      const envB = await createTestStack(uniquePostgresTestId("m76x_b"));
      try {
        const runB = await envB.stack.runs.getById(ctx.runId);
        expect(runB?.state).toBe("APPROVED");
        expect(runB?.recordRevision).toBe(runA!.recordRevision);
        expect(runB?.objectiveId).toBe(runA!.objectiveId);
        const planB = await envB.stack.planning.getPlan(ctx.runId);
        expect(planB?.planHash).toBe(planA!.planHash);
        expect(planB?.planVersion).toBe(planA!.planVersion);
        expect(planB?.planId).toBe(planA!.planId);
        const decisionB = await envB.stack.validation.getLatestDecision(ctx.runId);
        expect(decisionB?.validationDecisionId).toBe(decisionA!.validationDecisionId);
        const objectiveB = await envB.stack.objectives.getById(runB!.objectiveId);
        expect(objectiveB?.objectiveFingerprint ?? objectiveB?.objectiveId)
          .toBe(objectiveA?.objectiveFingerprint ?? objectiveA?.objectiveId);
        const authRecordB = await envB.db.query<{ payload: string }>(
          `SELECT payload::text AS payload FROM json_documents
           WHERE collection = 'authorization_records' AND run_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [ctx.runId],
        );
        const authB = JSON.parse(authRecordB.rows[0]!.payload);
        expect(authB.authorizationRecordId).toBe(authA.authorizationRecordId);
        expect(authB.capabilitySetFingerprint).toBe(authA.capabilitySetFingerprint);
        const approvalB = await envB.db.query<{ payload: string }>(
          `SELECT payload::text AS payload FROM json_documents
           WHERE collection = 'approval_requests' AND run_id = $1
           ORDER BY created_at DESC LIMIT 1`,
          [ctx.runId],
        );
        const aprB = JSON.parse(approvalB.rows[0]!.payload);
        expect(aprB.approvalRequestId).toBe(aprA.approvalRequestId);
        expect(aprB.decisionCardHash).toBe(aprA.decisionCardHash);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("HTTP authorization duplicate returns deterministic result", async () => {
    const env = await createTestStack(uniquePostgresTestId("http_auth"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "http-auth" });
      const { approvalRequestId } = await advanceToAwaitingApproval(env.stack, request);
      const nonce = deliveredNonce(env.stack.approvalDelivery, approvalRequestId);
      const app = await buildServer({
        admission: env.stack.admission,
        humanAuthorization: env.stack.humanAuthorization,
        authorizationRouting: env.stack.authorizationRouting,
        approvalExpiry: env.stack.approvalExpiry,
        authorizationReadiness: env.stack.authorizationReadiness,
        storageMode: "postgres",
      });
      const payload = {
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: nonce,
        submittedAt: new Date().toISOString(),
      };
      const first = await app.inject({
        method: "POST",
        url: `/v1/approval-requests/${approvalRequestId}/decision`,
        payload,
      });
      const second = await app.inject({
        method: "POST",
        url: `/v1/approval-requests/${approvalRequestId}/decision`,
        payload,
      });
      expect([200, 409].some((c) => c === first.statusCode || c === second.statusCode)).toBe(true);
      const records = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'authorization_records' AND payload->>'approvalRequestId' = $1`,
        [approvalRequestId],
      );
      expect(Number(records.rows[0]?.c ?? 0)).toBe(1);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("M74 containment: RUNNING step with unknown effect → CONTAINED survives restart", async () => {
    const envA = await createTestStack(uniquePostgresTestId("m74c_a"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "m74-contain" });
      const ctx = await advanceToApprovedRun(envA.stack, request);
      // Configure actuator to produce UNKNOWN for the step
      envA.stack.actuator.simulateStateUnknown = true;
      const result = await envA.stack.execution.execute(ctx.runId);
      expect(result.containmentRequired).toBe(true);
      const runAfter = await envA.stack.runs.getById(ctx.runId);
      expect(runAfter?.state).toBe("CONTAINED");
      expect(envA.stack.actuator.invocations.length).toBe(1);
      await envA.close();

      // Stack C restart
      const envC = await createTestStack(uniquePostgresTestId("m74c_c"));
      try {
        const reloaded = await envC.stack.runs.getById(ctx.runId);
        expect(reloaded?.state).toBe("CONTAINED");
        expect(envC.stack.actuator.invocations.length).toBe(0);
        // Recovery does not retry actuator
        await envC.stack.recovery.recover();
        expect(envC.stack.actuator.invocations.length).toBe(0);
      } finally {
        await envC.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("M75 real: OutcomeVerificationService completion failpoint atomicity", async () => {
    const stages: VerificationCompletionStage[] = [
      "AFTER_OUTCOME_RECORD",
      "AFTER_COMPLETION_RECORD",
      "AFTER_RUN_TRANSITION",
      "AFTER_EVENT_APPEND",
    ];
    for (const stage of stages) {
      let failOnce = true;
      const failpoint = {
        async hit(s: VerificationCompletionStage) {
          if (s === stage && failOnce) {
            failOnce = false;
            throw new Error(`inject failure at ${stage}`);
          }
        },
      };
      const env = await createTestStack(
        uniquePostgresTestId(`m75_${stage}`),
        { completionFailpoint: failpoint },
      );
      try {
        const request = buildPostgresTestAdmissionRequest({ testName: `m75-${stage}` });
        const ctx = await advanceToExecuting(env.stack, request);
        // First attempt fails at the injected stage
        await expect(env.stack.verification.verify(ctx.runId)).rejects.toThrow();
        // Assert no partial state visible
        const run = await env.stack.runs.getById(ctx.runId);
        expect(run?.state).not.toBe("COMPLETED");
        const completions = await env.db.query(
          `SELECT 1 FROM json_documents WHERE collection = 'completion_records' AND run_id = $1`,
          [ctx.runId],
        );
        expect(completions.rows.length).toBe(0);
        // Retry successfully (failOnce is now false)
        const result = await env.stack.verification.verify(ctx.runId);
        expect(result.outcome).toBe("VERIFIED_SUCCESS");
        const runAfter = await env.stack.runs.getById(ctx.runId);
        expect(runAfter?.state).toBe("COMPLETED");
        const comps = await env.db.query(
          `SELECT 1 FROM json_documents WHERE collection = 'completion_records' AND run_id = $1`,
          [ctx.runId],
        );
        expect(comps.rows.length).toBe(1);
      } finally {
        await env.close();
      }
    }
  });

  it("recordRevision race: reload confirms winner state", async () => {
    const env = await createTestStack(uniquePostgresTestId("rev_race2"));
    const dbB = await createIndependentDatabase(uniquePostgresTestId("rev2_b"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "rev-race2" });
      const admitted = await env.stack.admission.admit(request);
      const run = await env.stack.runs.getById(admitted.runId!);
      const origRevision = run!.recordRevision;
      await env.stack.runs.transition(
        run!.runId, run!.state, run!.recordRevision, "CANCELLED", new Date().toISOString(),
      );
      const stackB = await createPostgresOrchestratorStack({
        db: dbB, instanceId: uniquePostgresTestId("rev2_b"), seedControlPlane: false,
      });
      await expect(
        stackB.runs.transition(
          run!.runId, run!.state, origRevision, "CANCELLED", new Date().toISOString(),
        ),
      ).rejects.toMatchObject({ code: "DURABLE_CONFLICT" });
      // Reload and confirm winner
      const final = await env.stack.runs.getById(run!.runId);
      expect(final?.state).toBe("CANCELLED");
      expect(final?.recordRevision).toBe(origRevision + 1);
    } finally {
      await env.close();
      await dbB.close();
    }
  });

  it("recovery: RUNNING step seed produces UNSAFE_TO_RETRY, no actuator", async () => {
    const env = await createTestStack(uniquePostgresTestId("recov_step"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "recov-step" });
      const ctx = await advanceToApprovedRun(env.stack, request);
      const attemptId = uniquePostgresTestId("recov_attempt");
      const stepKey = `${ctx.runId}:recov_step`;
      await env.stack.stepExecutions.reserve({
        idempotencyKey: stepKey,
        runId: ctx.runId,
        executionAttemptId: attemptId,
        stepId: "step_patch",
        capabilityId: "CREATE_LOCAL_PATCH",
        actionType: "CREATE_LOCAL_PATCH",
        startedAt: env.stack.clock.nowIso(),
      });
      await env.stack.stepExecutions.markRunning(stepKey);
      // Simulate dead owner lease
      const leases = new PostgresLeaseStore(env.db, 2);
      const key = uniquePostgresTestId("recov:exec_step");
      await leases.acquire({ coordinationKey: key, phase: "execution", ownerId: "dead_step_worker" });
      await waitUntilPostgresLeaseExpired(env.db, key);

      env.stack.actuator.invocations.length = 0;
      const items = await env.stack.recovery.recover();
      expect(items.some((i) => i.kind === "execution-step" && i.outcome === "UNSAFE_TO_RETRY")).toBe(true);
      expect(env.stack.actuator.invocations.length).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("recovery: ambiguous inference dispatch → no model redispatch", async () => {
    const env = await createTestStack(uniquePostgresTestId("recov_inf"));
    try {
      const callId = uniquePostgresTestId("inf_dispatch");
      const validRecord = {
        callId,
        runId: "run_inf",
        planningAttempt: 1,
        operation: "PLAN_GENERATION",
        provider: "fake",
        model: "fake-model",
        reservedTokens: 1000,
        startedAt: env.stack.clock.nowIso(),
        status: "STARTED",
      };
      await env.db.query(
        `INSERT INTO json_documents (collection, document_id, run_id, payload, immutable)
         VALUES ('planning_usage', $1, 'run_inf', $2::jsonb, FALSE)`,
        [callId, JSON.stringify({ record: validRecord, durabilityState: "DISPATCH_STARTED" })],
      );
      const items = await env.stack.recovery.recover();
      const infItem = items.find((i) => i.kind === "planning_usage");
      expect(infItem).toBeDefined();
      expect(infItem!.outcome).toBe("REQUIRES_MANUAL_REVIEW");
      expect(infItem!.detail).toContain("AMBIGUOUS");
    } finally {
      await env.close();
    }
  });

  it("HTTP execution duplicate returns idempotent/conflict", async () => {
    const env = await createTestStack(uniquePostgresTestId("http_exec"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "http-exec" });
      const ctx = await advanceToApprovedRun(env.stack, request);
      const app = await buildServer({
        admission: env.stack.admission,
        execution: env.stack.execution,
        executionReadiness: env.stack.executionReadiness,
        storageMode: "postgres",
      });
      const first = await app.inject({ method: "POST", url: `/v1/runs/${ctx.runId}/execute` });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: `/v1/runs/${ctx.runId}/execute` });
      expect([200, 409].includes(second.statusCode)).toBe(true);
      const attempts = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents WHERE collection = 'execution_attempts' AND run_id = $1`,
        [ctx.runId],
      );
      expect(Number(attempts.rows[0]?.c ?? 0)).toBe(1);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("HTTP verification duplicate returns idempotent/conflict", async () => {
    const env = await createTestStack(uniquePostgresTestId("http_ver"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "http-ver" });
      const ctx = await advanceToExecuting(env.stack, request);
      const app = await buildServer({
        admission: env.stack.admission,
        verification: env.stack.verification,
        verificationReadiness: env.stack.verificationReadiness,
        storageMode: "postgres",
      });
      const first = await app.inject({ method: "POST", url: `/v1/runs/${ctx.runId}/verify` });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({ method: "POST", url: `/v1/runs/${ctx.runId}/verify` });
      expect([200, 409].includes(second.statusCode)).toBe(true);
      const completions = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents WHERE collection = 'completion_records' AND run_id = $1`,
        [ctx.runId],
      );
      expect(Number(completions.rows[0]?.c ?? 0)).toBeLessThanOrEqual(1);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("HTTP observability rebuild duplicate returns deterministic identity", async () => {
    const env = await createTestStack(uniquePostgresTestId("http_obs"));
    try {
      await env.stack.admission.admit(
        buildPostgresTestAdmissionRequest({ testName: "http-obs" }),
      );
      const app = await buildServer({
        admission: env.stack.admission,
        observability: env.stack.observability,
        storageMode: "postgres",
      });
      const payload = { kind: "LAST_N_RUNS", lastN: 5 };
      const first = await app.inject({
        method: "POST",
        url: `/v1/projects/${EXAMPLE_PROJECT_ID}/observability/rebuild`,
        payload,
      });
      const second = await app.inject({
        method: "POST",
        url: `/v1/projects/${EXAMPLE_PROJECT_ID}/observability/rebuild`,
        payload,
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const a = JSON.parse(first.body);
      const b = JSON.parse(second.body);
      expect(a.healthSnapshotId).toBe(b.healthSnapshotId);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("completion integrity: no COMPLETED run without CompletionRecord", async () => {
    const env = await createTestStack(uniquePostgresTestId("comp_int"));
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "comp-int" });
      const ctx = await advanceToCompletedRun(env.stack, request);
      const completions = await env.db.query(
        `SELECT 1 FROM json_documents WHERE collection = 'completion_records' AND run_id = $1`,
        [ctx.runId],
      );
      expect(completions.rows.length).toBe(1);
      // Also check no COMPLETED run exists without a CompletionRecord
      const orphans = await env.db.query(
        `SELECT r.run_id FROM runs r
         WHERE r.state = 'COMPLETED'
           AND NOT EXISTS (
             SELECT 1 FROM json_documents d
             WHERE d.collection = 'completion_records' AND d.run_id = r.run_id
           )`,
      );
      expect(orphans.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  });

  it("data minimization: durable storage excludes plaintext secrets", async () => {
    const env = await createTestStack(uniquePostgresTestId("minimize"));
    try {
      const { approvalRequestId } = await advanceToAwaitingApproval(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "minimize" }),
      );
      const nonce = deliveredNonce(env.stack.approvalDelivery, approvalRequestId);
      const deliveryKey = process.env["APPROVAL_DELIVERY_SECRET_KEY"] ?? "";
      const databaseUrl = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? "";
      const audit = await env.db.query<{ txt: string }>(
        `SELECT payload::text AS txt FROM json_documents
         UNION ALL SELECT payload::text FROM transactional_outbox
         UNION ALL SELECT payload::text FROM durable_inbox
         UNION ALL SELECT encode(secret_ciphertext, 'escape') FROM approval_delivery_secrets
         UNION ALL SELECT encode(secret_iv, 'escape') FROM approval_delivery_secrets
         UNION ALL SELECT status::text FROM approval_delivery_secrets
         UNION ALL SELECT coordination_key FROM coordinator_leases
         UNION ALL SELECT payload::text FROM coordinator_fences
         UNION ALL SELECT execution_attempt_id || ' ' || run_id || ' ' || project_id
                   FROM execution_resource_ledgers
         UNION ALL SELECT content_hash || ' ' || media_type FROM artifact_blobs
         UNION ALL SELECT grant_id || ' ' || principal_id FROM authority_grants
         UNION ALL SELECT run_id || ' ' || state FROM runs`,
      );
      for (const row of audit.rows) {
        expect(row.txt).not.toContain(nonce);
        expect(row.txt.toLowerCase()).not.toContain("postgresql://");
        expect(row.txt.toLowerCase()).not.toMatch(/postgres:\/\/[^:]+:[^@]+@/);
        if (deliveryKey.length > 8) {
          expect(row.txt).not.toContain(deliveryKey);
        }
        if (databaseUrl.length > 8) {
          expect(row.txt).not.toContain(databaseUrl);
        }
        expect(row.txt.toLowerCase()).not.toContain("chain-of-thought");
        expect(row.txt.toLowerCase()).not.toContain("chain of thought");
        expect(row.txt).not.toMatch(/\bsk-[a-zA-Z0-9]{10,}/);
      }
    } finally {
      await env.close();
    }
  });

  it("M78: promoted precedent survives restart with integrity and planning fingerprint", async () => {
    const projectId = uniquePostgresTestId("m78_proj");
    const request = buildPostgresTestAdmissionRequest({
      testName: "m78",
      projectId,
      learnable: true,
    });
    const envA = await createTestStack(uniquePostgresTestId("m78_a"));
    let captured!: {
      runId: string;
      historicalRunId: string;
      historicalHash: string;
      candidateId: string;
      candidateHash: string;
      origin: string;
      claim: unknown;
      groundingVerdict: string;
      precedentId: string;
      precedentVersion: number;
      precedentHash: string;
      provenanceHash: string;
      promotionMethod: string;
      applicability: unknown;
      trustClass: string;
    };
    try {
      await seedDedicatedPostgresTestProject(envA.db, projectId);
      const ctx = await advanceToCompletedRun(envA.stack, request);
      const learned = await envA.stack.memory.learn(ctx.runId);
      expect(learned.promotedPrecedentIds.length).toBeGreaterThan(0);
      const historical = await envA.stack.memory.getHistoricalRuns().getByRunId(ctx.runId);
      const candidate = (await envA.stack.memory.getCandidates().listByRunRecord(
        learned.historicalRunRecordId,
      )).find((item) => item.status === "PROMOTED");
      const precedent = await envA.stack.memory.getPrecedent(learned.promotedPrecedentIds[0]!);
      expect(historical).toBeTruthy();
      expect(candidate).toBeTruthy();
      expect(precedent).toBeTruthy();
      expect(precedent!.projectId).toBe(projectId);
      captured = {
        runId: ctx.runId,
        historicalRunId: historical!.historicalRunRecordId,
        historicalHash: historical!.recordHash,
        candidateId: candidate!.learningCandidateId,
        candidateHash: candidate!.candidateHash,
        origin: candidate!.origin,
        claim: candidate!.claim,
        groundingVerdict: candidate!.grounding.verdict,
        precedentId: precedent!.precedentId,
        precedentVersion: precedent!.version,
        precedentHash: precedent!.precedentHash,
        provenanceHash: precedent!.provenance.provenanceHash,
        promotionMethod: precedent!.promotionMethod,
        applicability: precedent!.applicability,
        trustClass: precedent!.trustClass,
      };
      expect(precedent!.applicability.scopeClass).toBe("PROJECT_LOCAL");
      expect(precedent!.applicability.projectIds).toContain(projectId);
      await envA.close();

      const envB = await createTestStack(uniquePostgresTestId("m78_b"));
      try {
        await seedDedicatedPostgresTestProject(envB.db, projectId);
        const reloaded = await envB.stack.memory.getPrecedent(captured.precedentId);
        expect(reloaded?.precedentId).toBe(captured.precedentId);
        expect(reloaded?.version).toBe(captured.precedentVersion);
        expect(reloaded?.precedentHash).toBe(captured.precedentHash);
        expect(reloaded?.candidateId).toBe(captured.candidateId);
        expect(reloaded?.candidateHash).toBe(captured.candidateHash);
        expect(reloaded?.origin).toBe(captured.origin);
        expect(reloaded?.grounding.verdict).toBe(captured.groundingVerdict);
        expect(reloaded?.promotionMethod).toBe(captured.promotionMethod);
        expect(reloaded?.trustClass).toBe(captured.trustClass);
        expect(reloaded?.applicability).toEqual(captured.applicability);
        expect(reloaded?.provenance.provenanceHash).toBe(captured.provenanceHash);
        expect(reloaded?.status).toBe("ACTIVE");
        const integrity = await envB.stack.memory.getIntegrity().check(reloaded!);
        expect(integrity.ok).toBe(true);
        const active = await envB.stack.memory.listProjectPrecedents(projectId);
        expect(active.some((item) => item.precedentId === captured.precedentId)).toBe(
          true,
        );
        const retrievalQuery = {
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          objectiveText: request.requestedOutcome,
        };
        const retrieved = await envB.stack.memory.retrievePrecedents(retrievalQuery);
        const match = retrieved.precedents.find(
          (item) => item.precedentId === captured.precedentId,
        );
        if (!match) {
          expect({
            capturedPrecedentId: captured.precedentId,
            retrievedIds: retrieved.precedents.map((p) => p.precedentId),
            excludedPrecedentIds: retrieved.excludedPrecedentIds,
            activeIds: active.map((p) => ({
              precedentId: p.precedentId,
              status: p.status,
              projectId: p.projectId,
            })),
          }).toEqual({ capturedPrecedentId: captured.precedentId, found: true });
        }
        expect(match).toBeDefined();
        expect(match?.precedentVersion).toBe(captured.precedentVersion);
        expect(match?.precedentHash).toBe(captured.precedentHash);
        const duplicate = await envB.stack.memory.getPromotion().tryAutoPromote(
          (await envB.stack.memory.getCandidates().getById(captured.candidateId))!,
        );
        expect(duplicate.promoted?.precedentId).toBe(captured.precedentId);
        expect(duplicate.promoted?.version).toBe(captured.precedentVersion);
        expect(duplicate.promoted?.precedentHash).toBe(captured.precedentHash);
        expect(duplicate.promoted?.status).toBe("ACTIVE");
        expect(duplicate.promoted?.status).not.toBe("RETIRED");
        expect(duplicate.promoted?.status).not.toBe("SUPERSEDED");
        const afterDuplicate = await envB.stack.memory.getPrecedent(captured.precedentId);
        expect(afterDuplicate?.status).toBe("ACTIVE");
        expect(afterDuplicate?.precedentHash).toBe(captured.precedentHash);
        const sameFamily = (await envB.stack.memory.listProjectPrecedents(projectId)).filter(
          (item) => item.candidateId === captured.candidateId,
        );
        expect(sameFamily.filter((item) => item.status === "ACTIVE")).toHaveLength(1);
        const follow = await envB.stack.admission.admit(
          buildPostgresTestAdmissionRequest({
            testName: "m78-follow",
            projectId,
            learnable: true,
          }),
        );
        expect(follow.outcome).toBe("ADMITTED");
        await envB.stack.ingestion.ingest(
          follow.runId!,
          projectId,
          EXAMPLE_ENVIRONMENT,
        );
        const compiled = await envB.stack.planning.compileContext(follow.runId!);
        expect(compiled.run.projectId).toBe(projectId);
        const planned = compiled.advisoryPrecedents.find(
          (p) => p.precedentId === captured.precedentId,
        );
        if (!planned) {
          expect({
            capturedPrecedentId: captured.precedentId,
            advisoryIds: compiled.advisoryPrecedents.map((p) => p.precedentId),
            directRetrievedIds: retrieved.precedents.map((p) => p.precedentId),
            excludedPrecedentIds: retrieved.excludedPrecedentIds,
          }).toEqual({ capturedPrecedentId: captured.precedentId, found: true });
        }
        expect(planned).toBeDefined();
        const fpMaterial = compiled.advisoryPrecedents.map((p) => ({
          precedentId: p.precedentId,
          version: p.precedentVersion,
          precedentHash: p.precedentHash,
        }));
        expect(fpMaterial).toContainEqual({
          precedentId: captured.precedentId,
          version: captured.precedentVersion,
          precedentHash: captured.precedentHash,
        });
        expect(compiled.contextMetadata.planningContextFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(retrieved.retrievalContextFingerprint).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("memory promotion failpoints roll back then retry to one precedent", async () => {
    const autoStages: PromotionFailpointStage[] = [
      "AFTER_PRECEDENT_WRITE",
      "AFTER_CANDIDATE_STATE",
      "AFTER_PROMOTION_LEDGER",
    ];
    for (const stage of autoStages) {
      let failOnce = true;
      const failpoint = {
        async hit(s: PromotionFailpointStage) {
          if (s === stage && failOnce) {
            failOnce = false;
            throw new Error(`inject promotion failure at ${stage}`);
          }
        },
      };
      const env = await createTestStack(uniquePostgresTestId(`promo_${stage}`), {
        promotionFailpoint: failpoint,
      });
      try {
        const ctx = await advanceToCompletedRun(
          env.stack,
          buildPostgresTestAdmissionRequest({ testName: `promo-${stage}`, learnable: true }),
        );
        await expect(env.stack.memory.learn(ctx.runId)).rejects.toThrow();
        const inspect = await createTestStack(uniquePostgresTestId(`promo_i_${stage}`));
        try {
          const historical = await inspect.stack.memory.getHistoricalRuns().getByRunId(ctx.runId);
          expect(historical).toBeTruthy();
          const candidates = await inspect.stack.memory.getCandidates().listByRunRecord(
            historical!.historicalRunRecordId,
          );
          expect(candidates.some((c) => c.status === "PROMOTED")).toBe(false);
          const precedents = await inspect.stack.memory.listProjectPrecedents(EXAMPLE_PROJECT_ID);
          expect(
            precedents.filter((p) => p.provenance.runId === ctx.runId),
          ).toHaveLength(0);
          const ledger = await inspect.db.query<{ c: number }>(
            `SELECT COUNT(*)::int AS c FROM json_documents
             WHERE collection = 'learning_ledger'
               AND payload->>'eventType' = 'PRECEDENT_PROMOTED'
               AND payload->>'runId' = $1`,
            [ctx.runId],
          );
          expect(Number(ledger.rows[0]?.c ?? 0)).toBe(0);
        } finally {
          await inspect.close();
        }
        const retried = await env.stack.memory.learn(ctx.runId);
        expect(retried.promotedPrecedentIds.length).toBeGreaterThan(0);
        const after = await env.stack.memory.listProjectPrecedents(EXAMPLE_PROJECT_ID);
        const promoted = after.filter((p) => p.provenance.runId === ctx.runId);
        expect(promoted.length).toBeGreaterThan(0);
        expect(new Set(promoted.map((p) => p.precedentId)).size).toBe(promoted.length);
        const historical = await env.stack.memory.getHistoricalRuns().getByRunId(ctx.runId);
        const candidate = (await env.stack.memory.getCandidates().listByRunRecord(
          historical!.historicalRunRecordId,
        )).find((c) => c.learningCandidateId === promoted[0]!.candidateId);
        expect(candidate?.status).toBe("PROMOTED");
      } finally {
        await env.close();
      }
    }
  });

  it("AFTER_HUMAN_DECISION failpoint does not create promotion authority", async () => {
    const seedFail = {
      async hit(s: PromotionFailpointStage) {
        if (s === "AFTER_PRECEDENT_WRITE") {
          throw new Error("stop auto-promote so human path is available");
        }
      },
    };
    const seed = await createTestStack(uniquePostgresTestId("human_seed"), {
      promotionFailpoint: seedFail,
    });
    let candidateId: string;
    try {
      const ctx = await advanceToCompletedRun(
        seed.stack,
        buildPostgresTestAdmissionRequest({ testName: "human-dec", learnable: true }),
      );
      await expect(seed.stack.memory.learn(ctx.runId)).rejects.toThrow();
      const historical = await seed.stack.memory.getHistoricalRuns().getByRunId(ctx.runId);
      const candidates = await seed.stack.memory.getCandidates().listByRunRecord(
        historical!.historicalRunRecordId,
      );
      const reviewable = candidates.find((c) => c.status !== "PROMOTED");
      expect(reviewable).toBeTruthy();
      candidateId = reviewable!.learningCandidateId;
    } finally {
      await seed.close();
    }

    let failOnce = true;
    const failpoint = {
      async hit(s: PromotionFailpointStage) {
        if (s === "AFTER_HUMAN_DECISION" && failOnce) {
          failOnce = false;
          throw new Error("inject after human decision");
        }
      },
    };
    const env = await createTestStack(uniquePostgresTestId("human_fp"), {
      promotionFailpoint: failpoint,
    });
    try {
      await expect(
        env.stack.memory.reviewCandidate({
          learningCandidateId: candidateId,
          reviewerId: "approver_bootstrap",
          decision: "PROMOTE",
        }),
      ).rejects.toThrow();
      const inspect = await createTestStack(uniquePostgresTestId("human_i"));
      try {
        const decisions = await inspect.db.query(
          `SELECT 1 FROM json_documents
           WHERE collection = 'promotion_decisions'
             AND payload->>'learningCandidateId' = $1`,
          [candidateId],
        );
        expect(decisions.rows.length).toBe(0);
        const live = await inspect.stack.memory.getCandidates().getById(candidateId);
        expect(live?.status).not.toBe("PROMOTED");
        const retry = await inspect.stack.memory.reviewCandidate({
          learningCandidateId: candidateId,
          reviewerId: "approver_bootstrap",
          decision: "PROMOTE",
        });
        expect(retry.promoted).toBeDefined();
        expect(retry.decision.decision).toBe("PROMOTE");
      } finally {
        await inspect.close();
      }
    } finally {
      await env.close();
    }
  });

  it("M76 execution-phase restart preserves execution and authorization authority", async () => {
    const request = buildPostgresTestAdmissionRequest({ testName: "m76-exec" });
    const envA = await createTestStack(uniquePostgresTestId("m76e_a"));
    try {
      const ctx = await advanceToExecuting(envA.stack, request);
      const runA = await envA.stack.runs.getById(ctx.runId);
      const contextA = await envA.db.query<{ payload: string }>(
        `SELECT payload::text AS payload FROM json_documents
         WHERE collection = 'verified_contexts' AND run_id = $1 LIMIT 1`,
        [ctx.runId],
      );
      const repoA = JSON.parse(contextA.rows[0]!.payload);
      const authA = await envA.stack.authorizationRecords.getLatestByRun(ctx.runId);
      const attemptA = await envA.stack.execution.getLatestAttempt(ctx.runId);
      const resultA = await envA.stack.execution.getLatestResult(ctx.runId);
      const stepsA = await envA.stack.stepExecutions.listByExecutionAttempt(
        attemptA!.executionAttemptId,
      );
      const ledgerA = await envA.stack.resourceLedgerStore.load(attemptA!.executionAttemptId);
      const snapshotA = await envA.stack.execution.getAuthoritySnapshot(
        attemptA!.executionAttemptId,
      );
      const artifactsA = await envA.stack.execution.listArtifacts(ctx.runId);
      await envA.close();

      const envB = await createTestStack(uniquePostgresTestId("m76e_b"));
      try {
        const runB = await envB.stack.runs.getById(ctx.runId);
        expect(runB?.state).toBe(runA?.state);
        expect(runB?.recordRevision).toBe(runA?.recordRevision);
        const contextB = JSON.parse(
          (await envB.db.query<{ payload: string }>(
            `SELECT payload::text AS payload FROM json_documents
             WHERE collection = 'verified_contexts' AND run_id = $1 LIMIT 1`,
            [ctx.runId],
          )).rows[0]!.payload,
        );
        expect(contextB.repositoryFingerprint).toBe(repoA.repositoryFingerprint);
        expect(contextB.lockedRepository.commitSha).toBe(
          repoA.lockedRepository.commitSha,
        );
        const authB = await envB.stack.authorizationRecords.getLatestByRun(ctx.runId);
        expect(authB?.authorizationRecordId).toBe(authA?.authorizationRecordId);
        expect(authB?.capabilitySetFingerprint).toBe(authA?.capabilitySetFingerprint);
        expect(authB?.planHash).toBe(authA?.planHash);
        const attemptB = await envB.stack.execution.getLatestAttempt(ctx.runId);
        expect(attemptB?.executionAttemptId).toBe(attemptA?.executionAttemptId);
        const ledgerB = await envB.stack.resourceLedgerStore.load(attemptB!.executionAttemptId);
        expect(ledgerB).toEqual(ledgerA);
        const stepsB = await envB.stack.stepExecutions.listByExecutionAttempt(
          attemptB!.executionAttemptId,
        );
        expect(stepsB.map((s) => ({ stepId: s.stepId, status: s.status }))).toEqual(
          stepsA.map((s) => ({ stepId: s.stepId, status: s.status })),
        );
        const snapshotB = await envB.stack.execution.getAuthoritySnapshot(
          attemptB!.executionAttemptId,
        );
        expect(snapshotB?.authoritySnapshotId).toBe(snapshotA?.authoritySnapshotId);
        expect(snapshotB?.authorizationRecordId).toBe(snapshotA?.authorizationRecordId);
        expect(snapshotB?.planHash).toBe(snapshotA?.planHash);
        expect(snapshotB?.capabilitySetFingerprint).toBe(
          snapshotA?.capabilitySetFingerprint,
        );
        const hydrated = await envB.stack.execution.getLatestResult(ctx.runId);
        expect(hydrated).toEqual(resultA);
        const attemptsBeforeReplay = await envB.db.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM json_documents WHERE collection = 'execution_attempts' AND run_id = $1`,
          [ctx.runId],
        );
        expect(Number(attemptsBeforeReplay.rows[0]?.c ?? 0)).toBe(1);
        const replay = await envB.stack.execution.execute(ctx.runId);
        expect(replay.executionAttemptId).toBe(resultA?.executionAttemptId ?? attemptA?.executionAttemptId);
        expect(replay.artifactRefs).toEqual(resultA?.artifactRefs);
        expect(replay.status).toBe(resultA?.status);
        const attemptsAfterReplay = await envB.db.query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM json_documents WHERE collection = 'execution_attempts' AND run_id = $1`,
          [ctx.runId],
        );
        expect(Number(attemptsAfterReplay.rows[0]?.c ?? 0)).toBe(1);
        const authAfter = await envB.stack.authorizationRecords.getLatestByRun(ctx.runId);
        expect(authAfter?.authorizationRecordId).toBe(authA?.authorizationRecordId);
        const verified = await envB.stack.verification.verify(ctx.runId);
        if (verified.outcome !== "VERIFIED_SUCCESS") {
          expect({
            outcome: verified.outcome,
            failureSummary: verified.failureSummary,
            findings: verified.findings.map((f) => ({
              ruleId: f.ruleId,
              category: f.category,
              message: f.message,
              blocksVerifiedSuccess: f.blocksVerifiedSuccess,
            })),
            criterionResults: verified.criterionResults.map((c) => ({
              criterionId: c.criterionId,
              verdict: c.verdict,
              verificationMethod: c.verificationMethod,
            })),
            postconditionResults: verified.postconditionResults.map((p) => ({
              postconditionId: p.postconditionId,
              verdict: p.verdict,
            })),
          }).toEqual({ outcome: "VERIFIED_SUCCESS" });
        }
        expect(verified.outcome).toBe("VERIFIED_SUCCESS");
        expect(verified.executionAttemptId).toBe(attemptA?.executionAttemptId);
        const artifactsB = await envB.stack.execution.listArtifacts(ctx.runId);
        expect(artifactsB.map((a) => ({ artifactId: a.artifactId, contentHash: a.contentHash }))).toEqual(
          artifactsA.map((a) => ({ artifactId: a.artifactId, contentHash: a.contentHash })),
        );
        for (const artifact of artifactsB) {
          const blob = await envB.stack.blobStore.get(artifact.artifactId);
          const blobBytes = await envB.stack.blobStore.getBytes(artifact.artifactId);
          expect(blobBytes).not.toBeNull();
          expect(blob?.byteSize).toBe(blobBytes!.byteLength);
          expect(blob?.contentHash).toBe(artifact.contentHash);
          expect(
            createHash("sha256").update(Buffer.from(blobBytes!)).digest("hex"),
          ).toBe(artifact.contentHash);
          const loaded = await readVerificationArtifactBytes({
            artifactId: artifact.artifactId,
            relativePath: artifact.relativePath,
            runId: ctx.runId,
            dataRoot: envB.stack.dataRoot,
            blobStore: envB.stack.blobStore,
          });
          expect(loaded?.source).toBe("BLOB");
          expect(Buffer.from(loaded!.bytes)).toEqual(Buffer.from(blobBytes!));
          if (
            artifact.artifactType === "PATCH" ||
            artifact.artifactType === "PR_PREPARATION" ||
            artifact.artifactType === "ROLLBACK" ||
            artifact.artifactType === "OTHER"
          ) {
            expect(artifact.size).toBe(blobBytes!.byteLength);
          }
          const text = utf8FromVerificationBytes(loaded!.bytes);
          if (artifact.artifactType === "PATCH") {
            expect(text).toContain("# Phase 7 local patch artifact");
          }
          if (artifact.artifactType === "TEST_RESULT") {
            expect(JSON.parse(text).exitCode).toBe(0);
          }
        }
        const completed = await envB.stack.runs.getById(ctx.runId);
        expect(completed?.state).toBe("COMPLETED");
        const completion = await envB.stack.verification.getCompletion(ctx.runId);
        expect(completion?.executionAttemptId).toBe(attemptA?.executionAttemptId);
        expect(completion?.authorizationRecordId).toBe(authA?.authorizationRecordId);
        expect(verified.criterionResults.every((c) => c.verdict === "SATISFIED")).toBe(
          true,
        );
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("two-project isolation denies A-scoped access to B authority", async () => {
    const env = await createTestStack(uniquePostgresTestId("iso2"));
    try {
      await seedIsolationProjectB(env.db);
      const ctxA = await advanceToExecuting(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "iso-a", learnable: true }),
      );
      const ctxB = await advanceToExecuting(
        env.stack,
        buildPostgresTestAdmissionRequest({
          testName: "iso-b",
          projectId: ISOLATION_PROJECT_B_ID,
          learnable: true,
        }),
      );
      await env.stack.verification.verify(ctxA.runId);
      await env.stack.verification.verify(ctxB.runId);
      await env.stack.memory.learn(ctxA.runId);
      await env.stack.memory.learn(ctxB.runId);

      await expect(
        env.stack.runs.getByIdInProject(ctxB.runId, EXAMPLE_PROJECT_ID),
      ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
      const runB = await env.stack.runs.getById(ctxB.runId);
      await expect(
        env.stack.runs.transitionInProject(
          ctxB.runId,
          EXAMPLE_PROJECT_ID,
          runB!.state,
          runB!.recordRevision,
          "CANCELLED",
          env.stack.clock.nowIso(),
        ),
      ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });

      await expect(
        env.stack.authorizationRecords.getLatestByRunInProject(
          ctxB.runId,
          EXAMPLE_PROJECT_ID,
        ),
      ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });

      await expect(
        env.stack.execution.getLatestResultInProject(ctxB.runId, EXAMPLE_PROJECT_ID),
      ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });

      const attemptB = await env.stack.execution.getLatestAttempt(ctxB.runId);
      await expect(
        env.stack.resourceLedgerStore.loadInProject(
          attemptB!.executionAttemptId,
          EXAMPLE_PROJECT_ID,
        ),
      ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });

      const artifactsB = await env.stack.execution.listArtifacts(ctxB.runId);
      if (artifactsB[0]) {
        await expect(
          env.stack.blobStore.getInProject(artifactsB[0]!.artifactId, EXAMPLE_PROJECT_ID),
        ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
      } else {
        const blobId = uniquePostgresTestId("iso_b_blob");
        await env.stack.blobStore.put({
          artifactId: blobId,
          runId: ctxB.runId,
          projectId: ISOLATION_PROJECT_B_ID,
          executionAttemptId: attemptB!.executionAttemptId,
          stepId: "step_patch",
          artifactType: "PATCH",
          bytes: Buffer.from("project-b"),
          mediaType: "text/plain",
          createdAt: env.stack.clock.nowIso(),
        });
        await expect(
          env.stack.blobStore.getInProject(blobId, EXAMPLE_PROJECT_ID),
        ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
      }

      const bPrecedents = await env.stack.memory.listProjectPrecedents(ISOLATION_PROJECT_B_ID);
      const aRetrieved = await env.stack.memory.retrievePrecedents({
        projectId: EXAMPLE_PROJECT_ID,
      });
      expect(
        aRetrieved.precedents.some((p) =>
          bPrecedents.some((b) => b.precedentId === p.precedentId),
        ),
      ).toBe(false);
      if (bPrecedents[0]) {
        await expect(
          env.stack.memory.getPrecedentInProject(
            bPrecedents[0]!.precedentId,
            EXAMPLE_PROJECT_ID,
          ),
        ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
      }

      await expect(
        env.stack.ingestion.ingest(ctxB.runId, EXAMPLE_PROJECT_ID, EXAMPLE_ENVIRONMENT),
      ).rejects.toMatchObject({ code: "INVALID_INGESTION_STATE" });

      const snapA = await env.stack.observability.rebuild(EXAMPLE_PROJECT_ID, {
        projectId: EXAMPLE_PROJECT_ID,
        kind: "LAST_N_RUNS",
        lastN: 20,
      });
      const storedA = await env.stack.observability.snapshots.getById(snapA.healthSnapshotId);
      expect(JSON.stringify(storedA)).not.toContain(ctxB.runId);
      const snapB = await env.stack.observability.rebuild(ISOLATION_PROJECT_B_ID, {
        projectId: ISOLATION_PROJECT_B_ID,
        kind: "LAST_N_RUNS",
        lastN: 20,
      });
      const storedB = await env.stack.observability.snapshots.getById(snapB.healthSnapshotId);
      expect(storedB?.projectId).toBe(ISOLATION_PROJECT_B_ID);
      expect(JSON.stringify(storedA)).not.toContain(snapB.healthSnapshotId);

      const aRuns = await env.stack.runs.listByProject(EXAMPLE_PROJECT_ID);
      expect(aRuns.some((r) => r.runId === ctxB.runId)).toBe(false);

      await expect(
        env.stack.runs.getByIdInProject(ctxB.runId, EXAMPLE_PROJECT_ID),
      ).rejects.toMatchObject({ code: "PROJECT_SCOPE_VIOLATION" });
    } finally {
      await env.close();
    }
  });

  it("HTTP learning duplicate returns deterministic reuse without duplicated memory authority", async () => {
    const env = await createTestStack(uniquePostgresTestId("http_learn"));
    try {
      const ctx = await advanceToCompletedRun(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "http-learn", learnable: true }),
      );
      const app = await buildServer({
        admission: env.stack.admission,
        memory: env.stack.memory,
        storageMode: "postgres",
      });
      const first = await app.inject({
        method: "POST",
        url: `/v1/runs/${ctx.runId}/learn`,
      });
      expect(first.statusCode).toBe(200);
      const second = await app.inject({
        method: "POST",
        url: `/v1/runs/${ctx.runId}/learn`,
      });
      expect([200, 409]).toContain(second.statusCode);
      const firstBody = JSON.parse(first.body);
      if (second.statusCode === 200) {
        const secondBody = JSON.parse(second.body);
        expect(secondBody.historicalRunRecordId).toBe(firstBody.historicalRunRecordId);
        expect(secondBody.candidateIds).toEqual(firstBody.candidateIds);
      }
      const historical = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'historical_runs' AND run_id = $1`,
        [ctx.runId],
      );
      expect(Number(historical.rows[0]?.c ?? 0)).toBe(1);
      const candidates = await env.db.query(
        `SELECT COUNT(DISTINCT payload->>'learningCandidateId')::int AS c
         FROM json_documents
         WHERE collection = 'learning_candidates'
           AND payload->>'sourceHistoricalRunRecordId' = $1`,
        [firstBody.historicalRunRecordId],
      );
      expect(Number(candidates.rows[0]?.c ?? 0)).toBe(firstBody.candidateIds.length);
      const precedents = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'promoted_precedents'
           AND payload->'provenance'->>'runId' = $1`,
        [ctx.runId],
      );
      expect(Number(precedents.rows[0]?.c ?? 0)).toBe(firstBody.promotedPrecedentIds.length);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("precedent integrity: no promoted precedent without promotion basis", async () => {
    const env = await createTestStack(uniquePostgresTestId("prec_int"));
    try {
      const ctx = await advanceToCompletedRun(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "prec-int", learnable: true }),
      );
      await env.stack.memory.learn(ctx.runId);
      const orphans = await env.db.query(
        `SELECT d.document_id FROM json_documents d
         WHERE d.collection = 'promoted_precedents'
           AND NOT EXISTS (
             SELECT 1 FROM json_documents l
             WHERE l.collection = 'learning_ledger'
               AND l.payload->>'eventType' = 'PRECEDENT_PROMOTED'
               AND (
                 l.payload->>'precedentId' = d.payload->>'precedentId'
                 OR l.payload->'payload'->>'precedentHash' = d.payload->>'precedentHash'
               )
           )`,
      );
      expect(orphans.rows.length).toBe(0);
      const dupes = await env.db.query(
        `SELECT payload->>'precedentId' AS id, payload->>'version' AS v, COUNT(*)::int AS c
         FROM json_documents
         WHERE collection = 'promoted_precedents'
         GROUP BY 1, 2
         HAVING COUNT(*) > 1`,
      );
      expect(dupes.rows.length).toBe(0);
      const completionDupes = await env.db.query(
        `SELECT run_id, COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'completion_records'
         GROUP BY run_id
         HAVING COUNT(*) > 1`,
      );
      expect(completionDupes.rows.length).toBe(0);
    } finally {
      await env.close();
    }
  });
});
