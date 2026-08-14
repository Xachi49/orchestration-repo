import { describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { httpStatusForAdmission } from "./runs.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";

describe("POST /v1/runs", () => {
  it("returns 201 for a new admission", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({ admission: stack.service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.outcome).toBe("ADMITTED");
    await app.close();
  });

  it("returns 409 for an active duplicate", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({ admission: stack.service });
    await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().outcome).toBe("ACTIVE_DUPLICATE");
    await app.close();
  });

  it("returns 400 for an invalid request", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({ admission: stack.service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest({ acceptanceCriteria: [] }),
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 403 for an unknown requester", async () => {
    const stack = createLocalAdmissionStack();
    const app = await buildServer({ admission: stack.service });
    const response = await app.inject({
      method: "POST",
      url: "/v1/runs",
      payload: exampleAdmissionRequest({ requesterId: "unknown_user" }),
    });
    expect(response.statusCode).toBe(403);
    await app.close();
  });

  it("maps completed duplicates to 200", () => {
    expect(
      httpStatusForAdmission({
        outcome: "COMPLETED_DUPLICATE",
        runId: "run_1",
        state: "COMPLETED",
        idempotencyKey: "abc",
      }),
    ).toBe(200);
  });
});
