/**
 * Revenue Recovery HTTP surface boundaries.
 *
 * The HTTP API can ingest facts. It cannot assert authorization, elevate
 * economic trust, or reach the outreach actuator.
 */
import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createMemoryRevenueRecoveryService } from "./revenue-recovery-factory.js";
import {
  demoLead,
  demoRecoveryConfig,
  RR_CUSTOMER,
  RR_PROJECT,
} from "../infrastructure/postgres/postgres.revenue-recovery.helpers.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { EXAMPLE_PROJECT } from "../control-plane/fixtures.js";
import { FakeRequestAuthenticator } from "../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../runtime/access.js";
import { DrainController } from "../runtime/startup.js";
import { OperationalMetrics } from "../runtime/metrics.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../runtime/rate-limit.js";

const NOW = "2026-09-12T12:30:00.000Z";

async function serverWithRecovery() {
  const { service, messaging } = createMemoryRevenueRecoveryService({
    nowIso: () => NOW,
  });
  await service.putConfiguration(demoRecoveryConfig());
  const app = await buildServer({ revenueRecovery: service });
  return { app, service, messaging };
}

describe("Revenue Recovery HTTP surface", () => {
  it("rejects a caller-supplied trustProvenance on event ingest", async () => {
    const { app, service } = await serverWithRecovery();
    const { lead } = await service.ingestLead(demoLead());

    const response = await app.inject({
      method: "POST",
      url: `/v1/revenue-recovery/leads/${lead.leadId}/events`,
      payload: {
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        kind: "PAYMENT_RECORDED",
        occurredAt: "2026-09-12T13:00:00.000Z",
        externalEventId: "http_elevated_pay",
        source: "Stripe",
        amount: 4200,
        currency: "USD",
        trustProvenance: "TRUSTED_PAYMENT_SOURCE",
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("CALLER_ASSERTION_REJECTED");
    await app.close();
  });

  it("assigns MANUAL_ATTESTATION to every generic HTTP economic event", async () => {
    const { app, service } = await serverWithRecovery();
    const { lead } = await service.ingestLead(demoLead());

    const response = await app.inject({
      method: "POST",
      url: `/v1/revenue-recovery/leads/${lead.leadId}/events`,
      payload: {
        customerAccountId: RR_CUSTOMER,
        projectId: RR_PROJECT,
        kind: "SALE_RECORDED",
        occurredAt: "2026-09-12T13:00:00.000Z",
        externalEventId: "http_sale_1",
        source: "Stripe",
        amount: 4200,
        currency: "USD",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().event.trustProvenance).toBe("MANUAL_ATTESTATION");
    await app.close();
  });

  it("exposes no HTTP route that performs recovery outreach", async () => {
    const { app, messaging } = await serverWithRecovery();
    for (const url of [
      "/v1/revenue-recovery/cases/x/authorized-action",
      "/v1/revenue-recovery/cases/x/send",
      "/v1/revenue-recovery/cases/x/outreach",
    ]) {
      const response = await app.inject({ method: "POST", url, payload: {} });
      expect(response.statusCode).toBe(404);
    }
    expect(messaging.sent).toHaveLength(0);
    await app.close();
  });
});

const TEMPLATE_ID = "rtpl_continuum_rr_email_followup";

function templatePayload(overrides: Record<string, unknown> = {}) {
  return {
    templateId: TEMPLATE_ID,
    version: 1,
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    channel: "EMAIL",
    body: "Hi {{firstName}} — {{businessName}} following up on {{serviceRequested}}.",
    allowedVariables: ["firstName", "businessName", "serviceRequested"],
    enabled: true,
    ...overrides,
  };
}

function staticPerimeter(principalId: string, projectIds: readonly string[]) {
  return {
    authenticator: new FakeRequestAuthenticator({
      principalId,
      authenticationMode: "STATIC_PRINCIPAL" as const,
    }),
    access: new InMemoryProjectAccessDirectory([{ principalId, projectIds }]),
    drain: new DrainController(),
    metrics: new OperationalMetrics(),
    logger: new MemoryStructuredLogger("rr_templates", () => undefined),
    rateLimiter: new SlidingWindowRateLimiter(120, 60_000),
    authenticationMode: "STATIC_PRINCIPAL" as const,
  };
}

async function templateServer(
  perimeter?: ReturnType<typeof staticPerimeter>,
) {
  const product = createMemoryRevenueRecoveryService({
    nowIso: () => NOW,
    projects: new InMemoryProjectRegistry([EXAMPLE_PROJECT]),
  });
  await product.service.putConfiguration(demoRecoveryConfig());
  const app = await buildServer({
    revenueRecovery: product.service,
    ...(perimeter ? { perimeter } : {}),
  });
  return { app, ...product };
}

describe("Revenue Recovery template routes", () => {
  it("creates, replays idempotently, and rejects divergent content", async () => {
    const { app, messaging } = await templateServer();
    const created = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload(),
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      outcome: "CREATED",
      template: { ...templatePayload(), createdAt: NOW },
    });

    const replay = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload(),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().outcome).toBe("ALREADY_EXISTS");

    const divergent = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({ body: "Changed {{firstName}}", allowedVariables: ["firstName"] }),
    });
    expect(divergent.statusCode).toBe(409);
    expect(divergent.json()).toEqual({
      error: "RECOVERY_TEMPLATE_VERSION_CONFLICT",
      message: expect.any(String),
      details: { templateId: TEMPLATE_ID, version: 1 },
    });

    const secondIdentity = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({ templateId: "rtpl_second_identity" }),
    });
    expect(secondIdentity.statusCode).toBe(409);
    expect(secondIdentity.json().error).toBe("RECOVERY_TEMPLATE_IDENTITY_CONFLICT");

    expect(messaging.sent).toHaveLength(0);
    await app.close();
  });

  it("maps validation failures without echoing content or stacks", async () => {
    const { app } = await templateServer();
    const unsupported = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({
        body: "Hi {{arbitraryModelField}}",
        allowedVariables: ["arbitraryModelField"],
      }),
    });
    expect(unsupported.statusCode).toBe(422);
    expect(unsupported.json().error).toBe("TEMPLATE_VARIABLE_UNSUPPORTED");
    expect(unsupported.body).not.toContain("stack");

    const createdAt = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({ createdAt: NOW }),
    });
    expect(createdAt.statusCode).toBe(400);
    expect(createdAt.json().error).toBe("TEMPLATE_INVALID");

    const unknownProject = await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({ projectId: "unregistered-project" }),
    });
    expect(unknownProject.statusCode).toBe(404);
    expect(unknownProject.json().error).toBe("PROJECT_NOT_FOUND");
    await app.close();
  });

  it("lists read-only by scope and channel, and returns an exact version", async () => {
    const { app } = await templateServer();
    await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload(),
    });
    await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({ version: 2, body: "v2 {{firstName}}", allowedVariables: ["firstName"] }),
    });
    await app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload({ templateId: "rtpl_sms_followup", channel: "SMS" }),
    });

    const email = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}&channel=EMAIL`,
    });
    expect(email.statusCode).toBe(200);
    expect(email.json().channel).toBe("EMAIL");
    expect(
      email.json().templates.map((t: { templateId: string; version: number }) =>
        `${t.templateId}@${t.version}`,
      ),
    ).toEqual([`${TEMPLATE_ID}@1`, `${TEMPLATE_ID}@2`]);
    expect(Object.keys(email.json().templates[0]).sort()).toEqual(
      [
        "allowedVariables",
        "body",
        "channel",
        "createdAt",
        "customerAccountId",
        "enabled",
        "projectId",
        "templateId",
        "version",
      ],
    );

    const all = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(all.json().templates).toHaveLength(3);

    const exact = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates/${TEMPLATE_ID}/versions/2?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(exact.statusCode).toBe(200);
    expect(exact.json().template.version).toBe(2);

    const missing = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates/${TEMPLATE_ID}/versions/9?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe("TEMPLATE_NOT_FOUND");

    const badQuery = await app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates?customerAccountId=${RR_CUSTOMER}`,
    });
    expect(badQuery.statusCode).toBe(400);
    await app.close();
  });

  it("requires project access under the STATIC_PRINCIPAL perimeter", async () => {
    const insider = await templateServer(
      staticPerimeter("operator_static", [RR_PROJECT]),
    );
    const created = await insider.app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload(),
    });
    expect(created.statusCode).toBe(201);
    const provisioned = insider.repos.audits
      .listAll()
      .find((e) => e.kind === "RECOVERY_TEMPLATE_PROVISIONED");
    expect(provisioned?.payload).toMatchObject({ principalId: "operator_static" });
    const listed = await insider.app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().templates).toHaveLength(1);
    await insider.app.close();

    const outsider = await templateServer(
      staticPerimeter("operator_static", ["other-project"]),
    );
    const deniedCreate = await outsider.app.inject({
      method: "POST",
      url: "/v1/revenue-recovery/templates",
      payload: templatePayload(),
    });
    expect(deniedCreate.statusCode).toBe(403);
    expect(deniedCreate.json().error).toBe("PROJECT_ACCESS_DENIED");
    expect(await outsider.repos.templates.listByTemplateId(TEMPLATE_ID)).toEqual([]);

    const deniedList = await outsider.app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(deniedList.statusCode).toBe(403);
    expect(deniedList.json().error).toBe("PROJECT_ACCESS_DENIED");

    const deniedExact = await outsider.app.inject({
      method: "GET",
      url: `/v1/revenue-recovery/templates/${TEMPLATE_ID}/versions/1?customerAccountId=${RR_CUSTOMER}&projectId=${RR_PROJECT}`,
    });
    expect(deniedExact.statusCode).toBe(403);
    await outsider.app.close();
  });
});
