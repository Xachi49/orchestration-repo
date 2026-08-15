import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { createLocalPlanningStack } from "../infrastructure/planning/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";

describe("planning HTTP", () => {
  it("plans an ingested run and returns the stored plan", async () => {
    const stack = createLocalPlanningStack();
    const app = await buildServer({
      admission: stack.admission,
      ingestion: stack.ingestion,
      planning: stack.planning,
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
    const planned = await app.inject({
      method: "POST",
      url: `/v1/runs/${runId}/plan`,
    });
    expect(planned.statusCode).toBe(200);
    expect(planned.json().status).toBe("READY_FOR_VALIDATION");

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/plan`,
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().planId).toBe(planned.json().planId);

    const context = await app.inject({
      method: "GET",
      url: `/v1/runs/${runId}/planning-context`,
    });
    expect(context.statusCode).toBe(200);
    expect(context.json().planningContextFingerprint).toBeTruthy();
    await app.close();
  });
});
