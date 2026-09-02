import { describe, expect, it } from "vitest";
import {
  createTestStack,
  buildPostgresTestAdmissionRequest,
  uniquePostgresTestId,
} from "./test-helpers.js";

describe("PostgreSQL integration", () => {
  it(
    "migrates, admits, and restarts against the same database",
    async () => {
      const request = buildPostgresTestAdmissionRequest({
        testName: "integration-restart",
      });
      let runId: string | undefined;
      let projectId: string | undefined;
      let objectiveId: string | undefined;

      const envA = await createTestStack(uniquePostgresTestId("integration_a"));
      try {
        const first = await envA.stack.admission.admit(request);
        expect(first.outcome).toBe("ADMITTED");
        runId = first.runId;
        expect(runId).toBeTruthy();
        const created = await envA.stack.runs.getById(runId!);
        expect(created?.state).toBe("ADMITTED");
        projectId = created!.projectId;
        objectiveId = created!.objectiveId;
      } finally {
        await envA.close();
      }

      const envB = await createTestStack(uniquePostgresTestId("integration_b"));
      try {
        const reloaded = await envB.stack.runs.getById(runId!);
        expect(reloaded?.state).toBe("ADMITTED");
        expect(reloaded?.runId).toBe(runId);
        expect(reloaded?.projectId).toBe(projectId);
        expect(reloaded?.objectiveId).toBe(objectiveId);
        expect(reloaded?.objectiveId).toBe(request.objectiveId);
        const duplicate = await envB.stack.admission.admit(request);
        expect(duplicate.outcome).toBe("ACTIVE_DUPLICATE");
        if (duplicate.outcome === "ACTIVE_DUPLICATE") {
          expect(duplicate.runId).toBe(runId);
        }
      } finally {
        await envB.close();
      }
    },
    20_000,
  );
});
