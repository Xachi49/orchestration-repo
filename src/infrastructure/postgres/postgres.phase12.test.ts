import { describe, expect, it } from "vitest";
import { buildServer } from "../../api/server.js";
import {
  buildPostgresTestAdmissionRequest,
  createTestDatabase,
  createTestStack,
  createTestStackOnUrl,
  uniquePostgresTestId,
  waitUntilPostgresLeaseExpired,
  waitUntilPostgresOutboxLeaseExpired,
} from "./test-helpers.js";
import { EXAMPLE_BUDGET, EXAMPLE_PROJECT_ID } from "../../control-plane/fixtures.js";
import {
  FakeRequestAuthenticator,
  HeaderRequestAuthenticator,
} from "../../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../../runtime/access.js";
import { DrainController, StartupLifecycle } from "../../runtime/startup.js";
import { OperationalMetrics } from "../../runtime/metrics.js";
import { MemoryStructuredLogger } from "../../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../../runtime/rate-limit.js";
import { BoundedWorkerLoop } from "../../runtime/worker.js";
import {
  ISOLATION_PROJECT_B_ID,
  seedDedicatedPostgresTestProject,
  seedIsolationProjectB,
} from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import {
  advanceToApprovedRun,
  advanceToAwaitingApproval,
  advanceToCompletedRun,
  deliveredNonce,
} from "./postgres-lifecycle-helpers.js";
import { PostgresLeaseStore } from "./leases.js";
import { ExecutionResourceLedger } from "../../execution/resource-ledger.js";
import { PostgresMigrationRunner } from "./migrate.js";
import { productionErrorEnvelope } from "../../runtime/perimeter.js";
import { wrapDatabaseError } from "./database.js";
import { loadRuntimeConfig } from "../../runtime/config.js";
import {
  copyPublicTables,
  createDisposableDatabase,
  dumpAndRestoreWithPgDump,
  pgDumpToolsAvailable,
} from "./backup-drill.js";
import type { PerimeterDeps } from "../../runtime/perimeter.js";
import { objectiveIdempotencyKey } from "../../domain/objective/idempotency.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

const CANONICAL_ADMISSION_OUTCOMES = new Set([
  "ADMITTED",
  "ACTIVE_DUPLICATE",
  "COMPLETED_DUPLICATE",
  "CONFLICT",
]);

const CANONICAL_CONTENTION_REASONS = new Set([
  "PROJECT_LOCK_CONFLICT",
  "ACTIVE_DUPLICATE",
  "COMPLETED_DUPLICATE",
  "IDEMPOTENCY_RESERVATION_FAILED",
  "OBJECTIVE_VERSION_CONFLICT",
]);

function admissionHttpView(
  response: { statusCode: number; json: () => Record<string, unknown> },
  request: { projectId: string; objectiveId: string },
) {
  const body = response.json();
  return {
    statusCode: response.statusCode,
    outcome: body["outcome"],
    error: body["error"],
    reasonCode: body["reasonCode"],
    runId: body["runId"],
    projectId: request.projectId,
    objectiveId: request.objectiveId,
    body,
  };
}

function expectCanonicalConcurrentAdmission(
  first: ReturnType<typeof admissionHttpView>,
  second: ReturnType<typeof admissionHttpView>,
): void {
  const pair = { first, second };
  for (const item of [first, second]) {
    expect(
      CANONICAL_ADMISSION_OUTCOMES.has(String(item.outcome)),
      `unexpected admission outcome ${JSON.stringify(pair)}`,
    ).toBe(true);
    if (item.outcome === "CONFLICT") {
      expect(
        CANONICAL_CONTENTION_REASONS.has(String(item.reasonCode)),
        `unexpected contention reason ${JSON.stringify(pair)}`,
      ).toBe(true);
    }
    expect([200, 201, 409]).toContain(item.statusCode);
  }
}

function perimeterFor(
  principalId: string,
  projectIds: string[],
  overrides: Partial<PerimeterDeps> = {},
): PerimeterDeps {
  return {
    authenticator: new FakeRequestAuthenticator({
      principalId,
      authenticationMode: "HEADER_PRINCIPAL",
    }),
    access: new InMemoryProjectAccessDirectory([
      { principalId, projectIds },
    ]),
    drain: new DrainController(),
    metrics: new OperationalMetrics(),
    logger: new MemoryStructuredLogger("pg12", () => undefined),
    rateLimiter: new SlidingWindowRateLimiter(100, 60_000),
    authenticationMode: "HEADER_PRINCIPAL",
    ...overrides,
  };
}

async function fullApi(
  stack: PostgresOrchestratorStack,
  perimeter: PerimeterDeps,
  extra: {
    drain?: DrainController;
    database?: () => Promise<{
      storageMode: "postgres";
      databaseReachable: boolean;
      schemaCompatible: boolean;
      supportedSchemaVersion: string;
    }>;
  } = {},
) {
  const drain = extra.drain ?? perimeter.drain;
  const startup = new StartupLifecycle();
  startup.advance("CONFIG_VALIDATED");
  startup.advance("SERVICES_READY");
  startup.advance("ACCEPTING_TRAFFIC");
  const config = loadRuntimeConfig({
    ORCHESTRATOR_ENV: "TEST",
    ORCHESTRATOR_STORAGE: "memory",
  });
  return buildServer({
    admission: stack.admission,
    ingestion: stack.ingestion,
    planning: stack.planning,
    validation: stack.validation,
    authorizationRouting: stack.authorizationRouting,
    humanAuthorization: stack.humanAuthorization,
    approvalExpiry: stack.approvalExpiry,
    authorizationReadiness: stack.authorizationReadiness,
    execution: stack.execution,
    executionReadiness: stack.executionReadiness,
    verification: stack.verification,
    verificationReadiness: stack.verificationReadiness,
    memory: stack.memory,
    observability: stack.observability,
    storageMode: "postgres",
    runs: stack.runs,
    perimeter: {
      ...perimeter,
      runs: stack.runs,
      approvalRequests: stack.approvalRequests,
    },
    health: {
      config,
      startup,
      drain,
      metrics: perimeter.metrics,
      build: config.build,
      database:
        extra.database ??
        (async () => ({
          storageMode: "postgres" as const,
          databaseReachable: true,
          schemaCompatible: true,
          supportedSchemaVersion: "011_phase16_scenario_intelligence",
        })),
    },
  });
}

async function persistRunningStep(input: {
  env: Awaited<ReturnType<typeof createTestStack>>;
  runId: string;
  instanceId: string;
  ttlSeconds: number;
}): Promise<{ coordinationKey: string; fenceToken: number; stepKey: string; attemptId: string }> {
  const attemptId = uniquePostgresTestId("p12_attempt");
  const stepKey = `${input.runId}:step_patch`;
  const leases = new PostgresLeaseStore(input.env.db, input.ttlSeconds);
  const coordinationKey = `execution:p12_${input.runId}`;
  const lease = await leases.acquire({
    coordinationKey,
    phase: "execution",
    ownerId: input.instanceId,
  });
  await input.env.stack.resourceLedgerStore.initialize({
    executionAttemptId: attemptId,
    runId: input.runId,
    projectId: EXAMPLE_PROJECT_ID,
    budget: EXAMPLE_BUDGET,
  });
  const ledger = await ExecutionResourceLedger.create({
    budget: EXAMPLE_BUDGET,
    runId: input.runId,
    projectId: EXAMPLE_PROJECT_ID,
    executionAttemptId: attemptId,
    store: input.env.stack.resourceLedgerStore,
  });
  await ledger.reserveDurationMs(30_000);
  const now = input.env.stack.clock.nowIso();
  await input.env.stack.stepExecutions.reserve({
    idempotencyKey: stepKey,
    runId: input.runId,
    executionAttemptId: attemptId,
    stepId: "step_patch",
    capabilityId: "CREATE_LOCAL_PATCH",
    actionType: "CREATE_LOCAL_PATCH",
    startedAt: now,
  });
  await input.env.stack.stepExecutions.markRunning(stepKey);
  const run = await input.env.stack.runs.getById(input.runId);
  if (run && run.state === "APPROVED") {
    await input.env.stack.runs.transition(
      run.runId,
      run.state,
      run.recordRevision,
      "EXECUTING",
      now,
    );
  }
  return {
    coordinationKey,
    fenceToken: lease.fenceToken,
    stepKey,
    attemptId,
  };
}

describe("Phase 12 PostgreSQL runtime acceptance", () => {
  it("two API stacks admit one logical run under duplicate posts", async () => {
    const envA = await createTestStack(uniquePostgresTestId("p12_api_a"));
    const envB = await createTestStack(uniquePostgresTestId("p12_api_b"));
    try {
      const projectId = `p12_dup_${uniquePostgresTestId("proj").replace(/-/g, "").slice(0, 12)}`;
      await seedDedicatedPostgresTestProject(envA.db, projectId);
      const appA = await buildServer({
        admission: envA.stack.admission,
        storageMode: "postgres",
        runs: envA.stack.runs,
        perimeter: {
          ...perimeterFor(EXAMPLE_REQUESTER_ID, [projectId]),
          runs: envA.stack.runs,
          approvalRequests: envA.stack.approvalRequests,
        },
      });
      const appB = await buildServer({
        admission: envB.stack.admission,
        storageMode: "postgres",
        runs: envB.stack.runs,
        perimeter: {
          ...perimeterFor(EXAMPLE_REQUESTER_ID, [projectId]),
          runs: envB.stack.runs,
          approvalRequests: envB.stack.approvalRequests,
        },
      });
      const request = buildPostgresTestAdmissionRequest({
        testName: "p12-dup",
        projectId,
      });
      const [firstRes, secondRes] = await Promise.all([
        appA.inject({ method: "POST", url: "/v1/runs", payload: request }),
        appB.inject({ method: "POST", url: "/v1/runs", payload: request }),
      ]);
      const first = admissionHttpView(firstRes, request);
      const second = admissionHttpView(secondRes, request);
      expectCanonicalConcurrentAdmission(first, second);
      const idempotencyKey = objectiveIdempotencyKey({
        projectId: request.projectId,
        objectiveId: request.objectiveId,
        objectiveVersion: request.objectiveVersion,
        requestedEnvironment: request.requestedEnvironment,
      });
      const rows = await envA.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM runs WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      expect(Number(rows.rows[0]?.c ?? 0)).toBe(1);
      const objectives = await envA.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
         FROM objectives
         WHERE project_id = $1 AND objective_id = $2 AND objective_version = $3`,
        [request.projectId, request.objectiveId, request.objectiveVersion],
      );
      expect(Number(objectives.rows[0]?.c ?? 0)).toBe(1);
      const runId = (first.runId ?? second.runId) as string | undefined;
      const persisted = await envA.db.query<{ run_id: string }>(
        `SELECT run_id FROM runs WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      expect(persisted.rows).toHaveLength(1);
      if (runId) {
        expect(persisted.rows[0]?.run_id).toBe(runId);
      }
      await appA.close();
      await appB.close();
    } finally {
      await envA.close();
      await envB.close();
    }
  });

  it("cross-project HTTP mutation is denied before domain change", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_iso"));
    try {
      await seedIsolationProjectB(env.db);
      const admitted = await env.stack.admission.admit(
        buildPostgresTestAdmissionRequest({
          testName: "p12-b",
          projectId: ISOLATION_PROJECT_B_ID,
        }),
      );
      expect(admitted.outcome).toBe("ADMITTED");
      const app = await buildServer({
        admission: env.stack.admission,
        ingestion: env.stack.ingestion,
        storageMode: "postgres",
        runs: env.stack.runs,
        perimeter: {
          ...perimeterFor(EXAMPLE_REQUESTER_ID, [EXAMPLE_PROJECT_ID]),
          runs: env.stack.runs,
          approvalRequests: env.stack.approvalRequests,
        },
      });
      const denied = await app.inject({
        method: "POST",
        url: `/v1/runs/${admitted.runId}/ingest`,
        payload: {
          projectId: ISOLATION_PROJECT_B_ID,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
        },
      });
      expect(denied.statusCode).toBe(403);
      const run = await env.stack.runs.getById(admitted.runId!);
      expect(run?.state).toBe("ADMITTED");
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("empty-heap stack reloads durable identities after process close", async () => {
    const envA = await createTestStack(uniquePostgresTestId("p12_heap_a"));
    try {
      const admitted = await envA.stack.admission.admit(
        buildPostgresTestAdmissionRequest({ testName: "p12-heap" }),
      );
      const runId = admitted.runId!;
      await envA.close();
      const envB = await createTestStack(uniquePostgresTestId("p12_heap_b"));
      try {
        const run = await envB.stack.runs.getById(runId);
        expect(run?.runId).toBe(runId);
        expect(run?.projectId).toBe(EXAMPLE_PROJECT_ID);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("readiness is false when draining", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_drain"));
    try {
      const drain = new DrainController();
      const startup = new StartupLifecycle();
      startup.advance("CONFIG_VALIDATED");
      startup.advance("SERVICES_READY");
      startup.advance("ACCEPTING_TRAFFIC");
      const config = loadRuntimeConfig({
        ORCHESTRATOR_ENV: "TEST",
        ORCHESTRATOR_STORAGE: "memory",
      });
      const app = await buildServer({
        storageMode: "postgres",
        health: {
          config,
          startup,
          drain,
          metrics: new OperationalMetrics(),
          build: config.build,
          database: async () => ({
            storageMode: "postgres",
            databaseReachable: true,
            schemaCompatible: true,
            supportedSchemaVersion: "011_phase16_scenario_intelligence",
          }),
        },
      });
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      drain.beginDrain();
      const draining = await app.inject({ method: "GET", url: "/health/ready" });
      expect(draining.statusCode).toBe(503);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("approval-decision project binding denies cross-project principals before domain mutation", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_appr_bind"));
    try {
      await seedIsolationProjectB(env.db);
      const pending = await advanceToAwaitingApproval(
        env.stack,
        buildPostgresTestAdmissionRequest({
          testName: "p12-appr-b",
          projectId: ISOLATION_PROJECT_B_ID,
        }),
      );
      const nonce = deliveredNonce(
        env.stack.approvalDelivery,
        pending.approvalRequestId,
      );
      const app = await fullApi(
        env.stack,
        perimeterFor("principal_project_a", [EXAMPLE_PROJECT_ID]),
      );
      const denied = await app.inject({
        method: "POST",
        url: `/v1/approval-requests/${pending.approvalRequestId}/decision`,
        payload: {
          approverId: "approver_bootstrap",
          decision: "APPROVE",
          decisionNonce: nonce,
          submittedAt: new Date().toISOString(),
          projectId: EXAMPLE_PROJECT_ID,
          runId: pending.runId,
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("PROJECT_ACCESS_DENIED");
      const request = await env.stack.approvalRequests.getById(
        pending.approvalRequestId,
      );
      expect(request?.status).toBe("PENDING");
      const records = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'authorization_records' AND run_id = $1`,
        [pending.runId],
      );
      expect(Number(records.rows[0]?.c ?? 0)).toBe(0);
      const nonceRow = await env.db.query<{ status: string }>(
        `SELECT status FROM nonce_state WHERE approval_request_id = $1`,
        [pending.approvalRequestId],
      );
      expect(nonceRow.rows[0]?.status).toBe("PENDING");
      const run = await env.stack.runs.getById(pending.runId);
      expect(run?.state).toBe("AWAITING_APPROVAL");
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("project member without approver authority fails at the approver gate", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_appr_gate"));
    try {
      await seedIsolationProjectB(env.db);
      const pending = await advanceToAwaitingApproval(
        env.stack,
        buildPostgresTestAdmissionRequest({
          testName: "p12-appr-gate",
          projectId: ISOLATION_PROJECT_B_ID,
        }),
      );
      const nonce = deliveredNonce(
        env.stack.approvalDelivery,
        pending.approvalRequestId,
      );
      const app = await fullApi(
        env.stack,
        perimeterFor(EXAMPLE_REQUESTER_ID, [ISOLATION_PROJECT_B_ID]),
      );
      const denied = await app.inject({
        method: "POST",
        url: `/v1/approval-requests/${pending.approvalRequestId}/decision`,
        payload: {
          approverId: EXAMPLE_REQUESTER_ID,
          decision: "APPROVE",
          decisionNonce: nonce,
          submittedAt: new Date().toISOString(),
        },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("UNKNOWN_APPROVER");
      const request = await env.stack.approvalRequests.getById(
        pending.approvalRequestId,
      );
      expect(request?.status).toBe("PENDING");
      const records = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'authorization_records' AND run_id = $1`,
        [pending.runId],
      );
      expect(Number(records.rows[0]?.c ?? 0)).toBe(0);
      const run = await env.stack.runs.getById(pending.runId);
      expect(run?.state).toBe("AWAITING_APPROVAL");
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("request auth matrix covers anonymous, project, run-id, and approver paths", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_auth_matrix"));
    try {
      const access = new InMemoryProjectAccessDirectory([
        { principalId: "user_ok", projectIds: [EXAMPLE_PROJECT_ID] },
        { principalId: "user_other", projectIds: ["other-project"] },
      ]);
      const drain = new DrainController();
      const app = await fullApi(env.stack, {
        authenticator: new HeaderRequestAuthenticator(),
        access,
        drain,
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("pg12", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(100, 60_000),
        authenticationMode: "HEADER_PRINCIPAL",
      });
      const anonymous = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-anon" }),
      });
      expect(anonymous.statusCode).toBe(401);
      const noProject = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { "x-orchestrator-principal": "user_other" },
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-noproj" }),
      });
      expect(noProject.statusCode).toBe(403);
      const admitted = await app.inject({
        method: "POST",
        url: "/v1/runs",
        headers: { "x-orchestrator-principal": "user_ok" },
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-ok" }),
      });
      expect(admitted.statusCode).toBe(201);
      const runId = admitted.json().runId as string;
      const ingestDenied = await app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/ingest`,
        headers: { "x-orchestrator-principal": "user_other" },
        payload: { requestedEnvironment: EXAMPLE_ENVIRONMENT },
      });
      expect(ingestDenied.statusCode).toBe(403);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("rate limiting does not create runs, consume nonces, or start execution", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_rate"));
    try {
      let now = 1_000;
      const limiter = new SlidingWindowRateLimiter(1, 60_000, () => now);
      const pending = await advanceToAwaitingApproval(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "p12-rate-appr" }),
      );
      const nonce = deliveredNonce(
        env.stack.approvalDelivery,
        pending.approvalRequestId,
      );
      const app = await fullApi(
        env.stack,
        perimeterFor(EXAMPLE_REQUESTER_ID, [EXAMPLE_PROJECT_ID], {
          rateLimiter: limiter,
        }),
      );
      const first = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-rate-1" }),
      });
      expect(first.statusCode).toBe(201);
      const blockedAdmit = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-rate-2" }),
      });
      expect(blockedAdmit.statusCode).toBe(429);
      const missing = await env.stack.runs.getById(
        (blockedAdmit.json().runId as string | undefined) ?? "missing",
      );
      expect(missing).toBeNull();
      const blockedDecision = await app.inject({
        method: "POST",
        url: `/v1/approval-requests/${pending.approvalRequestId}/decision`,
        payload: {
          approverId: "approver_bootstrap",
          decision: "APPROVE",
          decisionNonce: nonce,
          submittedAt: new Date().toISOString(),
        },
      });
      expect(blockedDecision.statusCode).toBe(429);
      const nonceRow = await env.db.query<{ status: string }>(
        `SELECT status FROM nonce_state WHERE approval_request_id = $1`,
        [pending.approvalRequestId],
      );
      expect(nonceRow.rows[0]?.status).toBe("PENDING");
      const attempts = await env.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'execution_attempts' AND run_id = $1`,
        [pending.runId],
      );
      expect(Number(attempts.rows[0]?.c ?? 0)).toBe(0);
      now = 1_000 + 60_001;
      const afterWindow = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-rate-3" }),
      });
      expect(afterWindow.statusCode).toBe(201);
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("database outage fails closed without memory fallback, then readiness returns", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_db_outage"));
    try {
      const admitted = await env.stack.admission.admit(
        buildPostgresTestAdmissionRequest({ testName: "p12-outage" }),
      );
      const runId = admitted.runId!;
      let reachable = true;
      const drain = new DrainController();
      const metrics = new OperationalMetrics();
      const worker = new BoundedWorkerLoop({
        concurrency: 1,
        pollIntervalMs: 15,
        jitterMs: 0,
        isAccepting: () => drain.isAcceptingWork() && reachable,
        jobs: [{ name: "probe", run: async () => undefined }],
      });
      worker.start();
      const app = await fullApi(
        env.stack,
        perimeterFor(EXAMPLE_REQUESTER_ID, [EXAMPLE_PROJECT_ID], {
          drain,
          metrics,
          databaseAvailable: async () => reachable,
        }),
        {
          drain,
          database: async () => ({
            storageMode: "postgres",
            databaseReachable: reachable,
            schemaCompatible: reachable,
            supportedSchemaVersion: "011_phase16_scenario_intelligence",
          }),
        },
      );
      reachable = false;
      const live = await app.inject({ method: "GET", url: "/health/live" });
      expect(live.statusCode).toBe(200);
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      const mutation = await app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/ingest`,
        payload: { requestedEnvironment: EXAMPLE_ENVIRONMENT },
      });
      expect(mutation.statusCode).toBe(503);
      expect(mutation.json().error).toBe("DATABASE_UNAVAILABLE");
      await sleep(40);
      const claimsDuringOutage = worker.claims;
      await sleep(40);
      expect(worker.claims).toBe(claimsDuringOutage);
      expect(env.stack.storageMode).toBe("postgres");
      const run = await env.stack.runs.getById(runId);
      expect(run?.state).toBe("ADMITTED");
      reachable = true;
      const recovered = await app.inject({ method: "GET", url: "/health/ready" });
      expect(recovered.statusCode).toBe(200);
      worker.stop();
      await app.close();
    } finally {
      await env.close();
    }
  });

  it("multi-node API+worker lifecycle reloads exact durable authority on empty heap", async () => {
    const projectId = `p12_mn_${uniquePostgresTestId("proj").slice(0, 12)}`;
    const apiA = await createTestStack(uniquePostgresTestId("p12_mn_api_a"));
    const apiB = await createTestStack(uniquePostgresTestId("p12_mn_api_b"));
    const workerA = await createTestStack(uniquePostgresTestId("p12_mn_w_a"));
    const workerB = await createTestStack(uniquePostgresTestId("p12_mn_w_b"));
    try {
      await seedDedicatedPostgresTestProject(apiA.db, projectId);
      const appA = await fullApi(
        apiA.stack,
        perimeterFor(EXAMPLE_REQUESTER_ID, [projectId]),
      );
      const appB = await fullApi(
        apiB.stack,
        perimeterFor(EXAMPLE_REQUESTER_ID, [projectId]),
      );
      const request = buildPostgresTestAdmissionRequest({
        testName: "p12-mn",
        projectId,
        learnable: true,
      });
      const [firstRes, secondRes] = await Promise.all([
        appA.inject({ method: "POST", url: "/v1/runs", payload: request }),
        appB.inject({ method: "POST", url: "/v1/runs", payload: request }),
      ]);
      const first = admissionHttpView(firstRes, request);
      const second = admissionHttpView(secondRes, request);
      expectCanonicalConcurrentAdmission(first, second);
      const idempotencyKey = objectiveIdempotencyKey({
        projectId: request.projectId,
        objectiveId: request.objectiveId,
        objectiveVersion: request.objectiveVersion,
        requestedEnvironment: request.requestedEnvironment,
      });
      const runRows = await apiA.db.query<{ run_id: string }>(
        `SELECT run_id FROM runs WHERE idempotency_key = $1`,
        [idempotencyKey],
      );
      expect(runRows.rows).toHaveLength(1);
      const objectives = await apiA.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c
         FROM objectives
         WHERE project_id = $1 AND objective_id = $2 AND objective_version = $3`,
        [request.projectId, request.objectiveId, request.objectiveVersion],
      );
      expect(Number(objectives.rows[0]?.c ?? 0)).toBe(1);
      const runId = runRows.rows[0]!.run_id;
      await workerA.stack.ingestion.ingest(runId, projectId, EXAMPLE_ENVIRONMENT);
      await workerA.stack.planning.plan(runId);
      await workerA.stack.validation.validate(runId);
      const routed = await workerA.stack.authorizationRouting.route(runId);
      expect(routed.outcome).toBe("PENDING_APPROVAL");
      const nonce = deliveredNonce(
        workerA.stack.approvalDelivery,
        routed.approvalRequestId,
      );
      const approved = await workerA.stack.humanAuthorization.decide({
        approvalRequestId: routed.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: nonce,
        submittedAt: new Date().toISOString(),
      });
      expect(approved.result).toBe("APPROVED");
      const [execA, execB] = await Promise.allSettled([
        workerA.stack.execution.execute(runId),
        workerB.stack.execution.execute(runId),
      ]);
      const execResults = [execA, execB];
      const successes = execResults.filter((item) => item.status === "fulfilled");
      expect(successes.length).toBeGreaterThanOrEqual(1);
      await workerA.stack.verification.verify(runId);
      const learned = await workerA.stack.memory.learn(runId);
      expect(learned.promotedPrecedentIds.length).toBeGreaterThan(0);
      expect(new Set(learned.promotedPrecedentIds).size).toBe(
        learned.promotedPrecedentIds.length,
      );
      const completions = await apiA.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'completion_records' AND run_id = $1`,
        [runId],
      );
      expect(Number(completions.rows[0]?.c ?? 0)).toBe(1);
      const attempts = await apiA.db.query(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'execution_attempts' AND run_id = $1`,
        [runId],
      );
      expect(Number(attempts.rows[0]?.c ?? 0)).toBe(1);
      const snapshot = await workerA.stack.observability.rebuild(projectId, {
        projectId,
        kind: "LAST_N_RUNS",
        lastN: 5,
      });
      await appA.close();
      await appB.close();
      await apiA.close();
      await apiB.close();
      await workerA.close();
      await workerB.close();
      const reload = await createTestStack(uniquePostgresTestId("p12_mn_reload"));
      try {
        const run = await reload.stack.runs.getById(runId);
        expect(run?.state).toBe("COMPLETED");
        const auth = await reload.db.query<{ document_id: string }>(
          `SELECT document_id FROM json_documents
           WHERE collection = 'authorization_records' AND run_id = $1`,
          [runId],
        );
        expect(auth.rows.length).toBe(1);
        const completion = await reload.db.query(
          `SELECT 1 FROM json_documents
           WHERE collection = 'completion_records' AND run_id = $1`,
          [runId],
        );
        expect(completion.rows.length).toBe(1);
        const health = await reload.stack.observability.snapshots.getById(
          snapshot.healthSnapshotId,
        );
        expect(health?.snapshotId).toBe(snapshot.healthSnapshotId);
        for (const precedentId of learned.promotedPrecedentIds) {
          const precedent = await reload.stack.memory.getPrecedent(precedentId);
          expect(precedent?.precedentId).toBe(precedentId);
        }
      } finally {
        await reload.close();
      }
    } finally {
      await apiA.close().catch(() => undefined);
      await apiB.close().catch(() => undefined);
      await workerA.close().catch(() => undefined);
      await workerB.close().catch(() => undefined);
    }
  });

  it("SIGTERM drain leaves RUNNING steps unrepaired for Phase 11 containment", async () => {
    const instanceA = uniquePostgresTestId("p12_sig_a");
    const envA = await createTestStack(instanceA);
    try {
      const request = buildPostgresTestAdmissionRequest({ testName: "p12-sig" });
      const { runId } = await advanceToApprovedRun(envA.stack, request);
      const drain = new DrainController();
      const metrics = new OperationalMetrics();
      let extraClaims = 0;
      const loop = new BoundedWorkerLoop({
        concurrency: 1,
        pollIntervalMs: 15,
        jitterMs: 0,
        isAccepting: () => drain.isAcceptingWork(),
        jobs: [
          {
            name: "work",
            run: async () => {
              extraClaims += 1;
            },
          },
        ],
      });
      loop.start();
      await sleep(30);
      const persisted = await persistRunningStep({
        env: envA,
        runId,
        instanceId: instanceA,
        ttlSeconds: 2,
      });
      expect(envA.stack.actuator.invocations.length).toBe(0);
      const startup = new StartupLifecycle();
      startup.advance("CONFIG_VALIDATED");
      startup.advance("SERVICES_READY");
      startup.advance("ACCEPTING_TRAFFIC");
      const config = loadRuntimeConfig({
        ORCHESTRATOR_ENV: "TEST",
        ORCHESTRATOR_STORAGE: "memory",
        ORCHESTRATOR_SHUTDOWN_GRACE_MS: "50",
      });
      const app = await buildServer({
        admission: envA.stack.admission,
        storageMode: "postgres",
        runs: envA.stack.runs,
        perimeter: {
          ...perimeterFor(EXAMPLE_REQUESTER_ID, [EXAMPLE_PROJECT_ID], { drain }),
          runs: envA.stack.runs,
          approvalRequests: envA.stack.approvalRequests,
        },
        health: {
          config,
          startup,
          drain,
          metrics,
          build: config.build,
          database: async () => ({
            storageMode: "postgres",
            databaseReachable: true,
            schemaCompatible: true,
            supportedSchemaVersion: "011_phase16_scenario_intelligence",
          }),
        },
      });
      const ready = await app.inject({ method: "GET", url: "/health/ready" });
      expect(ready.statusCode).toBe(200);
      const claimsBefore = extraClaims;
      drain.beginDrain();
      expect(drain.current()).toBe("DRAINING");
      const notReady = await app.inject({ method: "GET", url: "/health/ready" });
      expect(notReady.statusCode).toBe(503);
      const denied = await app.inject({
        method: "POST",
        url: "/v1/runs",
        payload: buildPostgresTestAdmissionRequest({ testName: "p12-sig-deny" }),
      });
      expect(denied.statusCode).toBe(503);
      await loop.waitIdle(50);
      loop.stop();
      expect(extraClaims).toBeLessThanOrEqual(claimsBefore + 1);
      const step = await envA.stack.stepExecutions.getByIdempotencyKey(
        persisted.stepKey,
      );
      expect(step?.status).toBe("RUNNING");
      await app.close();
      await envA.close();
      const envB = await createTestStack(uniquePostgresTestId("p12_sig_b"));
      try {
        await waitUntilPostgresLeaseExpired(envB.db, persisted.coordinationKey);
        expect(envB.stack.actuator.invocations.length).toBe(0);
        const reloaded = await envB.stack.stepExecutions.getByIdempotencyKey(
          persisted.stepKey,
        );
        expect(reloaded?.status).toBe("RUNNING");
        const leasesB = new PostgresLeaseStore(envB.db, 30);
        const leaseB = await leasesB.acquire({
          coordinationKey: persisted.coordinationKey,
          phase: "execution",
          ownerId: envB.stack.instanceId,
        });
        expect(leaseB.fenceToken).toBeGreaterThan(persisted.fenceToken);
        await expect(
          leasesB.heartbeat({
            coordinationKey: persisted.coordinationKey,
            ownerId: instanceA,
            fenceToken: persisted.fenceToken,
          }),
        ).rejects.toMatchObject({ code: "LEASE_OWNERSHIP_LOST" });
        envB.stack.actuator.simulateStateUnknown = true;
        await envB.stack.recovery.recover();
        expect(envB.stack.actuator.invocations.length).toBe(0);
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("hard-kill runtime recovers through a newer fence without blind replay", async () => {
    const instanceA = uniquePostgresTestId("p12_kill_a");
    const envA = await createTestStack(instanceA);
    try {
      const { runId } = await advanceToApprovedRun(
        envA.stack,
        buildPostgresTestAdmissionRequest({ testName: "p12-kill" }),
      );
      const loop = new BoundedWorkerLoop({
        concurrency: 1,
        pollIntervalMs: 20,
        jitterMs: 0,
        isAccepting: () => true,
        jobs: [
          {
            name: "outbox",
            run: async () => {
              await envA.stack.approvalDeliveryDispatcher.dispatchOnce(1);
            },
          },
        ],
      });
      loop.start();
      const persisted = await persistRunningStep({
        env: envA,
        runId,
        instanceId: instanceA,
        ttlSeconds: 2,
      });
      loop.stop();
      await envA.close();
      const envB = await createTestStack(uniquePostgresTestId("p12_kill_b"));
      try {
        await waitUntilPostgresLeaseExpired(envB.db, persisted.coordinationKey);
        const workerB = new BoundedWorkerLoop({
          concurrency: 1,
          pollIntervalMs: 20,
          jitterMs: 0,
          isAccepting: () => true,
          jobs: [
            {
              name: "outbox",
              run: async () => {
                await envB.stack.approvalDeliveryDispatcher.dispatchOnce(1);
              },
            },
          ],
        });
        workerB.start();
        const leasesB = new PostgresLeaseStore(envB.db, 30);
        const leaseB = await leasesB.acquire({
          coordinationKey: persisted.coordinationKey,
          phase: "execution",
          ownerId: envB.stack.instanceId,
        });
        expect(leaseB.fenceToken).toBeGreaterThan(persisted.fenceToken);
        expect(envB.stack.actuator.invocations.length).toBe(0);
        const step = await envB.stack.stepExecutions.getByIdempotencyKey(
          persisted.stepKey,
        );
        expect(step?.status).toBe("RUNNING");
        await envB.stack.recovery.recover();
        expect(envB.stack.actuator.invocations.length).toBe(0);
        workerB.stop();
      } finally {
        await envB.close();
      }
    } finally {
      await envA.close().catch(() => undefined);
    }
  });

  it("two worker runtimes fence the same outbox message", async () => {
    const envA = await createTestStack(uniquePostgresTestId("p12_ob_a"));
    const envB = await createTestStack(uniquePostgresTestId("p12_ob_b"));
    try {
      const outboxId = uniquePostgresTestId("p12_ob_msg");
      await envA.stack.outbox.enqueue({
        outboxId,
        aggregateType: "phase12",
        aggregateId: outboxId,
        eventType: "PHASE12_PROBE",
        payload: { kind: "AT_LEAST_ONCE" },
      });
      const [claimedA, claimedB] = await Promise.all([
        envA.stack.outbox.claimBatch({
          ownerId: envA.stack.instanceId,
          limit: 8,
          leaseSeconds: 2,
        }),
        envB.stack.outbox.claimBatch({
          ownerId: envB.stack.instanceId,
          limit: 8,
          leaseSeconds: 2,
        }),
      ]);
      const hits = [...claimedA, ...claimedB].filter(
        (message) => message.outboxId === outboxId,
      );
      expect(hits.length).toBe(1);
      const owner = hits[0]!;
      await waitUntilPostgresOutboxLeaseExpired(envA.db, outboxId);
      const next = await envB.stack.outbox.claimBatch({
        ownerId: envB.stack.instanceId,
        limit: 8,
        leaseSeconds: 30,
      });
      const newer = next.find((message) => message.outboxId === outboxId);
      expect(newer).toBeTruthy();
      expect(newer!.fenceToken).toBeGreaterThan(owner.fenceToken ?? 0);
      await expect(
        envA.stack.outbox.markDelivered(
          outboxId,
          owner.leaseOwnerId ?? envA.stack.instanceId,
          owner.fenceToken ?? 0,
        ),
      ).rejects.toMatchObject({ code: "OUTBOX_DELIVERY_FAILED" });
      const inboxKey = `${outboxId}:probe`;
      const first = await envA.stack.inbox.receive({
        messageId: inboxKey,
        consumerName: "approval-delivery",
        payload: { outboxId },
      });
      expect(first.duplicate).toBe(false);
      await envA.stack.inbox.complete({
        messageId: inboxKey,
        consumerName: "approval-delivery",
        resultFingerprint: "phase12-probe",
      });
      const second = await envB.stack.inbox.receive({
        messageId: inboxKey,
        consumerName: "approval-delivery",
        payload: { outboxId },
      });
      expect(second.duplicate).toBe(true);
    } finally {
      await envA.close();
      await envB.close();
    }
  });

  it("worker backpressure caps active claims without mutating remaining work", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_bp"));
    try {
      const eligible = 5;
      for (let index = 0; index < eligible; index += 1) {
        await env.stack.outbox.enqueue({
          outboxId: uniquePostgresTestId(`p12_bp_${index}`),
          aggregateType: "phase12",
          aggregateId: `bp-${index}`,
          eventType: "PHASE12_PROBE",
          payload: { index },
        });
      }
      const metrics = new OperationalMetrics();
      let maxActive = 0;
      const loop = new BoundedWorkerLoop({
        concurrency: 2,
        pollIntervalMs: 10,
        jitterMs: 0,
        isAccepting: () => true,
        jobs: [
          {
            name: "claim",
            run: async () => {
              maxActive = Math.max(maxActive, loop.active);
              await env.stack.outbox.claimBatch({
                ownerId: env.stack.instanceId,
                limit: 1,
                leaseSeconds: 5,
              });
              await sleep(25);
            },
          },
        ],
        onConflict: () => metrics.increment("worker_claim_conflicts"),
      });
      loop.start();
      await sleep(80);
      loop.stop();
      metrics.increment("active_workers", loop.active);
      metrics.increment("backpressure", loop.skippedBackpressure);
      expect(maxActive).toBeLessThanOrEqual(2);
      expect(loop.skippedBackpressure).toBeGreaterThan(0);
      const pending = await env.stack.outbox.countPending();
      expect(pending).toBeGreaterThan(0);
      expect(metrics.snapshot().counters["backpressure"]).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  });

  it("concurrent migrate is lock-safe and checksum drift is rejected", async () => {
    const [dbA, dbB] = await Promise.all([
      createTestDatabase(uniquePostgresTestId("p12_mig_a")),
      createTestDatabase(uniquePostgresTestId("p12_mig_b")),
    ]);
    try {
      const runnerA = new PostgresMigrationRunner(dbA);
      const runnerB = new PostgresMigrationRunner(dbB);
      await Promise.all([runnerA.assertCompatible(), runnerB.assertCompatible()]);
      const applied = await dbA.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM schema_migrations`,
      );
      const appliedB = await dbB.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM schema_migrations`,
      );
      expect(Number(applied.rows[0]?.c)).toBe(Number(appliedB.rows[0]?.c));
      const latest = await dbA.query<{ version: string; checksum: string }>(
        `SELECT version, checksum FROM schema_migrations ORDER BY version DESC LIMIT 1`,
      );
      const row = latest.rows[0]!;
      await dbA.query(
        `UPDATE schema_migrations SET checksum = $2 WHERE version = $1`,
        [row.version, "0".repeat(64)],
      );
      await expect(runnerA.migrate()).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_INCOMPATIBLE",
      });
      await expect(runnerA.assertCompatible()).rejects.toMatchObject({
        code: "DATABASE_SCHEMA_INCOMPATIBLE",
      });
      await dbA.query(
        `UPDATE schema_migrations SET checksum = $2 WHERE version = $1`,
        [row.version, row.checksum],
      );
    } finally {
      await dbA.close();
      await dbB.close();
    }
  });

  it("graceful drain stops claims and shuts down within the grace period", async () => {
    const drain = new DrainController();
    expect(drain.current()).toBe("RUNNING");
    let inFlightFinished = false;
    const loop = new BoundedWorkerLoop({
      concurrency: 1,
      pollIntervalMs: 10,
      jitterMs: 0,
      isAccepting: () => drain.isAcceptingWork(),
      jobs: [
        {
          name: "safe",
          run: async () => {
            await sleep(20);
            inFlightFinished = true;
          },
        },
      ],
    });
    loop.start();
    await sleep(15);
    const started = Date.now();
    drain.beginDrain();
    expect(drain.current()).toBe("DRAINING");
    await loop.waitIdle(80);
    loop.stop();
    drain.stop();
    expect(drain.current()).toBe("STOPPED");
    expect(inFlightFinished).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("backup/restore into a disposable database recovers authority on an empty heap", async () => {
    const source = await createDisposableDatabase(
      `p12src${uniquePostgresTestId("d").replace(/-/g, "").slice(0, 10)}`,
    );
    const dest = await createDisposableDatabase(
      `p12dst${uniquePostgresTestId("d").replace(/-/g, "").slice(0, 10)}`,
    );
    const sourceEnv = await createTestStackOnUrl(
      uniquePostgresTestId("p12_bak_src"),
      source.url,
    );
    try {
      const projectId = `p12_bak_${uniquePostgresTestId("p").slice(0, 10)}`;
      await seedDedicatedPostgresTestProject(sourceEnv.db, projectId);
      const ctx = await advanceToCompletedRun(
        sourceEnv.stack,
        buildPostgresTestAdmissionRequest({
          testName: "p12-backup",
          projectId,
          learnable: true,
        }),
      );
      const learned = await sourceEnv.stack.memory.learn(ctx.runId);
      const snapshot = await sourceEnv.stack.observability.rebuild(projectId, {
        projectId,
        kind: "LAST_N_RUNS",
        lastN: 5,
      });
      const auth = await sourceEnv.db.query<{ document_id: string }>(
        `SELECT document_id FROM json_documents
         WHERE collection = 'authorization_records' AND run_id = $1`,
        [ctx.runId],
      );
      const blob = await sourceEnv.db.query<{ content_hash: string }>(
        `SELECT content_hash FROM artifact_blobs LIMIT 1`,
      );
      await sourceEnv.close();
      if (pgDumpToolsAvailable()) {
        dumpAndRestoreWithPgDump(source.url, dest.url);
      } else {
        const destEnvMigrate = await createTestStackOnUrl(
          uniquePostgresTestId("p12_bak_mig"),
          dest.url,
        );
        await destEnvMigrate.close();
        const sourceCopy = await createTestStackOnUrl(
          uniquePostgresTestId("p12_bak_copy_src"),
          source.url,
          { migrate: false },
        );
        const destCopy = await createTestStackOnUrl(
          uniquePostgresTestId("p12_bak_copy_dst"),
          dest.url,
          { migrate: false },
        );
        try {
          await copyPublicTables(sourceCopy.db, destCopy.db);
        } finally {
          await sourceCopy.close();
          await destCopy.close();
        }
      }
      const restored = await createTestStackOnUrl(
        uniquePostgresTestId("p12_bak_rst"),
        dest.url,
        { migrate: pgDumpToolsAvailable() ? false : true },
      );
      try {
        const run = await restored.stack.runs.getById(ctx.runId);
        expect(run?.runId).toBe(ctx.runId);
        expect(run?.state).toBe("COMPLETED");
        const restoredAuth = await restored.db.query<{ document_id: string }>(
          `SELECT document_id FROM json_documents
           WHERE collection = 'authorization_records' AND run_id = $1`,
          [ctx.runId],
        );
        expect(restoredAuth.rows[0]?.document_id).toBe(auth.rows[0]?.document_id);
        const completion = await restored.db.query(
          `SELECT 1 FROM json_documents
           WHERE collection = 'completion_records' AND run_id = $1`,
          [ctx.runId],
        );
        expect(completion.rows.length).toBe(1);
        if (blob.rows[0]?.content_hash) {
          const restoredBlob = await restored.db.query<{ content_hash: string }>(
            `SELECT content_hash FROM artifact_blobs WHERE content_hash = $1`,
            [blob.rows[0].content_hash],
          );
          expect(restoredBlob.rows[0]?.content_hash).toBe(blob.rows[0].content_hash);
        }
        if (learned.promotedPrecedentIds[0]) {
          const precedent = await restored.stack.memory.getPrecedent(
            learned.promotedPrecedentIds[0],
          );
          expect(precedent?.precedentHash).toBeTruthy();
        }
        const health = await restored.stack.observability.snapshots.getById(
          snapshot.healthSnapshotId,
        );
        expect(health?.snapshotId).toBe(snapshot.healthSnapshotId);
      } finally {
        await restored.close();
      }
    } finally {
      await sourceEnv.close().catch(() => undefined);
      await dest.drop();
      await source.drop();
    }
  });

  it("redaction strips sentinels from envelopes and database errors", async () => {
    const env = await createTestStack(uniquePostgresTestId("p12_redact"));
    try {
      const logger = new MemoryStructuredLogger("pg12", () => undefined);
      const envelope = productionErrorEnvelope(
        "req_1",
        "UNAUTHENTICATED",
        "auth failed TEST_API_KEY_SENTINEL nonce=TEST_APPROVAL_NONCE_SENTINEL",
      );
      logger.log({
        level: "error",
        operation: "startup",
        result: "failed",
        message:
          "postgres://orchestrator:TEST_DB_PASSWORD_SENTINEL@127.0.0.1/db delivery=TEST_DELIVERY_KEY_SENTINEL",
      });
      logger.log({
        level: "error",
        operation: "auth",
        result: "failed",
        message: envelope.message,
      });
      const wrapped = wrapDatabaseError(
        new Error("password authentication failed TEST_DB_PASSWORD_SENTINEL"),
      );
      logger.log({
        level: "error",
        operation: "db",
        result: "failed",
        message: wrapped.message,
      });
      const joined = `${logger.lines().join("\n")}\n${JSON.stringify(envelope)}\n${wrapped.message}`;
      expect(joined).not.toContain("TEST_DB_PASSWORD_SENTINEL");
      expect(joined).not.toContain("TEST_API_KEY_SENTINEL");
      expect(joined).not.toContain("TEST_APPROVAL_NONCE_SENTINEL");
      expect(joined).not.toContain("TEST_DELIVERY_KEY_SENTINEL");
    } finally {
      await env.close();
    }
  });
});
