import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalObservabilityStack } from "../infrastructure/observability/local-stack.js";
import { controlTowerFromStack } from "./control-tower-factory.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { FakeRequestAuthenticator } from "../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../runtime/access.js";
import { DrainController } from "../runtime/startup.js";
import { OperationalMetrics } from "../runtime/metrics.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../runtime/rate-limit.js";
import { loadRuntimeConfig } from "../runtime/config.js";
import { sanitizeApprovalRequest, sanitizeNestedValue } from "../control-tower/sanitizers.js";
import type { ApprovalRequest } from "../domain/authorization/index.js";

function perimeter(principalId: string, projectIds: readonly string[]) {
  return {
    authenticator: new FakeRequestAuthenticator({
      principalId,
      authenticationMode: "HEADER_PRINCIPAL" as const,
    }),
    access: new InMemoryProjectAccessDirectory([
      { principalId, projectIds },
    ]),
    drain: new DrainController(),
    metrics: new OperationalMetrics(),
    logger: new MemoryStructuredLogger("ct_security", () => undefined),
    rateLimiter: new SlidingWindowRateLimiter(60, 60_000),
    authenticationMode: "HEADER_PRINCIPAL" as const,
  };
}

async function advanceToAwaiting(app: Awaited<ReturnType<typeof buildServer>>) {
  const admitted = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: exampleAdmissionRequest({
      objectiveId: `obj_ct_sec_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    }),
  });
  expect(admitted.statusCode).toBe(201);
  const runId = admitted.json().runId as string;
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/ingest`,
        payload: {
          projectId: EXAMPLE_PROJECT_ID,
          requestedEnvironment: EXAMPLE_ENVIRONMENT,
        },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: "POST", url: `/v1/runs/${runId}/plan` }))
      .statusCode,
  ).toBe(200);
  expect(
    (await app.inject({ method: "POST", url: `/v1/runs/${runId}/validate` }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/v1/runs/${runId}/authorization-route`,
      })
    ).statusCode,
  ).toBe(200);
  return runId;
}

describe("Control Tower security boundary", () => {
  it("A: production rejects header-only principal authentication", () => {
    expect(() =>
      loadRuntimeConfig({
        ORCHESTRATOR_ENV: "PRODUCTION",
        ORCHESTRATOR_STORAGE: "postgres",
        DATABASE_URL: "postgres://orchestrator:secret@127.0.0.1:5432/orchestrator",
        ORCHESTRATOR_AUTH_MODE: "HEADER_PRINCIPAL",
        APPROVAL_DELIVERY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
        ORCHESTRATOR_DEBUG: "false",
        ORCHESTRATOR_WORKER_CONCURRENCY: "4",
      }),
    ).toThrow(/HEADER_PRINCIPAL|x-orchestrator-principal/i);
  });

  it("B: development may use configured header principal", () => {
    const config = loadRuntimeConfig({
      ORCHESTRATOR_ENV: "DEVELOPMENT",
      ORCHESTRATOR_STORAGE: "memory",
      ORCHESTRATOR_AUTH_MODE: "HEADER_PRINCIPAL",
    });
    expect(config.authenticationMode).toBe("HEADER_PRINCIPAL");
  });

  it("C: production composition does not expose local-delivery nonce endpoint", async () => {
    const stack = createLocalObservabilityStack();
    const access = new InMemoryProjectAccessDirectory([
      { principalId: "user_local", projectIds: [EXAMPLE_PROJECT_ID] },
    ]);
    const app = await buildServer({
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
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access,
        authenticationMode: "STATIC_PRINCIPAL",
        runtimeEnvironment: "PRODUCTION",
        allowLocalDelivery: false,
      },
      perimeter: {
        authenticator: new FakeRequestAuthenticator({
          principalId: "user_local",
          authenticationMode: "STATIC_PRINCIPAL",
        }),
        access,
        drain: new DrainController(),
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("ct_prod", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(60, 60_000),
        authenticationMode: "STATIC_PRINCIPAL",
        runs: stack.runs,
        approvalRequests: stack.approvalRequests,
      },
    });

    const runId = await advanceToAwaiting(app);
    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    expect(approvals.statusCode).toBe(200);
    const approvalId = approvals.json().approvals[0]?.approvalRequestId as
      | string
      | undefined;
    expect(approvalId).toBeTruthy();

    const delivery = await app.inject({
      method: "GET",
      url: `/v1/approvals/${approvalId}/local-delivery`,
    });
    expect(delivery.statusCode).toBe(404);

    void runId;
    await app.close();
  }, 30_000);

  it("E+F: approval list and run detail are project-scoped", async () => {
    const stack = createLocalObservabilityStack();
    const outsider = perimeter("outsider", ["other-project"]);
    const insider = perimeter("user_local", [EXAMPLE_PROJECT_ID]);

    const app = await buildServer({
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
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access: insider.access,
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "TEST",
        allowLocalDelivery: true,
      },
      perimeter: insider,
    });

    const runId = await advanceToAwaiting(app);

    const insiderApprovals = await app.inject({
      method: "GET",
      url: "/v1/approvals",
    });
    expect(insiderApprovals.statusCode).toBe(200);
    expect(insiderApprovals.json().approvals.length).toBeGreaterThan(0);

    await app.close();

    const deniedApp = await buildServer({
      admission: stack.admission,
      humanAuthorization: stack.humanAuthorization,
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access: outsider.access,
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "TEST",
        allowLocalDelivery: false,
      },
      perimeter: outsider,
    });

    const outsiderApprovals = await deniedApp.inject({
      method: "GET",
      url: "/v1/approvals",
    });
    expect(outsiderApprovals.statusCode).toBe(200);
    expect(outsiderApprovals.json().approvals).toEqual([]);

    const outsiderRun = await deniedApp.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
    });
    expect(outsiderRun.statusCode).toBe(403);
    expect(outsiderRun.json().error).toBe("PROJECT_ACCESS_DENIED");

    await deniedApp.close();
  }, 30_000);

  it("G: nested sensitive metadata is sanitized recursively", () => {
    const nested = sanitizeNestedValue({
      ok: true,
      meta: {
        decisionNonceHash: "should-not-leak",
        nested: {
          bearerToken: "tok",
          deliverySecret: "sec",
          visible: "yes",
        },
      },
      list: [{ apiKey: "k", keep: 1 }],
    });
    expect(JSON.stringify(nested)).not.toMatch(
      /decisionNonceHash|bearerToken|deliverySecret|apiKey/,
    );
    expect(nested).toEqual({
      ok: true,
      meta: { nested: { visible: "yes" } },
      list: [{ keep: 1 }],
    });

    const request = {
      approvalRequestId: "apr_1",
      runId: "run_1",
      projectId: EXAMPLE_PROJECT_ID,
      objectiveId: "obj_1",
      objectiveVersion: 1,
      planId: "plan_1",
      planVersion: 1,
      planHash: "hash",
      status: "PENDING",
      expiresAt: new Date().toISOString(),
      validationDecision: "PASS",
      requestedApproverIds: ["approver_bootstrap"],
      createdAt: new Date().toISOString(),
      decisionNonceHash: "hash_secret",
      metadata: {
        decisionNonce: "plaintext-nonce",
        note: "ok",
      },
    } as unknown as ApprovalRequest;
    const publicRequest = sanitizeApprovalRequest(request);
    expect(JSON.stringify(publicRequest)).not.toContain("decisionNonceHash");
    expect(JSON.stringify(publicRequest)).not.toContain("plaintext-nonce");
    expect((publicRequest as { metadata?: { note?: string } }).metadata?.note).toBe(
      "ok",
    );
  });

  it("H: approval decision remains server-authorized (wrong nonce fails)", async () => {
    const stack = createLocalObservabilityStack();
    const app = await buildServer({
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
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        allowLocalDelivery: true,
        authenticationMode: "ANONYMOUS",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: true,
      },
    });

    await advanceToAwaiting(app);
    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    const approvalId = approvals.json().approvals[0].approvalRequestId as string;

    const decide = await app.inject({
      method: "POST",
      url: `/v1/approval-requests/${approvalId}/decision`,
      payload: {
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: "not-the-real-nonce",
      },
    });
    expect(decide.statusCode).toBeGreaterThanOrEqual(400);

    await app.close();
  }, 30_000);

  it("I: development identity mode is visibly marked via identity-mode endpoint", async () => {
    const stack = createLocalObservabilityStack();
    const app = await buildServer({
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "DEVELOPMENT",
        allowLocalDelivery: true,
        controlTowerDevAllowAll: false,
      },
    });
    const mode = await app.inject({
      method: "GET",
      url: "/v1/control-tower/identity-mode",
    });
    expect(mode.statusCode).toBe(200);
    expect(mode.json().developmentIdentityAdapter).toBe(true);
    expect(mode.json().localDeliveryEnabled).toBe(true);
    expect(mode.json().controlTowerDevAllowAll).toBe(false);
    expect(mode.json().doctrine.clientProvidedPrincipalNotAuthenticated).toBe(
      "CLIENT-PROVIDED PRINCIPAL != AUTHENTICATED PRINCIPAL",
    );
    await app.close();
  });
});

describe("Control Tower anonymous read closure", () => {
  it("A: ANONYMOUS + empty bindings → no CT data", async () => {
    const stack = createLocalObservabilityStack();
    const emptyAccess = new InMemoryProjectAccessDirectory([]);
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
      validation: stack.validation,
      authorizationRouting: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access: emptyAccess,
        authenticationMode: "ANONYMOUS",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: false,
        allowLocalDelivery: true,
      },
    });

    await advanceToAwaiting(app);

    const dashboard = await app.inject({
      method: "GET",
      url: "/v1/control-tower/dashboard",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().recentRuns).toEqual([]);
    expect(dashboard.json().recentApprovals).toEqual([]);
    expect(dashboard.json().counts.active).toBe(0);

    const runs = await app.inject({ method: "GET", url: "/v1/runs" });
    expect(runs.json().runs).toEqual([]);

    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    expect(approvals.json().approvals).toEqual([]);

    const projects = await app.inject({
      method: "GET",
      url: "/v1/control-tower/projects",
    });
    expect(projects.json().projects).toEqual([]);
    expect(projects.json().unrestricted).toBe(false);

    await app.close();
  }, 30_000);

  it("B: HEADER_PRINCIPAL + empty bindings → no CT data", async () => {
    const stack = createLocalObservabilityStack();
    const emptyAccess = new InMemoryProjectAccessDirectory([]);
    const app = await buildServer({
      controlTower: controlTowerFromStack(stack),
      runs: stack.runs,
      controlTowerOptions: {
        access: emptyAccess,
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: false,
      },
      perimeter: {
        authenticator: new FakeRequestAuthenticator({
          principalId: "user_local",
          authenticationMode: "HEADER_PRINCIPAL",
        }),
        access: emptyAccess,
        drain: new DrainController(),
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("ct_hdr_empty", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(60, 60_000),
        authenticationMode: "HEADER_PRINCIPAL",
        runs: stack.runs,
      },
    });

    const runs = await app.inject({ method: "GET", url: "/v1/runs" });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().runs).toEqual([]);
    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    expect(approvals.json().approvals).toEqual([]);
    await app.close();
  });

  it("C: STATIC_PRINCIPAL + empty bindings → no CT data", async () => {
    const stack = createLocalObservabilityStack();
    const emptyAccess = new InMemoryProjectAccessDirectory([]);
    const app = await buildServer({
      controlTower: controlTowerFromStack(stack),
      runs: stack.runs,
      controlTowerOptions: {
        access: emptyAccess,
        authenticationMode: "STATIC_PRINCIPAL",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: false,
      },
      perimeter: {
        authenticator: new FakeRequestAuthenticator({
          principalId: "operator_static",
          authenticationMode: "STATIC_PRINCIPAL",
        }),
        access: emptyAccess,
        drain: new DrainController(),
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("ct_static_empty", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(60, 60_000),
        authenticationMode: "STATIC_PRINCIPAL",
        runs: stack.runs,
      },
    });

    const dashboard = await app.inject({
      method: "GET",
      url: "/v1/control-tower/dashboard",
    });
    expect(dashboard.json().recentRuns).toEqual([]);
    expect(dashboard.json().recentApprovals).toEqual([]);
    await app.close();
  });

  it("D: development explicit allow-all works only when flag=true", async () => {
    const stack = createLocalObservabilityStack();
    const emptyAccess = new InMemoryProjectAccessDirectory([]);
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
      validation: stack.validation,
      authorizationRouting: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access: emptyAccess,
        authenticationMode: "ANONYMOUS",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: true,
        allowLocalDelivery: true,
      },
    });

    await advanceToAwaiting(app);
    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    expect(approvals.json().approvals.length).toBeGreaterThan(0);

    const mode = await app.inject({
      method: "GET",
      url: "/v1/control-tower/identity-mode",
    });
    expect(mode.json().controlTowerDevAllowAll).toBe(true);
    await app.close();
  }, 30_000);

  it("E: production rejects development allow-all flag", () => {
    expect(() =>
      loadRuntimeConfig({
        ORCHESTRATOR_ENV: "PRODUCTION",
        ORCHESTRATOR_STORAGE: "postgres",
        DATABASE_URL: "postgres://orchestrator:secret@127.0.0.1:5432/orchestrator",
        ORCHESTRATOR_AUTH_MODE: "STATIC_PRINCIPAL",
        ORCHESTRATOR_STATIC_PRINCIPAL_ID: "operator_static",
        APPROVAL_DELIVERY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
        ORCHESTRATOR_DEBUG: "false",
        ORCHESTRATOR_WORKER_CONCURRENCY: "4",
        ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL: "true",
      }),
    ).toThrow(/CONTROL_TOWER_DEV_ALLOW_ALL/);
  });

  it("E2: STAGING also rejects allow-all flag", () => {
    expect(() =>
      loadRuntimeConfig({
        ORCHESTRATOR_ENV: "STAGING",
        ORCHESTRATOR_STORAGE: "memory",
        ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
        ORCHESTRATOR_CONTROL_TOWER_DEV_ALLOW_ALL: "true",
      }),
    ).toThrow(/CONTROL_TOWER_DEV_ALLOW_ALL/);
  });

  it("F+G+H: unauthorized 403; authorized binding scopes runs and approvals", async () => {
    const stack = createLocalObservabilityStack();
    const insider = perimeter("user_local", [EXAMPLE_PROJECT_ID]);
    const app = await buildServer({
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
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access: insider.access,
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "TEST",
        allowLocalDelivery: true,
        controlTowerDevAllowAll: false,
      },
      perimeter: insider,
    });

    const runId = await advanceToAwaiting(app);
    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    expect(approvals.json().approvals.length).toBeGreaterThan(0);
    expect(
      approvals.json().approvals.every(
        (a: { projectId: string }) => a.projectId === EXAMPLE_PROJECT_ID,
      ),
    ).toBe(true);

    const detail = await app.inject({ method: "GET", url: `/v1/runs/${runId}` });
    expect(detail.statusCode).toBe(200);
    await app.close();

    const outsider = perimeter("outsider", ["other-project"]);
    const denied = await buildServer({
      runs: stack.runs,
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        access: outsider.access,
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: false,
      },
      perimeter: outsider,
    });
    const forbidden = await denied.inject({
      method: "GET",
      url: `/v1/runs/${runId}`,
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error).toBe("PROJECT_ACCESS_DENIED");
    const emptyApprovals = await denied.inject({
      method: "GET",
      url: "/v1/approvals",
    });
    expect(emptyApprovals.json().approvals).toEqual([]);
    await denied.close();
  }, 30_000);

  it("I: assurance/qualification require authenticated operator context", async () => {
    const stack = createLocalObservabilityStack();
    const anon = await buildServer({
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        authenticationMode: "ANONYMOUS",
        runtimeEnvironment: "TEST",
        controlTowerDevAllowAll: false,
      },
    });
    expect(
      (await anon.inject({ method: "GET", url: "/v1/system/assurance" }))
        .statusCode,
    ).toBe(401);
    expect(
      (await anon.inject({ method: "GET", url: "/v1/system/qualification" }))
        .statusCode,
    ).toBe(401);
    await anon.close();

    const authed = await buildServer({
      controlTower: controlTowerFromStack(stack),
      controlTowerOptions: {
        authenticationMode: "HEADER_PRINCIPAL",
        runtimeEnvironment: "TEST",
        access: new InMemoryProjectAccessDirectory([]),
        controlTowerDevAllowAll: false,
      },
    });
    expect(
      (await authed.inject({ method: "GET", url: "/v1/system/assurance" }))
        .statusCode,
    ).toBe(200);
    expect(
      (await authed.inject({ method: "GET", url: "/v1/system/qualification" }))
        .statusCode,
    ).toBe(200);
    await authed.close();
  });
});
