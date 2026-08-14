import { describe, expect, it } from "vitest";
import { InMemoryRequesterAuthorization } from "../infrastructure/admission/in-memory-authorization.js";
import { EXAMPLE_REQUESTER_GRANTS, EXAMPLE_REQUESTER_ID } from "./fixtures.js";
import { EXAMPLE_ENVIRONMENT, EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";

describe("Requester authorization", () => {
  const auth = new InMemoryRequesterAuthorization(EXAMPLE_REQUESTER_GRANTS);

  it("authorizes an explicit grant", async () => {
    const result = await auth.authorize({
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: EXAMPLE_REQUESTER_ID,
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
    });
    expect(result.decision).toBe("AUTHORIZED");
  });

  it("denies an unauthorized requester on another project", async () => {
    const result = await auth.authorize({
      projectId: "other-project",
      requesterId: EXAMPLE_REQUESTER_ID,
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
    });
    expect(result.decision).toBe("PROJECT_ACCESS_DENIED");
  });

  it("denies an unknown requester", async () => {
    const result = await auth.authorize({
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: "unknown_user",
      requestedEnvironment: EXAMPLE_ENVIRONMENT,
    });
    expect(result.decision).toBe("UNKNOWN_REQUESTER");
  });

  it("denies an environment that is not granted", async () => {
    const result = await auth.authorize({
      projectId: EXAMPLE_PROJECT_ID,
      requesterId: EXAMPLE_REQUESTER_ID,
      requestedEnvironment: "production",
    });
    expect(result.decision).toBe("ENVIRONMENT_ACCESS_DENIED");
  });
});
