import { describe, expect, it } from "vitest";
import {
  createTestStack,
  createIndependentDatabase,
  createTestDatabase,
  buildPostgresTestAdmissionRequest,
  uniquePostgresTestId,
  waitUntilPostgresLeaseExpired,
} from "./test-helpers.js";
import { PostgresDatabase } from "./database.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import { ExecutionResourceLedger } from "../../execution/resource-ledger.js";
import { EXAMPLE_BUDGET } from "../../control-plane/fixtures.js";
import { PostgresLeaseStore } from "./leases.js";
import { PostgresTransactionManager } from "./transaction.js";

describe("PostgreSQL durability", () => {
  it("connects to TEST_DATABASE_URL", async () => {
    const db = new PostgresDatabase({
      connectionString:
        process.env["TEST_DATABASE_URL"] ??
        "postgres://orchestrator:orchestrator@127.0.0.1:5432/orchestrator",
      max: 2,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 5_000,
      instanceId: "pg_connectivity_probe",
    });
    try {
      const result = await db.query("SELECT 1 AS ok");
      expect(result.rows[0]?.ok).toBe(1);
    } finally {
      await db.close();
    }
  });

  it("repeatable unique admission is ADMITTED when prior durable rows exist", async () => {
    const env = await createTestStack(uniquePostgresTestId("repeatable_admission"));
    try {
      const request = buildPostgresTestAdmissionRequest({
        testName: "repeatable-admission",
      });
      const result = await env.stack.admission.admit(request);
      expect(result.outcome).toBe("ADMITTED");
      expect(result.runId).toBeTruthy();
    } finally {
      await env.close();
    }
  });

  it("M69: concurrent admission creates one logical run", async () => {
    const db = await createTestDatabase(uniquePostgresTestId("admission_shared"));
    const dbB = await createIndependentDatabase(uniquePostgresTestId("admission_b"));
    try {
      const stackA = await createPostgresOrchestratorStack({
        db,
        instanceId: uniquePostgresTestId("admission_worker_a"),
      });
      const stackB = await createPostgresOrchestratorStack({
        db: dbB,
        instanceId: uniquePostgresTestId("admission_worker_b"),
        seedControlPlane: false,
      });
      const request = buildPostgresTestAdmissionRequest({
        testName: "m69-concurrent",
      });
      const [first, second] = await Promise.all([
        stackA.admission.admit(request),
        stackB.admission.admit(request),
      ]);
      const outcomes = new Set([first.outcome, second.outcome]);
      expect(
        outcomes.has("ADMITTED") || outcomes.has("ACTIVE_DUPLICATE"),
      ).toBe(true);
      if (first.runId && second.runId) {
        expect(first.runId).toBe(second.runId);
      }
    } finally {
      await db.close();
      await dbB.close();
    }
  });

  it("M76: restart reloads admitted run from PostgreSQL", async () => {
    const request = buildPostgresTestAdmissionRequest({
      testName: "m76-restart",
    });
    let runId: string | undefined;
    let projectId: string | undefined;
    let objectiveId: string | undefined;
    let idempotencyKey: string | undefined;

    const envA = await createTestStack(uniquePostgresTestId("restart_a"));
    try {
      const admitted = await envA.stack.admission.admit(request);
      expect(admitted.outcome).toBe("ADMITTED");
      runId = admitted.runId;
      expect(runId).toBeTruthy();
      const created = await envA.stack.runs.getById(runId!);
      expect(created?.state).toBe("ADMITTED");
      projectId = created!.projectId;
      objectiveId = created!.objectiveId;
      idempotencyKey = created!.idempotencyKey;
    } finally {
      await envA.close();
    }

    const envB = await createTestStack(uniquePostgresTestId("restart_b"));
    try {
      const reloaded = await envB.stack.runs.getById(runId!);
      expect(reloaded).not.toBeNull();
      expect(reloaded!.runId).toBe(runId);
      expect(reloaded!.projectId).toBe(projectId);
      expect(reloaded!.projectId).toBe(request.projectId);
      expect(reloaded!.objectiveId).toBe(objectiveId);
      expect(reloaded!.objectiveId).toBe(request.objectiveId);
      expect(reloaded!.objectiveVersion).toBe(request.objectiveVersion);
      expect(reloaded!.requestedEnvironment).toBe(request.requestedEnvironment);
      expect(reloaded!.idempotencyKey).toBe(idempotencyKey);
      expect(reloaded!.state).toBe("ADMITTED");

      const inProject = (await envB.stack.runs.listByProject(projectId!)).find(
        (record) => record.runId === runId,
      );
      expect(inProject?.runId).toBe(runId);
      expect(inProject?.state).toBe("ADMITTED");

      const duplicate = await envB.stack.admission.admit(request);
      expect(duplicate.outcome).toBe("ACTIVE_DUPLICATE");
      if (duplicate.outcome === "ACTIVE_DUPLICATE") {
        expect(duplicate.runId).toBe(runId);
      }
    } finally {
      await envB.close();
    }
  });

  it("execution resource ledger survives stack restart", async () => {
    const attemptId = uniquePostgresTestId("attempt_resource_restart");
    const runId = uniquePostgresTestId("run_resource_restart");
    const envA = await createTestStack(uniquePostgresTestId("ledger_a"));
    let before: number | undefined;
    try {
      await envA.stack.resourceLedgerStore.initialize({
        executionAttemptId: attemptId,
        runId,
        projectId: "project_demo",
        budget: EXAMPLE_BUDGET,
      });
      const ledger = await ExecutionResourceLedger.create({
        budget: EXAMPLE_BUDGET,
        runId,
        projectId: "project_demo",
        executionAttemptId: attemptId,
        store: envA.stack.resourceLedgerStore,
      });
      await ledger.reserveDurationMs(30_000);
      before = ledger.snapshot().reservedDurationMs;
      expect(before).toBe(30_000);
    } finally {
      await envA.close();
    }

    const envB = await createTestStack(uniquePostgresTestId("ledger_b"));
    try {
      const reloaded = await ExecutionResourceLedger.loadExisting({
        budget: EXAMPLE_BUDGET,
        store: envB.stack.resourceLedgerStore,
        executionAttemptId: attemptId,
      });
      expect(reloaded?.snapshot().reservedDurationMs).toBe(before);
    } finally {
      await envB.close();
    }
  });

  it("M70/M71: stale worker loses lease heartbeat and fence authority", async () => {
    const env = await createTestStack(uniquePostgresTestId("lease_a"));
    try {
      const leases = new PostgresLeaseStore(env.db, 2);
      const key = uniquePostgresTestId("coord:test");
      const a = await leases.acquire({
        coordinationKey: key,
        phase: "planning",
        ownerId: "worker_a",
      });
      expect(a).not.toBeNull();
      expect(a.ownerId).toBe("worker_a");
      expect(a.status).toBe("HELD");
      expect(a.fenceToken).toBe(1);
      const fenceA = a.fenceToken;

      await waitUntilPostgresLeaseExpired(env.db, key);

      const b = await leases.acquire({
        coordinationKey: key,
        phase: "planning",
        ownerId: "worker_b",
      });
      expect(b).not.toBeNull();
      expect(b.ownerId).toBe("worker_b");
      expect(b.status).toBe("HELD");
      expect(b.fenceToken).toBeGreaterThan(fenceA);

      await expect(
        leases.heartbeat({
          coordinationKey: key,
          ownerId: "worker_a",
          fenceToken: fenceA,
        }),
      ).rejects.toMatchObject({
        name: "DurabilityError",
        code: "LEASE_OWNERSHIP_LOST",
      });

      await expect(
        leases.assertWritable({
          coordinationKey: key,
          ownerId: "worker_a",
          fenceToken: fenceA,
        }),
      ).rejects.toMatchObject({
        name: "DurabilityError",
        code: "STALE_FENCE_TOKEN",
      });

      const heartbeatB = await leases.heartbeat({
        coordinationKey: key,
        ownerId: "worker_b",
        fenceToken: b.fenceToken,
      });
      expect(heartbeatB.ownerId).toBe("worker_b");
      expect(heartbeatB.fenceToken).toBe(b.fenceToken);
      expect(heartbeatB.status).toBe("HELD");
    } finally {
      await env.close();
    }
  });

  it("nested PostgreSQL transaction rolls back on outer failure", async () => {
    const db = await createTestDatabase(uniquePostgresTestId("nested_tx"));
    const tx = new PostgresTransactionManager(db);
    const attemptId = uniquePostgresTestId("nested_attempt");
    const runId = uniquePostgresTestId("nested_run");
    try {
      await expect(
        tx.withTransaction(async () => {
          await db.query(
            `INSERT INTO execution_resource_ledgers (
               execution_attempt_id, run_id, project_id, budget_profile_id,
               ceiling_duration_ms, ceiling_api_calls, ceiling_plan_steps
             ) VALUES ($1, $2, 'project_demo', 'budget_demo', 60000, 10, 20)
             ON CONFLICT DO NOTHING`,
            [attemptId, runId],
          );
          await tx.withTransaction(async () => {
            await db.query(
              `UPDATE execution_resource_ledgers
               SET reserved_duration_ms = reserved_duration_ms + 1000
               WHERE execution_attempt_id = $1`,
              [attemptId],
            );
          });
          throw new Error("outer failure");
        }),
      ).rejects.toThrow("outer failure");

      const row = await db.query<{ reserved_duration_ms: string }>(
        `SELECT reserved_duration_ms FROM execution_resource_ledgers
         WHERE execution_attempt_id = $1`,
        [attemptId],
      );
      expect(row.rows[0]?.reserved_duration_ms ?? "0").toBe("0");
    } finally {
      await db.close();
    }
  });
});
