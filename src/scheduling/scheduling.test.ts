import { describe, expect, it } from "vitest";
import { candidateWorkKinds, bindingHashForWorkKind } from "./discovery-map.js";
import { discoveryMaterializationKinds } from "./discovery-actionable.js";
import { detectDependencyCycle } from "./dependency.js";
import { evaluateEligibility } from "./eligibility.js";
import {
  applyFairnessCharge,
  createFairnessState,
  getProjectDeficit,
} from "./fairness.js";
import { computeSchedulingScore, compareCandidates } from "./score.js";
import { workLogicalIdentityKey, workItemIdFromIdentity } from "./identity.js";
import { parseSchedulerWorkItem } from "./work-item.js";
import {
  InMemorySchedulerWorkItemRepository,
  InMemorySchedulerDependencyRepository,
  InMemorySchedulerDecisionRepository,
  InMemorySchedulerProjectConfigRepository,
  InMemorySchedulerPauseRepository,
  InMemorySchedulerFairnessRepository,
  InMemorySchedulerLeaseStore,
} from "./memory-repositories.js";
import {
  PortfolioSchedulerService,
  type RunArtifactProbe,
} from "./service.js";
import type { RunRecord } from "../admission/run-repository.js";
import type { RunRepository } from "../admission/run-repository.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function baseWork(
  overrides: Partial<ReturnType<typeof parseSchedulerWorkItem>> = {},
) {
  return parseSchedulerWorkItem({
    workItemId: "sw_1",
    projectId: "proj_a",
    runId: "run_a",
    workKind: "PLAN_RUN",
    status: "ELIGIBLE",
    priorityClass: "NORMAL",
    logicalIdentityKey: "id_1",
    bindingHash: "bind_1",
    createdAt: "2026-01-01T00:00:00.000Z",
    eligibleAt: "2026-01-01T00:00:00.000Z",
    attemptCount: 0,
    maxAttempts: 5,
    recordRevision: 1,
    dependencySetHash: "dep_empty",
    schedulingMetadataHash: "meta_1",
    ...overrides,
  });
}

describe("candidateWorkKinds", () => {
  it("maps ADMITTED to ingest only", () => {
    expect(candidateWorkKinds({ runState: "ADMITTED" })).toEqual([
      "INGEST_REPOSITORY",
    ]);
  });

  it("maps INGESTING with verified repo to PLAN_RUN", () => {
    expect(
      candidateWorkKinds({
        runState: "INGESTING",
        hasVerifiedRepository: true,
      }),
    ).toEqual(["PLAN_RUN"]);
  });

  it("stops at AWAITING_APPROVAL with no execution work", () => {
    expect(
      candidateWorkKinds({
        runState: "AWAITING_APPROVAL",
        hasValidationPassOrApprovalRequired: true,
        hasAuthorizationRecord: false,
      }),
    ).toEqual([]);
  });

  it("routes after validation terminal while still VALIDATING", () => {
    expect(
      candidateWorkKinds({
        runState: "VALIDATING",
        hasPlan: true,
        hasValidationPassOrApprovalRequired: true,
      }),
    ).toEqual(["ROUTE_AUTHORIZATION"]);
  });

  it("schedules VALIDATE_PLAN when VALIDATING without decision", () => {
    expect(
      candidateWorkKinds({
        runState: "VALIDATING",
        hasPlan: true,
        hasValidationPassOrApprovalRequired: false,
      }),
    ).toEqual(["VALIDATE_PLAN"]);
  });

  it("schedules EXECUTE_PLAN only after APPROVED", () => {
    expect(candidateWorkKinds({ runState: "APPROVED" })).toEqual([
      "EXECUTE_PLAN",
    ]);
  });

  it("does not progress BLOCKED / CONTAINED", () => {
    expect(candidateWorkKinds({ runState: "BLOCKED" })).toEqual([]);
    expect(candidateWorkKinds({ runState: "CONTAINED" })).toEqual([]);
  });
});

describe("discoveryMaterializationKinds", () => {
  it("maps ADMITTED rediscovery exclusion to INGEST only", () => {
    expect(discoveryMaterializationKinds("ADMITTED")).toEqual([
      "INGEST_REPOSITORY",
    ]);
  });
});

describe("bindingHashForWorkKind", () => {
  it("changes when plan hash changes", () => {
    const a = bindingHashForWorkKind("VALIDATE_PLAN", {
      runId: "r1",
      planVersion: 1,
      planHash: "h1",
    });
    const b = bindingHashForWorkKind("VALIDATE_PLAN", {
      runId: "r1",
      planVersion: 1,
      planHash: "h2",
    });
    expect(a).not.toBe(b);
  });
});

describe("work identity", () => {
  it("is deterministic", () => {
    const key = workLogicalIdentityKey({
      runId: "run_1",
      workKind: "PLAN_RUN",
      bindingHash: "fp",
    });
    const key2 = workLogicalIdentityKey({
      runId: "run_1",
      workKind: "PLAN_RUN",
      bindingHash: "fp",
    });
    expect(key).toBe(key2);
    expect(workItemIdFromIdentity(key)).toBe(workItemIdFromIdentity(key2));
    expect(key).not.toBe(
      workLogicalIdentityKey({
        runId: "run_1",
        workKind: "VALIDATE_PLAN",
        bindingHash: "fp",
      }),
    );
  });
});

describe("dependency cycle detection", () => {
  it("rejects A→B→C→A", () => {
    const result = detectDependencyCycle([
      { dependentRunId: "A", prerequisiteRunId: "B" },
      { dependentRunId: "B", prerequisiteRunId: "C" },
      { dependentRunId: "C", prerequisiteRunId: "A" },
    ]);
    expect(result.cyclic).toBe(true);
  });

  it("accepts acyclic graphs", () => {
    expect(
      detectDependencyCycle([
        { dependentRunId: "B", prerequisiteRunId: "A" },
        { dependentRunId: "C", prerequisiteRunId: "A" },
      ]).cyclic,
    ).toBe(false);
  });
});

describe("eligibility", () => {
  it("blocks when paused or over capacity", () => {
    const work = baseWork();
    expect(
      evaluateEligibility({
        work,
        nowIso: "2026-01-01T01:00:00.000Z",
        projectPaused: true,
        globalPaused: false,
        dependenciesSatisfied: true,
        dependencyUnsatisfiable: false,
        projectActiveClaims: 0,
        projectMaxConcurrency: 2,
        globalActiveClaims: 0,
        globalMaxConcurrency: 10,
        workerSupports: true,
      }).reason,
    ).toBe("PROJECT_PAUSED");
    expect(
      evaluateEligibility({
        work,
        nowIso: "2026-01-01T01:00:00.000Z",
        projectPaused: false,
        globalPaused: false,
        dependenciesSatisfied: true,
        dependencyUnsatisfiable: false,
        projectActiveClaims: 2,
        projectMaxConcurrency: 2,
        globalActiveClaims: 0,
        globalMaxConcurrency: 10,
        workerSupports: true,
      }).reason,
    ).toBe("PROJECT_CAPACITY");
  });
});

describe("fairness and aging", () => {
  it("gives starved project deficit advantage", () => {
    const state = createFairnessState();
    const weights = new Map([
      ["proj_a", 1],
      ["proj_b", 1],
    ]);
    for (let i = 0; i < 20; i++) {
      applyFairnessCharge(state, "proj_a", weights);
    }
    expect(getProjectDeficit(state, "proj_b")).toBeGreaterThan(
      getProjectDeficit(state, "proj_a"),
    );
    const scoreA = computeSchedulingScore({
      priorityClass: "NORMAL",
      waitingAgeMs: 0,
      projectWeight: 1,
      projectDeficit: getProjectDeficit(state, "proj_a"),
    });
    const scoreB = computeSchedulingScore({
      priorityClass: "NORMAL",
      waitingAgeMs: 0,
      projectWeight: 1,
      projectDeficit: getProjectDeficit(state, "proj_b"),
    });
    expect(scoreB).toBeGreaterThan(scoreA);
  });

  it("ages LOW work above younger BACKGROUND", () => {
    const oldLow = computeSchedulingScore({
      priorityClass: "LOW",
      waitingAgeMs: 60 * 60_000,
      projectWeight: 1,
      projectDeficit: 0,
    });
    const youngBg = computeSchedulingScore({
      priorityClass: "BACKGROUND",
      waitingAgeMs: 0,
      projectWeight: 1,
      projectDeficit: 0,
    });
    expect(oldLow).toBeGreaterThan(youngBg);
  });

  it("HIGH outranks NORMAL with equal age", () => {
    const high = computeSchedulingScore({
      priorityClass: "HIGH",
      waitingAgeMs: 0,
      projectWeight: 1,
      projectDeficit: 0,
    });
    const normal = computeSchedulingScore({
      priorityClass: "NORMAL",
      waitingAgeMs: 0,
      projectWeight: 1,
      projectDeficit: 0,
    });
    expect(high).toBeGreaterThan(normal);
  });

  it("compareCandidates is deterministic", () => {
    expect(
      compareCandidates(
        { score: 10, workItemId: "b", createdAt: "2026-01-01T00:00:00.000Z" },
        { score: 10, workItemId: "a", createdAt: "2026-01-01T00:00:00.000Z" },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("PortfolioSchedulerService memory", () => {
  function memoryStack(runs: Map<string, RunRecord>) {
    const runRepo: RunRepository = {
      async create(run) {
        runs.set(run.runId, run);
        return run;
      },
      async getById(id) {
        return runs.get(id) ?? null;
      },
      async exists(id) {
        return runs.has(id);
      },
      async save(run) {
        runs.set(run.runId, run);
        return run;
      },
      async listByProject(projectId) {
        return [...runs.values()].filter((r) => r.projectId === projectId);
      },
      async transition(runId, _expected, _rev, next, updatedAt) {
        const current = runs.get(runId);
        if (!current) {
          throw new Error("missing");
        }
        const updated = { ...current, state: next, updatedAt };
        runs.set(runId, updated);
        return updated;
      },
    };
    const artifacts: RunArtifactProbe = {
      async hasVerifiedRepository() {
        return false;
      },
      async hasPlan() {
        return false;
      },
      async planBinding() {
        return null;
      },
      async hasValidationPassOrApprovalRequired() {
        return false;
      },
      async validationDecisionId() {
        return null;
      },
      async authorizationRecordId() {
        return null;
      },
      async executionAttemptId() {
        return null;
      },
      async hasExecutionTerminalForVerification() {
        return false;
      },
      async completionRecord() {
        return null;
      },
      async hasLearned() {
        return false;
      },
      async hasObservabilitySnapshot() {
        return false;
      },
    };
    const workItems = new InMemorySchedulerWorkItemRepository();
    const fairness = new InMemorySchedulerFairnessRepository();
    const leases = new InMemorySchedulerLeaseStore();
    workItems.bindLeaseLiveCheck((key) => leases.isLiveHeldSync(key));
    const service = new PortfolioSchedulerService({
      runs: runRepo,
      workItems,
      dependencies: new InMemorySchedulerDependencyRepository(),
      decisions: new InMemorySchedulerDecisionRepository(),
      projectConfigs: new InMemorySchedulerProjectConfigRepository(),
      pauses: new InMemorySchedulerPauseRepository(),
      fairness,
      artifacts,
      leases,
      nowIso: () => "2026-01-01T00:00:00.000Z",
      globalMaxConcurrency: 4,
      runtimeId: "rt_test",
    });
    return { service, workItems, artifacts, runs, fairness, leases };
  }

  it("materializes ingest work idempotently", async () => {
    const runs = new Map<string, RunRecord>();
    const run = {
      runId: "run_1",
      projectId: "proj_1",
      state: "ADMITTED" as const,
      objectiveId: "obj_1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      recordRevision: 1,
    };
    // Use a minimal RunRecord — fill required fields from schema if needed
    runs.set("run_1", run as RunRecord);
    const { service, workItems } = memoryStack(runs);
    const first = await service.discoverForRun("run_1");
    const second = await service.discoverForRun("run_1");
    expect(first.created).toHaveLength(1);
    expect(second.created).toHaveLength(0);
    expect(second.reused).toHaveLength(1);
    expect((await workItems.listByRun("run_1")).length).toBe(1);
  });

  it("rejects self and cyclic dependencies", async () => {
    const runs = new Map<string, RunRecord>();
    for (const id of ["run_a", "run_b", "run_c"]) {
      runs.set(id, {
        runId: id,
        projectId: "proj_1",
        state: "ADMITTED",
      } as RunRecord);
    }
    const { service } = memoryStack(runs);
    await expect(
      service.registerDependency({
        projectId: "proj_1",
        dependentRunId: "run_a",
        prerequisiteRunId: "run_a",
        requiredMilestone: "COMPLETED",
      }),
    ).rejects.toMatchObject({ code: "SELF_DEPENDENCY" });

    await service.registerDependency({
      projectId: "proj_1",
      dependentRunId: "run_b",
      prerequisiteRunId: "run_a",
      requiredMilestone: "COMPLETED",
    });
    await service.registerDependency({
      projectId: "proj_1",
      dependentRunId: "run_c",
      prerequisiteRunId: "run_b",
      requiredMilestone: "COMPLETED",
    });
    await expect(
      service.registerDependency({
        projectId: "proj_1",
        dependentRunId: "run_a",
        prerequisiteRunId: "run_c",
        requiredMilestone: "COMPLETED",
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
  });

  it("rejects cross-project dependencies", async () => {
    const runs = new Map<string, RunRecord>();
    runs.set("run_a", {
      runId: "run_a",
      projectId: "proj_1",
      state: "ADMITTED",
    } as RunRecord);
    runs.set("run_b", {
      runId: "run_b",
      projectId: "proj_2",
      state: "ADMITTED",
    } as RunRecord);
    const { service } = memoryStack(runs);
    await expect(
      service.registerDependency({
        projectId: "proj_1",
        dependentRunId: "run_a",
        prerequisiteRunId: "run_b",
        requiredMilestone: "COMPLETED",
      }),
    ).rejects.toMatchObject({ code: "CROSS_PROJECT_DEPENDENCY_DENIED" });
  });

  it("credits durable fairness only after successful atomic claim", async () => {
    const runs = new Map<string, RunRecord>();
    const { service, workItems } = memoryStack(runs);
    await service.upsertProjectConfig({
      projectId: "proj_a",
      maxConcurrency: 4,
      weight: 1,
    });
    await service.upsertProjectConfig({
      projectId: "proj_b",
      maxConcurrency: 4,
      weight: 1,
    });
    await workItems.save(
      baseWork({
        workItemId: "sw_a",
        runId: "run_a",
        logicalIdentityKey: "id_a",
        status: "ELIGIBLE",
        projectId: "proj_a",
      }),
    );
    await workItems.save(
      baseWork({
        workItemId: "sw_b",
        runId: "run_b",
        logicalIdentityKey: "id_b",
        status: "ELIGIBLE",
        projectId: "proj_b",
      }),
    );
    expect((await service.loadFairnessView()).deficits.size).toBe(0);
    const { claimed, decision } = await service.selectAndClaimWork({
      workerCapabilities: ["ALL"],
      ownerId: "owner",
    });
    expect(claimed).toBeTruthy();
    expect(decision.fairnessInputs["event"]).toBe("SERVICE_CREDIT");
    const after = await service.loadFairnessView();
    const other = claimed!.projectId === "proj_a" ? "proj_b" : "proj_a";
    expect(after.deficits.get(other) ?? 0).toBeGreaterThan(0);
  });

  it("noisy project cannot hide peer projects from contender discovery", async () => {
    const runs = new Map<string, RunRecord>();
    const { service, workItems } = memoryStack(runs);
    for (const projectId of ["proj_a", "proj_b", "proj_c"]) {
      await service.upsertProjectConfig({
        projectId,
        maxConcurrency: 64,
        weight: 1,
      });
    }
    for (let i = 0; i < 100; i++) {
      await workItems.save(
        baseWork({
          workItemId: `sw_a_${i}`,
          runId: `run_a_${i}`,
          logicalIdentityKey: `id_a_${i}`,
          status: "ELIGIBLE",
          projectId: "proj_a",
        }),
      );
    }
    await workItems.save(
      baseWork({
        workItemId: "sw_b",
        runId: "run_b",
        logicalIdentityKey: "id_b",
        status: "ELIGIBLE",
        projectId: "proj_b",
      }),
    );
    await workItems.save(
      baseWork({
        workItemId: "sw_c",
        runId: "run_c",
        logicalIdentityKey: "id_c",
        status: "ELIGIBLE",
        projectId: "proj_c",
      }),
    );
    const { selected, decision } = await service.selectWork({
      workerCapabilities: ["ALL"],
      perProjectLimit: 5,
    });
    expect(selected).toBeTruthy();
    const projects = decision.fairnessInputs["candidateProjects"] as string[];
    expect(projects).toEqual(
      expect.arrayContaining(["proj_a", "proj_b", "proj_c"]),
    );
  });

  it("stale fairness revision writes are rejected", async () => {
    const runs = new Map<string, RunRecord>();
    const { service, workItems, fairness } = memoryStack(runs);
    await service.upsertProjectConfig({
      projectId: "proj_a",
      maxConcurrency: 4,
      weight: 1,
    });
    await workItems.save(
      baseWork({
        workItemId: "sw_a",
        runId: "run_a",
        logicalIdentityKey: "id_a",
        status: "ELIGIBLE",
        projectId: "proj_a",
      }),
    );
    await service.selectAndClaimWork({
      workerCapabilities: ["ALL"],
      ownerId: "owner",
    });
    const rows = await fairness.listAll();
    const target = rows.find((row) => row.projectId === "proj_a");
    expect(target).toBeTruthy();
    await expect(
      fairness.writeRowsCas({
        rows: [
          {
            ...target!,
            deficit: 999,
            recordRevision: target!.recordRevision + 1,
          },
        ],
        // Intentionally stale vs durable revision after the successful charge.
        expectedRevisions: new Map([
          ["proj_a", Math.max(0, target!.recordRevision - 1)],
        ]),
        decisionId: "stale_writer",
      }),
    ).rejects.toMatchObject({ code: "SCHEDULER_CAS_CONFLICT" });
  });

  it("reconciles expired CLAIMED back to ELIGIBLE without touching RUNNING", async () => {
    const runs = new Map<string, RunRecord>();
    const { service, workItems, leases } = memoryStack(runs);
    await service.upsertProjectConfig({
      projectId: "proj_a",
      maxConcurrency: 4,
      weight: 1,
    });
    await workItems.save(
      baseWork({
        workItemId: "sw_claimed_expired",
        runId: "run_c",
        logicalIdentityKey: "id_c",
        status: "ELIGIBLE",
      }),
    );
    await workItems.save(
      baseWork({
        workItemId: "sw_running",
        runId: "run_r",
        logicalIdentityKey: "id_r",
        status: "ELIGIBLE",
      }),
    );
    const claimed = await service.selectAndClaimWork({
      workerCapabilities: ["ALL"],
      ownerId: "owner_c",
    });
    expect(claimed.claimed?.workItemId).toBe("sw_claimed_expired");
    // Expire the lease in-memory without changing work status.
    await leases.release({
      coordinationKey: `scheduler:work:${claimed.claimed!.workItemId}`,
      ownerId: "owner_c",
      fenceToken: claimed.lease!.fenceToken,
    });
    const runningSeed = await workItems.getById("sw_running");
    await workItems.updateCas(
      {
        ...runningSeed!,
        status: "RUNNING",
        claimOwnerId: "owner_r",
        fenceToken: 1,
      },
      runningSeed!.recordRevision,
    );
    const recovered = await service.reconcileExpiredClaimedWork();
    expect(recovered).toBe(1);
    expect((await workItems.getById("sw_claimed_expired"))?.status).toBe(
      "ELIGIBLE",
    );
    expect((await workItems.getById("sw_running"))?.status).toBe("RUNNING");
  });

  it("enforces project concurrency in selectWork", async () => {
    const runs = new Map<string, RunRecord>();
    const { service, workItems } = memoryStack(runs);
    await service.upsertProjectConfig({
      projectId: "proj_a",
      maxConcurrency: 2,
      weight: 1,
    });
    for (let i = 0; i < 5; i++) {
      await workItems.save(
        baseWork({
          workItemId: `sw_${i}`,
          runId: `run_${i}`,
          logicalIdentityKey: `id_${i}`,
          status: "ELIGIBLE",
        }),
      );
    }
    const held = [];
    for (let i = 0; i < 2; i++) {
      const result = await service.selectAndClaimWork({
        workerCapabilities: ["ALL"],
        ownerId: `owner_${i}`,
      });
      expect(result.claimed).toBeTruthy();
      held.push(result);
    }
    expect(await workItems.countActiveByProject("proj_a")).toBe(2);
    const { selected } = await service.selectWork({
      workerCapabilities: ["ALL"],
    });
    expect(selected).toBeNull();
  });
});

describe("no model imports in scheduling", () => {
  it("scheduling sources do not import OpenAI/Anthropic/model packages", () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const files = [
      "service.ts",
      "dispatcher.ts",
      "discovery-map.ts",
      "score.ts",
      "fairness.ts",
      "eligibility.ts",
    ];
    const banned = [
      /from ["'].*openai/i,
      /from ["'].*anthropic/i,
      /@anthropic-ai/,
      /PlanningModel/,
      /InferencePort/,
    ];
    for (const file of files) {
      const body = readFileSync(path.join(dir, file), "utf8");
      for (const pattern of banned) {
        expect(body).not.toMatch(pattern);
      }
    }
  });
});
