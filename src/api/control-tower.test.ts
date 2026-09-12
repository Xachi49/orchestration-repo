import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalObservabilityStack } from "../infrastructure/observability/local-stack.js";
import { controlTowerFromStack } from "./control-tower-factory.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";

describe("Control Tower HTTP read models", () => {
  it("lists dashboard and sanitizes approval projections", async () => {
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
        // Explicit TEST fixture — not inferred from ANONYMOUS/empty bindings.
        controlTowerDevAllowAll: true,
      },
    });

    const admitted = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest({
        objectiveId: `obj_ct_${Date.now()}`,
      }),
    });
    expect(admitted.statusCode).toBe(201);
    const runId = admitted.json().runId as string;

    const ingested = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/ingest`,
      payload: {
        projectId: EXAMPLE_PROJECT_ID,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
      },
    });
    expect(ingested.statusCode).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: `/v1/runs/${runId}/plan` }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: `/v1/runs/${runId}/validate` }))
        .statusCode,
    ).toBe(200);
    const routed = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/authorization-route`,
    });
    expect(routed.statusCode).toBe(200);

    const dashboard = await app.inject({
      method: "GET",
      url: "/v1/control-tower/dashboard",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.json().doctrine.controlTowerNotAuthority).toBe(
      "CONTROL TOWER != AUTHORITY",
    );

    const detail = await app.inject({ method: "GET", url: `/v1/runs/${runId}` });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().run.state).toBe("AWAITING_APPROVAL");
    expect(
      detail.json().timeline.find(
        (s: { stageId: string }) => s.stageId === "AUTHORIZATION",
      ).status,
    ).toBe("AWAITING_ACTION");
    expect(JSON.stringify(detail.json())).not.toContain("decisionNonceHash");

    const approvals = await app.inject({ method: "GET", url: "/v1/approvals" });
    expect(approvals.statusCode).toBe(200);
    expect(approvals.json().approvals.length).toBeGreaterThan(0);
    expect(JSON.stringify(approvals.json())).not.toContain("decisionNonceHash");

    const approvalId = approvals.json().approvals[0]
      .approvalRequestId as string;
    const delivery = await app.inject({
      method: "GET",
      url: `/v1/approvals/${approvalId}/local-delivery`,
    });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json().decisionNonce).toBeTruthy();
    expect(
      stack.approvalDelivery instanceof FakeApprovalDeliveryService,
    ).toBe(true);

    const decide = await app.inject({
      method: "POST",
      url: `/v1/approval-requests/${approvalId}/decision`,
      payload: {
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        submittedAt: stack.clock.nowIso(),
        decisionNonce: delivery.json().decisionNonce,
      },
    });
    expect(decide.statusCode).toBe(200);

    const after = await app.inject({ method: "GET", url: `/v1/runs/${runId}` });
    expect(after.json().run.state).toBe("APPROVED");

    await app.close();
  }, 30_000);
});
