import { describe, expect, it } from "vitest";
import { createLocalValidationStack } from "../infrastructure/validation/local-stack.js";
import { exampleAdmissionRequest } from "../admission/fixtures.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT_ID,
} from "../control-plane/fixtures.js";
import { ValidationError } from "./errors.js";

async function plannedRun() {
  const stack = createLocalValidationStack();
  const admitted = await stack.admission.admit(exampleAdmissionRequest());
  if (admitted.outcome !== "ADMITTED") {
    throw new Error(`expected ADMITTED, got ${admitted.outcome}`);
  }
  await stack.ingestion.ingest(
    admitted.runId,
    EXAMPLE_PROJECT_ID,
    EXAMPLE_ENVIRONMENT,
  );
  await stack.planning.plan(admitted.runId);
  return { stack, runId: admitted.runId };
}

describe("ValidationReadinessService", () => {
  it("is READY for a VALIDATING run with a READY_FOR_VALIDATION plan", async () => {
    const { stack, runId } = await plannedRun();
    const result = await stack.validationReadiness.assess(runId);
    expect(result.ready).toBe(true);
    expect(result.code).toBe("READY");
    if (result.ready) {
      expect(result.plan.status).toBe("READY_FOR_VALIDATION");
      expect(result.plan.planVersion).toBe(1);
    }
  });

  it("stays READY while a plan is UNDER_VALIDATION so a retry can resume", async () => {
    const { stack, runId } = await plannedRun();
    const plan = await stack.plans.getByRunId(runId);
    await stack.plans.save({ ...plan!, status: "UNDER_VALIDATION" });
    const result = await stack.validationReadiness.assess(runId);
    expect(result.ready).toBe(true);
  });

  it("denies runs that are not VALIDATING", async () => {
    const { stack, runId } = await plannedRun();
    const run = await stack.runs.getById(runId);
    await stack.runs.save({ ...run!, state: "PLANNING" });
    const result = await stack.validationReadiness.assess(runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("RUN_NOT_VALIDATING");
    }
  });

  it("denies unknown runs", async () => {
    const stack = createLocalValidationStack();
    const result = await stack.validationReadiness.assess("run_missing");
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("RUN_NOT_VALIDATING");
    }
  });

  it("denies a VALIDATING run with no plan", async () => {
    const stack = createLocalValidationStack();
    const admitted = await stack.admission.admit(exampleAdmissionRequest());
    if (admitted.outcome !== "ADMITTED") {
      throw new Error("expected ADMITTED");
    }
    const run = await stack.runs.getById(admitted.runId);
    await stack.runs.save({ ...run!, state: "VALIDATING" });
    const result = await stack.validationReadiness.assess(admitted.runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("PLAN_NOT_FOUND");
    }
  });

  it("denies plans already adjudicated", async () => {
    const { stack, runId } = await plannedRun();
    const plan = await stack.plans.getByRunId(runId);
    await stack.plans.save({ ...plan!, status: "VALIDATED_PASS" });
    const result = await stack.validationReadiness.assess(runId);
    expect(result.ready).toBe(false);
    if (!result.ready) {
      expect(result.code).toBe("PLAN_NOT_VALIDATABLE");
    }
  });

  it("does not treat repository drift as a readiness failure", async () => {
    const { stack, runId } = await plannedRun();
    const lock = await stack.locks.getByRunId(runId);
    await stack.locks.save({ ...lock!, status: "STALE" });
    const result = await stack.validationReadiness.assess(runId);
    expect(result.ready).toBe(true);
  });

  it("assertReady fails closed with mapped ValidationError codes", async () => {
    const { stack, runId } = await plannedRun();
    const run = await stack.runs.getById(runId);
    await stack.runs.save({ ...run!, state: "PLANNING" });
    await expect(
      stack.validationReadiness.assertReady(runId),
    ).rejects.toMatchObject({ code: "VALIDATION_NOT_READY" });

    await stack.runs.save({ ...run!, state: "VALIDATING" });
    const plan = await stack.plans.getByRunId(runId);
    await stack.plans.save({ ...plan!, status: "VALIDATED_BLOCK" });
    const error = await stack.validationReadiness
      .assertReady(runId)
      .then(() => null)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).code).toBe("PLAN_NOT_VALIDATABLE");
  });
});
