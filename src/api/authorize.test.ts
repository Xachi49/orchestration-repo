import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalAuthorizationStack } from "../infrastructure/authorization/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";

async function serverWithValidatedRun() {
  const stack = createLocalAuthorizationStack();
  const app = await buildServer({
    admission: stack.admission,
    ingestion: stack.ingestion,
    planning: stack.planning,
    validation: stack.validation,
    authorizationRouting: stack.authorizationRouting,
    humanAuthorization: stack.humanAuthorization,
    approvalExpiry: stack.approvalExpiry,
    authorizationReadiness: stack.authorizationReadiness,
  });
  const admitted = await app.inject({
    method: "POST",
    url: "/v1/runs",
    payload: exampleAdmissionRequest(),
  });
  const runId = admitted.json().runId as string;
  await app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/ingest`,
    payload: {
      projectId: EXAMPLE_PROJECT_ID,
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
    },
  });
  await app.inject({ method: "POST", url: `/v1/runs/${runId}/plan` });
  await app.inject({ method: "POST", url: `/v1/runs/${runId}/validate` });
  return { stack, app, runId };
}

describe("authorization HTTP", () => {
  it("reports phase 6 with approval enabled and execution disabled", async () => {
    const stack = createLocalAuthorizationStack();
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
      validation: stack.validation,
      authorizationRouting: stack.authorizationRouting,
      humanAuthorization: stack.humanAuthorization,
      approvalExpiry: stack.approvalExpiry,
      authorizationReadiness: stack.authorizationReadiness,
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({
      status: "ok",
      phase: 6,
      approvalEnabled: true,
      executionEnabled: false,
      githubWritesEnabled: false,
      llmConnected: false,
    });
    await app.close();
  });

  it("routes PASS to approval and accepts an APPROVE decision", async () => {
    const { app, runId, stack } = await serverWithValidatedRun();

    const routed = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/authorization-route`,
    });
    expect(routed.statusCode).toBe(200);
    expect(routed.json()).toMatchObject({
      outcome: "PENDING_APPROVAL",
      runState: "AWAITING_APPROVAL",
    });

    const pending = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/approval-request`,
    });
    expect(pending.statusCode).toBe(200);
    const approvalRequestId = pending.json().approvalRequestId as string;

    const decided = await app.inject({
      method: "POST",
      url: `/v1/approval-requests/${approvalRequestId}/decision`,
      payload: {
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: (
          stack.approvalDelivery as import("../authorization/delivery.js").FakeApprovalDeliveryService
        ).nonceFor(approvalRequestId),
      },
    });
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({
      result: "APPROVED",
      runState: "APPROVED",
    });

    const authz = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/authorization`,
    });
    expect(authz.statusCode).toBe(200);
    expect(authz.json().decision).toBe("APPROVE");
    await app.close();
  });
});
