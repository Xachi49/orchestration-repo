import { describe, expect, it } from "vitest";
import { buildServer } from "../api/server.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";
import { FakeRequestAuthenticator } from "./auth.js";
import { InMemoryProjectAccessDirectory } from "./access.js";
import { DrainController, StartupLifecycle } from "./startup.js";
import { OperationalMetrics } from "./metrics.js";
import { MemoryStructuredLogger, redactText } from "./logging.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { BoundedWorkerLoop } from "./worker.js";
import { createOrchestratorRuntime } from "./process.js";
import { loadRuntimeConfig } from "./config.js";
import type { PerimeterDeps } from "./perimeter.js";

function testPerimeter(
  overrides: Partial<PerimeterDeps> = {},
): PerimeterDeps {
  return {
    authenticator: new FakeRequestAuthenticator({
      principalId: "user_local",
      authenticationMode: "HEADER_PRINCIPAL",
    }),
    access: new InMemoryProjectAccessDirectory([
      { principalId: "user_local", projectIds: [EXAMPLE_PROJECT_ID] },
    ]),
    drain: new DrainController(),
    metrics: new OperationalMetrics(),
    logger: new MemoryStructuredLogger("runtime_test", () => undefined),
    rateLimiter: new SlidingWindowRateLimiter(5, 60_000),
    authenticationMode: "HEADER_PRINCIPAL",
    ...overrides,
  };
}

describe("Phase 12 runtime acceptance (unit)", () => {
  it("startup lifecycle reaches ready only after ordered advances", () => {
    const life = new StartupLifecycle();
    expect(life.isReady()).toBe(false);
    life.advance("CONFIG_VALIDATED");
    life.advance("SERVICES_READY");
    life.advance("ACCEPTING_TRAFFIC");
    expect(life.trail()).toEqual([
      "CREATED",
      "CONFIG_VALIDATED",
      "SERVICES_READY",
      "ACCEPTING_TRAFFIC",
    ]);
    expect(life.isReady()).toBe(true);
  });

  it("denies anonymous mutation when perimeter requires auth", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({
      admission: stack.service,
      perimeter: testPerimeter({
        authenticator: new FakeRequestAuthenticator(null),
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().requestId).toBeTruthy();
    expect(JSON.stringify(response.json())).not.toContain("stack");
    await app.close();
  });

  it("denies authenticated principal without project access", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({
      admission: stack.service,
      perimeter: testPerimeter({
        access: new InMemoryProjectAccessDirectory([
          { principalId: "user_local", projectIds: ["other-project"] },
        ]),
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("PROJECT_ACCESS_DENIED");
    await app.close();
  });

  it("allows authenticated principal with project access to reach domain admission", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({
      admission: stack.service,
      perimeter: testPerimeter(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("rate limiting does not create business state", async () => {
    const stack = createLocalAdmissionStack();
    const limiter = new SlidingWindowRateLimiter(1, 60_000, () => 1);
    const app = await buildServer({
      admission: stack.service,
      perimeter: testPerimeter({ rateLimiter: limiter }),
    });
    const first = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest({ objectiveId: "obj_rate_1" }),
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest({ objectiveId: "obj_rate_2" }),
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toBe("RATE_LIMITED");
    await app.close();
  });

  it("redacts secrets from log and error text", () => {
    const text = redactText(
      "postgres://orchestrator:supersecret@127.0.0.1:5432/db DATABASE_URL=postgres://x:y@h/db",
    );
    expect(text).not.toContain("supersecret");
    expect(text.toLowerCase()).not.toContain("postgres://x:y");
  });

  it("worker respects concurrency backpressure", async () => {
    let parallel = 0;
    let max = 0;
    const loop = new BoundedWorkerLoop({
      concurrency: 1,
      pollIntervalMs: 5,
      jitterMs: 0,
      isAccepting: () => true,
      jobs: [
        {
          name: "job",
          run: async () => {
            parallel += 1;
            max = Math.max(max, parallel);
            await new Promise((r) => setTimeout(r, 20));
            parallel -= 1;
          },
        },
      ],
    });
    loop.start();
    await new Promise((r) => setTimeout(r, 50));
    loop.stop();
    expect(max).toBeLessThanOrEqual(1);
    expect(loop.skippedBackpressure + loop.claims).toBeGreaterThan(0);
  });

  it("TEST runtime boots without HTTP listen", async () => {
    const runtime = createOrchestratorRuntime({
      ORCHESTRATOR_ENV: "TEST",
      ORCHESTRATOR_STORAGE: "memory",
      ORCHESTRATOR_AUTH_MODE: "ANONYMOUS",
      ORCHESTRATOR_ROLE: "API",
    });
    await runtime.start({ listen: false });
    expect(runtime.startup.isReady()).toBe(true);
    const app = runtime.app!;
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    await runtime.close();
    expect(runtime.drain.current()).toBe("STOPPED");
  });

  it("readiness becomes false when a registered database probe is unhealthy", async () => {
    const drain = new DrainController();
    const startup = new StartupLifecycle();
    startup.advance("CONFIG_VALIDATED");
    startup.advance("SERVICES_READY");
    startup.advance("ACCEPTING_TRAFFIC");
    const config = loadRuntimeConfig({
      ORCHESTRATOR_ENV: "TEST",
      ORCHESTRATOR_STORAGE: "memory",
    });
    let reachable = true;
    const app = await buildServer({
      health: {
        config,
        startup,
        drain,
        metrics: new OperationalMetrics(),
        build: config.build,
        database: async () => ({
          storageMode: "postgres",
          databaseReachable: reachable,
          schemaCompatible: reachable,
          supportedSchemaVersion: "012_phase17_governed_experiments",
        }),
      },
    });
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(
      200,
    );
    reachable = false;
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(503);
    reachable = true;
    expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(
      200,
    );
    await app.close();
  });

  it("approval-decision project binding uses durable ApprovalRequest, not caller projectId", async () => {
    const stack = createLocalAuthorizationStack();
    const logs: string[] = [];
    const logger = new MemoryStructuredLogger("runtime_test", (line) => {
      logs.push(line);
    });
    const app = await buildServer({
      admission: stack.admission,
      authorizationRouting: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
      perimeter: testPerimeter({
        logger,
        access: new InMemoryProjectAccessDirectory([
          { principalId: "user_local", projectIds: [EXAMPLE_PROJECT_ID] },
        ]),
        approvalRequests: {
          async getById() {
            return {
              approvalRequestId: "apr_other",
              projectId: "project-b",
              runId: "run_other",
            } as never;
          },
        },
      }),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/approval-requests/apr_other/decision",
      payload: {
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: "TEST_APPROVAL_NONCE_SENTINEL",
        submittedAt: new Date().toISOString(),
        projectId: EXAMPLE_PROJECT_ID,
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("PROJECT_ACCESS_DENIED");
    expect(JSON.stringify(response.json())).not.toContain(
      "TEST_APPROVAL_NONCE_SENTINEL",
    );
    expect(logs.join("\n")).not.toContain("TEST_APPROVAL_NONCE_SENTINEL");
    await app.close();
  });

  it("redacts sentinel secrets from structured logs and error envelopes", async () => {
    const stack = createLocalAdmissionStack();
    const logs: string[] = [];
    const logger = new MemoryStructuredLogger("runtime_test", (line) => {
      logs.push(line);
    });
    const app = await buildServer({
      admission: stack.service,
      perimeter: testPerimeter({
        logger,
        authenticator: new FakeRequestAuthenticator(null),
      }),
    });
    logger.log({
      level: "error",
      operation: "startup",
      result: "failed",
      message:
        "connect postgres://u:TEST_DB_PASSWORD_SENTINEL@127.0.0.1:1/db key=TEST_DELIVERY_KEY_SENTINEL",
    });
    logger.log({
      level: "error",
      operation: "provider",
      result: "failed",
      message: "model provider TEST_API_KEY_SENTINEL",
    });
    const auth = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(auth.statusCode).toBe(401);
    const joined = `${logs.join("\n")}\n${auth.body}`;
    expect(joined).not.toContain("TEST_DB_PASSWORD_SENTINEL");
    expect(joined).not.toContain("TEST_API_KEY_SENTINEL");
    expect(joined).not.toContain("TEST_DELIVERY_KEY_SENTINEL");
    await app.close();
  });
});
