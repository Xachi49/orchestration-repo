import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalValidationStack } from "../infrastructure/validation/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { httpStatusForValidation } from "./validate.js";

async function serverWithPlannedRun() {
  const stack = createLocalValidationStack();
  const app = await buildServer({
    admission: stack.admission,
    ingestion: stack.ingestion,
    planning: stack.planning,
    validation: stack.validation,
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
  return { stack, app, runId };
}

describe("validation HTTP", () => {
  it("reports phase 5 with no external integrations enabled", async () => {
    const app = await buildServer();
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.json()).toMatchObject({
      status: "ok",
      phase: 5,
      llmConnected: false,
      githubConnected: false,
      executionEnabled: false,
      approvalEnabled: false,
      validationModelToolsEnabled: false,
    });
    await app.close();
  });

  it("validates a planned run and exposes the decision", async () => {
    const { app, runId } = await serverWithPlannedRun();

    const readiness = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/validation-readiness`,
    });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().code).toBe("READY");

    const validated = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/validate`,
    });
    expect(validated.statusCode).toBe(200);
    expect(validated.json()).toMatchObject({
      outcome: "VALIDATED",
      decision: "PASS",
      planStatus: "VALIDATED_PASS",
      runState: "VALIDATING",
      requiresHumanAction: false,
    });

    const latest = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/validation`,
    });
    expect(latest.statusCode).toBe(200);
    expect(latest.json().validationDecisionId).toBe(
      validated.json().validationDecisionId,
    );

    const listed = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/validations`,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().decisions).toHaveLength(1);
    await app.close();
  });

  it("returns 404 before any decision exists", async () => {
    const { app, runId } = await serverWithPlannedRun();
    const latest = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/validation`,
    });
    expect(latest.statusCode).toBe(404);
    expect(latest.json().error).toBe("VALIDATION_DECISION_NOT_FOUND");
    await app.close();
  });

  it("returns 409 when the run is not ready for validation", async () => {
    const stack = createLocalValidationStack();
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
      validation: stack.validation,
    });
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    const runId = admitted.json().runId as string;
    const response = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/validate`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("VALIDATION_NOT_READY");
    await app.close();
  });

  it("returns 409 while another validation of the same plan is in progress", async () => {
    const { stack, app, runId } = await serverWithPlannedRun();
    const plan = (await stack.plans.getByRunId(runId))!;
    await stack.validationCoordinator.begin(
      {
        runId,
        planId: plan.planId,
        planVersion: plan.planVersion,
        planHash: plan.planHash,
      },
      stack.clock.nowIso(),
    );
    const response = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/validate`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("VALIDATION_IN_PROGRESS");
    await app.close();
  });

  it("returns a BLOCK decision with 200 because a block is a decision, not an error", async () => {
    const { stack, app, runId } = await serverWithPlannedRun();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });
    const response = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/validate`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().decision).toBe("BLOCK");
    expect(response.json().runState).toBe("VALIDATING");
    await app.close();
  });

  it("maps validation error codes to fail-closed HTTP statuses", () => {
    expect(httpStatusForValidation("VALIDATION_NOT_READY")).toBe(409);
    expect(httpStatusForValidation("PLAN_NOT_FOUND")).toBe(404);
    expect(httpStatusForValidation("VALIDATION_MODEL_TIMEOUT")).toBe(502);
    expect(httpStatusForValidation("VALIDATION_MODEL_INVALID_OUTPUT")).toBe(422);
    expect(httpStatusForValidation("VALIDATION_RECONCILIATION_FAILED")).toBe(
      500,
    );
  });
});
