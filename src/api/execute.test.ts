import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalExecutionStack } from "../infrastructure/execution/local-stack.js";
import { createExecutionFriendlyPlanningModel } from "../execution/friendly-planning-model.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";

async function serverWithApprovedRun() {
  const delivery = new FakeApprovalDeliveryService();
  const stack = createLocalExecutionStack({
    approvalDelivery: delivery,
    planningModel: createExecutionFriendlyPlanningModel(),
  });
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
  const routed = await app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/authorization-route`,
  });
  const approvalRequestId = routed.json().approvalRequestId as string;
  await app.inject({
    method: "POST",
    url: `/v1/approval-requests/${approvalRequestId}/decision`,
    payload: {
      approverId: "approver_bootstrap",
      decision: "APPROVE",
      submittedAt: stack.clock.nowIso(),
      decisionNonce: delivery.nonceFor(approvalRequestId),
    },
  });
  return { app, runId, stack };
}

describe("execution HTTP", () => {
  it("reports phase 7 with execution and approval enabled", async () => {
    const stack = createLocalExecutionStack({
      planningModel: createExecutionFriendlyPlanningModel(),
    });
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
    });
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({
      status: "ok",
      phase: 7,
      approvalEnabled: true,
      executionEnabled: true,
      githubWritesEnabled: false,
      llmConnected: false,
    });
    await app.close();
  });

  it("executes an approved run and returns artifacts", async () => {
    const { app, runId } = await serverWithApprovedRun();

    const executed = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/execute`,
    });
    expect(executed.statusCode).toBe(200);
    expect(executed.json()).toMatchObject({
      status: "EXECUTION_SUCCEEDED",
      runId,
    });

    const latest = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/execution`,
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().executionAttemptId).toBe(
      executed.json().executionAttemptId,
    );

    const artifacts = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/execution-artifacts`,
    });
    expect(artifacts.statusCode).toBe(200);
    expect(artifacts.json().artifacts.length).toBeGreaterThan(0);

    await app.close();
  });

  it("rejects execute while still VALIDATING", async () => {
    const stack = createLocalExecutionStack({
      planningModel: createExecutionFriendlyPlanningModel(),
    });
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

    const executed = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/execute`,
    });
    expect(executed.statusCode).toBe(409);
    expect(executed.json().error).toBe("EXECUTION_NOT_READY");
    await app.close();
  });
});
