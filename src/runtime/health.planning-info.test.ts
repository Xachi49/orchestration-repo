import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerHealthRoutes } from "./health.js";
import { loadRuntimeConfig } from "./config.js";
import { StartupLifecycle, DrainController } from "./startup.js";
import { OperationalMetrics } from "./metrics.js";

describe("/health/info planning and validation model fields", () => {
  it("reports OpenAI planning and validation providers without secrets", async () => {
    const config = loadRuntimeConfig({
      ORCHESTRATOR_ENV: "PRODUCTION",
      ORCHESTRATOR_STORAGE: "postgres",
      DATABASE_URL: "postgres://orchestrator:secret@127.0.0.1:5432/orchestrator",
      ORCHESTRATOR_AUTH_MODE: "STATIC_PRINCIPAL",
      ORCHESTRATOR_STATIC_PRINCIPAL_ID: "operator_static",
      APPROVAL_DELIVERY_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"),
      RECOVERY_PROVIDER_MODE: "SHADOW",
      ORCHESTRATOR_GITHUB_AUTH_MODE: "PUBLIC_ANONYMOUS",
      ORCHESTRATOR_MODEL_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-secret-must-not-leak",
      OPENAI_MODEL: "gpt-4.1-mini",
      ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER: "resend",
      RESEND_API_KEY: "re_secret-must-not-leak",
      APPROVAL_DELIVERY_EMAIL_FROM: "orch-secret@example.com",
      APPROVAL_DELIVERY_EMAIL_TO: "ops-secret@example.com",
      ORCHESTRATOR_DEBUG: "false",
      ORCHESTRATOR_WORKER_CONCURRENCY: "4",
    });
    const startup = new StartupLifecycle();
    startup.advance("CONFIG_VALIDATED");
    startup.advance("SERVICES_READY");
    startup.advance("ACCEPTING_TRAFFIC");
    const app = Fastify();
    registerHealthRoutes(app, {
      config,
      startup,
      drain: new DrainController(),
      metrics: new OperationalMetrics(),
      build: config.build,
      planningModelProvider: "OPENAI",
      planningModelConfigured: true,
      planningModelId: "gpt-4.1-mini",
      validationModelProvider: "OPENAI",
      validationModelConfigured: true,
      validationModelId: "gpt-4.1-mini",
      approvalDeliveryProvider: "RESEND",
      approvalDeliveryConfigured: true,
    });
    const res = await app.inject({ method: "GET", url: "/health/info" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.planningModelProvider).toBe("OPENAI");
    expect(body.planningModelConfigured).toBe(true);
    expect(body.planningModelId).toBe("gpt-4.1-mini");
    expect(body.validationModelProvider).toBe("OPENAI");
    expect(body.validationModelConfigured).toBe(true);
    expect(body.validationModelId).toBe("gpt-4.1-mini");
    expect(body.approvalDeliveryProvider).toBe("RESEND");
    expect(body.approvalDeliveryConfigured).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sk-secret");
    expect(JSON.stringify(body)).not.toContain("OPENAI_API_KEY");
    expect(JSON.stringify(body)).not.toContain("re_secret");
    expect(JSON.stringify(body)).not.toContain("RESEND_API_KEY");
    expect(JSON.stringify(body)).not.toContain("orch-secret");
    expect(JSON.stringify(body)).not.toContain("ops-secret");
    expect(JSON.stringify(body)).not.toContain("decisionNonce");
    await app.close();
  });
});
