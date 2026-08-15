import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalIngestionStack } from "../infrastructure/ingestion/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import { EXAMPLE_ENVIRONMENT, EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";
import { EXAMPLE_COMMIT_SHA } from "../ingestion/fixtures.js";
import { httpStatusForIngestion } from "./ingest.js";

describe("ingestion HTTP", () => {
  it("ingests an admitted run and returns the verified context", async () => {
    const stack = createLocalIngestionStack();
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
    });
    const admitted = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(admitted.statusCode).toBe(201);
    const runId = admitted.json().runId as string;
    const ingest = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/ingest`,
      payload: {
        projectId: EXAMPLE_PROJECT_ID,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
      },
    });
    expect(ingest.statusCode).toBe(200);
    expect(ingest.json().lockedRepository.commitSha).toBe(EXAMPLE_COMMIT_SHA);

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/repository-context`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().runId).toBe(runId);
    await app.close();
  });

  it("returns 404 when repository context is missing", async () => {
    const stack = createLocalIngestionStack();
    const app = await buildServer({ ingestion: stack.ingestion });
    const response = await app.inject({
      method: "GET",
      url: "/v1/runs/missing/repository-context",
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("maps structured ingestion errors", () => {
    expect(httpStatusForIngestion("REMOTE_AUTHENTICATION_FAILED")).toBe(401);
    expect(httpStatusForIngestion("BRANCH_NOT_FOUND")).toBe(404);
    expect(httpStatusForIngestion("REPOSITORY_NOT_CONFIGURED")).toBe(409);
  });
});
