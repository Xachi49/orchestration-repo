import { describe, expect, it } from "vitest";
import {
  assertTransition,
  transitionRunState,
} from "../domain/run/run-state.js";
import { AdmissionError } from "./errors.js";
import { exampleAdmissionRequest, EXAMPLE_REQUESTER_ID } from "./fixtures.js";
import {
  EXAMPLE_BUDGET,
  EXAMPLE_CAPABILITIES,
  EXAMPLE_POLICY_BUNDLE,
  EXAMPLE_PROJECT,
  EXAMPLE_PROJECT_ID,
  EXAMPLE_SUSPENDED_PROJECT,
} from "../control-plane/fixtures.js";
import { ControlPlaneService } from "../control-plane/service.js";
import { ObjectiveAdmissionService } from "./service.js";
import { NoopObservability } from "../observability/index.js";
import { InMemoryProjectRegistry } from "../infrastructure/control-plane/in-memory-project-registry.js";
import { InMemoryCapabilityRegistry } from "../infrastructure/control-plane/in-memory-capability-registry.js";
import { InMemoryPolicyRegistry } from "../infrastructure/control-plane/in-memory-policy-registry.js";
import { InMemoryResourceBudgetRegistry } from "../infrastructure/control-plane/in-memory-budget-registry.js";
import { InMemoryRequesterAuthorization } from "../infrastructure/admission/in-memory-authorization.js";
import { createLocalAdmissionStack } from "../infrastructure/admission/local-stack.js";
import { PROJECT_OBJECTIVE_SUBMITTED } from "./event-store.js";
import { EXAMPLE_REQUESTER_GRANTS } from "./fixtures.js";

describe("Requester authorization via admission", () => {
  it("rejects an unknown requester", async () => {
    const { service } = createLocalAdmissionStack();
    const result = await service.admit(
      exampleAdmissionRequest({ requesterId: "unknown_user" }),
    );
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("UNKNOWN_REQUESTER");
    }
  });

  it("rejects a requester without environment access", async () => {
    const { service } = createLocalAdmissionStack({
      grants: [
        {
          requesterId: EXAMPLE_REQUESTER_ID,
          projectId: EXAMPLE_PROJECT_ID,
          environments: ["local"],
        },
      ],
    });
    const result = await service.admit(
      exampleAdmissionRequest({ requestedEnvironment: "development" }),
    );
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("REQUESTER_UNAUTHORIZED");
    }
  });
});

describe("Project eligibility", () => {
  it("allows an active project", async () => {
    const { service } = createLocalAdmissionStack();
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("ADMITTED");
  });

  it("denies a suspended project", async () => {
    const { service } = stackWithProjects([EXAMPLE_SUSPENDED_PROJECT]);
    const result = await service.admit(
      exampleAdmissionRequest({
        projectId: EXAMPLE_SUSPENDED_PROJECT.projectId,
      }),
    );
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("PROJECT_NOT_ELIGIBLE");
    }
  });

  it("denies an unknown project", async () => {
    const { service } = createLocalAdmissionStack();
    const result = await service.admit(
      exampleAdmissionRequest({ projectId: "missing-project" }),
    );
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("PROJECT_NOT_FOUND");
    }
  });

  it("denies an invalid environment", async () => {
    const { service } = createLocalAdmissionStack();
    const result = await service.admit(
      exampleAdmissionRequest({ requestedEnvironment: "production" }),
    );
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("ENVIRONMENT_NOT_ALLOWED");
    }
  });

  it("denies a missing policy bundle", async () => {
    const { service } = stackWithPolicies([]);
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("PROJECT_NOT_ELIGIBLE");
    }
  });

  it("denies a missing budget profile", async () => {
    const { service } = stackWithBudgets([]);
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("REJECTED");
    if (result.outcome === "REJECTED") {
      expect(result.reasonCode).toBe("PROJECT_NOT_ELIGIBLE");
    }
  });
});

describe("Idempotency", () => {
  it("creates a new run on the first request", async () => {
    const { service, runs, locks } = createLocalAdmissionStack();
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("ADMITTED");
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
    expect(await locks.getActiveLock(EXAMPLE_PROJECT_ID)).toBeNull();
  });

  it("returns the existing run for a repeated active request", async () => {
    const { service, runs, events } = createLocalAdmissionStack();
    const first = await service.admit(exampleAdmissionRequest());
    const second = await service.admit(exampleAdmissionRequest());
    expect(first.outcome).toBe("ADMITTED");
    expect(second.outcome).toBe("ACTIVE_DUPLICATE");
    if (first.outcome === "ADMITTED" && second.outcome === "ACTIVE_DUPLICATE") {
      expect(second.runId).toBe(first.runId);
    }
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
    expect(await events.listByRunId(first.outcome === "ADMITTED" ? first.runId : "")).toHaveLength(1);
  });

  it("returns the existing run for a repeated completed request", async () => {
    const { service, idempotency, runs } = createLocalAdmissionStack();
    const first = await service.admit(exampleAdmissionRequest());
    expect(first.outcome).toBe("ADMITTED");
    if (first.outcome === "ADMITTED") {
      const run = await runs.getById(first.runId);
      expect(run).not.toBeNull();
      await runs.save({
        ...run!,
        state: "COMPLETED",
        updatedAt: "2026-08-14T12:05:00.000Z",
      });
      await idempotency.markCompleted(
        first.idempotencyKey,
        "2026-08-14T12:05:00.000Z",
      );
    }
    const second = await service.admit(exampleAdmissionRequest());
    expect(second.outcome).toBe("COMPLETED_DUPLICATE");
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });

  it("does not create a second run for a duplicate request", async () => {
    const { service, runs } = createLocalAdmissionStack();
    await service.admit(exampleAdmissionRequest());
    await service.admit(exampleAdmissionRequest());
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });

  it("treats a changed objective version as a distinct idempotency key", async () => {
    const { service, runs, locks } = createLocalAdmissionStack();
    const first = await service.admit(
      exampleAdmissionRequest({ objectiveVersion: 1 }),
    );
    expect(first.outcome).toBe("ADMITTED");
    expect(await locks.getActiveLock(EXAMPLE_PROJECT_ID)).toBeNull();
    const second = await service.admit(
      exampleAdmissionRequest({ objectiveVersion: 2 }),
    );
    expect(second.outcome).toBe("ADMITTED");
    if (first.outcome === "ADMITTED" && second.outcome === "ADMITTED") {
      expect(second.runId).not.toBe(first.runId);
      expect(second.idempotencyKey).not.toBe(first.idempotencyKey);
    }
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(2);
  });

  it("does not create a new run when requesterId changes under the same identity", async () => {
    const { service, runs } = createLocalAdmissionStack({
      grants: [
        ...EXAMPLE_REQUESTER_GRANTS,
        {
          requesterId: "user_other",
          projectId: EXAMPLE_PROJECT_ID,
          environments: ["local"],
        },
      ],
    });
    const first = await service.admit(exampleAdmissionRequest());
    const second = await service.admit(
      exampleAdmissionRequest({ requesterId: "user_other" }),
    );
    expect(first.outcome).toBe("ADMITTED");
    expect(second.outcome).toBe("ACTIVE_DUPLICATE");
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });

  it("fails closed when content changes under the same objective identity", async () => {
    const { service, runs } = createLocalAdmissionStack();
    const first = await service.admit(exampleAdmissionRequest());
    expect(first.outcome).toBe("ADMITTED");
    const second = await service.admit(
      exampleAdmissionRequest({
        requestedOutcome: "Altered outcome under the same version",
      }),
    );
    expect(second.outcome).toBe("CONFLICT");
    if (second.outcome === "CONFLICT") {
      expect(second.reasonCode).toBe("OBJECTIVE_VERSION_CONFLICT");
    }
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });
});

describe("Admission-scoped project lock", () => {
  it("leaves no project lock held after successful admission", async () => {
    const { service, locks } = createLocalAdmissionStack();
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("ADMITTED");
    expect(await locks.getActiveLock(EXAMPLE_PROJECT_ID)).toBeNull();
  });

  it("admits a second distinct objective after the first admission completes", async () => {
    const { service, runs } = createLocalAdmissionStack();
    const first = await service.admit(
      exampleAdmissionRequest({ objectiveId: "obj_a" }),
    );
    const second = await service.admit(
      exampleAdmissionRequest({ objectiveId: "obj_b" }),
    );
    expect(first.outcome).toBe("ADMITTED");
    expect(second.outcome).toBe("ADMITTED");
    if (first.outcome === "ADMITTED" && second.outcome === "ADMITTED") {
      expect(second.runId).not.toBe(first.runId);
    }
    expect(await runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(2);
  });

  it("fails closed while another admission holds the project lock", async () => {
    const { service, locks } = createLocalAdmissionStack();
    await locks.acquire({
      projectId: EXAMPLE_PROJECT_ID,
      runId: "run_in_flight",
      lockOwner: "admission",
      acquiredAt: "2026-08-14T12:00:00.000Z",
      expiresAt: "2026-08-14T13:00:00.000Z",
    });
    const result = await service.admit(
      exampleAdmissionRequest({ objectiveId: "obj_contended" }),
    );
    expect(result.outcome).toBe("CONFLICT");
    if (result.outcome === "CONFLICT") {
      expect(result.reasonCode).toBe("PROJECT_LOCK_CONFLICT");
    }
    const held = await locks.getActiveLock(EXAMPLE_PROJECT_ID);
    expect(held?.runId).toBe("run_in_flight");
  });
});

describe("Run lifecycle", () => {
  it("transitions RECEIVED to ADMITTED on successful admission", async () => {
    const { service, runs } = createLocalAdmissionStack();
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("ADMITTED");
    if (result.outcome === "ADMITTED") {
      const run = await runs.getById(result.runId);
      expect(run?.state).toBe("ADMITTED");
      expect(run?.admittedAt).toBe("2026-08-14T12:00:00.000Z");
    }
    expect(assertTransition("RECEIVED", "ADMITTED")).toBe("ADMITTED");
  });

  it("still rejects RECEIVED → EXECUTING", () => {
    const result = transitionRunState("RECEIVED", "EXECUTING");
    expect(result.ok).toBe(false);
  });
});

describe("Event envelope", () => {
  it("creates one valid admission event bound to the run", async () => {
    const { service, events } = createLocalAdmissionStack();
    const result = await service.admit(exampleAdmissionRequest());
    expect(result.outcome).toBe("ADMITTED");
    if (result.outcome !== "ADMITTED") {
      return;
    }
    const stored = await events.listByRunId(result.runId);
    expect(stored).toHaveLength(1);
    const event = stored[0]!;
    expect(event.eventType).toBe(PROJECT_OBJECTIVE_SUBMITTED);
    expect(event.runId).toBe(result.runId);
    expect(event.projectId).toBe(EXAMPLE_PROJECT_ID);
    expect(event.objectiveId).toBe("obj_phase2_example");
    expect(event.idempotencyKey).toBe(result.idempotencyKey);
    expect(event.correlationId).toBe(result.correlationId);
    expect(event.traceId).toBe(result.traceId);
  });

  it("does not emit a second admission event for a duplicate request", async () => {
    const { service, events } = createLocalAdmissionStack();
    const first = await service.admit(exampleAdmissionRequest());
    await service.admit(exampleAdmissionRequest());
    expect(first.outcome).toBe("ADMITTED");
    if (first.outcome === "ADMITTED") {
      expect(await events.listByRunId(first.runId)).toHaveLength(1);
    }
  });
});

describe("Compensation", () => {
  it("releases the lock and reservation if run creation fails", async () => {
    const stack = createLocalAdmissionStack();
    stack.runs.failNextCreate = true;
    await expect(stack.service.admit(exampleAdmissionRequest())).rejects.toMatchObject({
      code: "RUN_CREATION_FAILED",
    } satisfies Partial<AdmissionError>);
    expect(await stack.locks.getActiveLock(EXAMPLE_PROJECT_ID)).toBeNull();
    const key = (await stack.service.admit(exampleAdmissionRequest())) as {
      outcome: string;
      idempotencyKey?: string;
    };
    expect(key.outcome).toBe("ADMITTED");
    expect(await stack.runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });

  it("releases the reservation if lock acquisition fails", async () => {
    const stack = createLocalAdmissionStack();
    stack.locks.failNextLookups(true);
    const first = await stack.service.admit(exampleAdmissionRequest());
    expect(first.outcome).toBe("CONFLICT");
    stack.locks.failNextLookups(false);
    const retry = await stack.service.admit(exampleAdmissionRequest());
    expect(retry.outcome).toBe("ADMITTED");
    expect(await stack.runs.listByProject(EXAMPLE_PROJECT_ID)).toHaveLength(1);
  });

  it("does not leave a ghost ADMITTED run after a partial failure", async () => {
    const stack = createLocalAdmissionStack();
    stack.events.failNextAppend = true;
    await expect(stack.service.admit(exampleAdmissionRequest())).rejects.toMatchObject({
      code: "EVENT_CREATION_FAILED",
    } satisfies Partial<AdmissionError>);
    const runs = await stack.runs.listByProject(EXAMPLE_PROJECT_ID);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("CANCELLED");
    expect(await stack.locks.getActiveLock(EXAMPLE_PROJECT_ID)).toBeNull();
  });

  it("surfaces compensation failure", async () => {
    const stack = createLocalAdmissionStack();
    stack.runs.failNextCreate = true;
    stack.locks.failNextRelease = true;
    await expect(stack.service.admit(exampleAdmissionRequest())).rejects.toMatchObject({
      code: "ADMISSION_COMPENSATION_FAILED",
    } satisfies Partial<AdmissionError>);
  });
});

function stackWithProjects(
  projects: Array<typeof EXAMPLE_PROJECT | typeof EXAMPLE_SUSPENDED_PROJECT>,
) {
  return stackWith({
    projects: new InMemoryProjectRegistry(projects),
  });
}

function stackWithPolicies(policies: Array<typeof EXAMPLE_POLICY_BUNDLE>) {
  const clockIso = "2026-08-14T12:00:00.000Z";
  return stackWith({
    policies: new InMemoryPolicyRegistry(policies, {
      clock: { nowIso: () => clockIso },
    }),
  });
}

function stackWithBudgets(budgets: Array<typeof EXAMPLE_BUDGET>) {
  return stackWith({
    budgets: new InMemoryResourceBudgetRegistry(budgets),
  });
}

function stackWith(overrides: {
  projects?: InMemoryProjectRegistry;
  policies?: InMemoryPolicyRegistry;
  budgets?: InMemoryResourceBudgetRegistry;
}) {
  const base = createLocalAdmissionStack();
  const clock = base.clock;
  const projects =
    overrides.projects ?? new InMemoryProjectRegistry([EXAMPLE_PROJECT]);
  const policies =
    overrides.policies ??
    new InMemoryPolicyRegistry([EXAMPLE_POLICY_BUNDLE], { clock });
  const budgets =
    overrides.budgets ?? new InMemoryResourceBudgetRegistry([EXAMPLE_BUDGET]);
  const controlPlane = new ControlPlaneService({
    projects,
    capabilities: new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES),
    policies,
    budgets,
    clock,
  });
  const service = new ObjectiveAdmissionService({
    controlPlane,
    authorization: new InMemoryRequesterAuthorization([
      ...EXAMPLE_REQUESTER_GRANTS,
      {
        requesterId: EXAMPLE_REQUESTER_ID,
        projectId: EXAMPLE_SUSPENDED_PROJECT.projectId,
        environments: ["local"],
      },
    ]),
    idempotency: base.idempotency,
    locks: base.locks,
    runs: base.runs,
    events: base.events,
    identities: {
      next: () => ({
        runId: "run_custom",
        eventId: "evt_custom",
        correlationId: "corr_custom",
        traceId: "trace_custom",
      }),
    },
    clock,
    observability: new NoopObservability(),
  });
  return { service, runs: base.runs, events: base.events, locks: base.locks };
}
