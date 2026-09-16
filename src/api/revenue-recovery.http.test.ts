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
