import { describe, expect, it } from "vitest";
import {
  buildPostgresTestAdmissionRequest,
  createIndependentDatabase,
  createTestStack,
  uniquePostgresTestId,
  waitUntilPostgresLeaseExpired,
} from "./test-helpers.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import {
  SchedulerClaimLoop,
  SchedulerDiscoveryLoop,
  SchedulerDispatcher,
  parseSchedulerWorkItem,
  workLogicalIdentityKey,
  workItemIdFromIdentity,
  type SchedulerWorkStateWriter,
} from "../../scheduling/index.js";
import { deliveredNonce } from "./postgres-lifecycle-helpers.js";
import { PostgresLeaseStore } from "./leases.js";
import {
  seedDedicatedPostgresTestProject,
} from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";

type Stack = Awaited<ReturnType<typeof createTestStack>>["stack"];

function claimPorts(
  stack: Stack,
  runtimeId = stack.instanceId,
  projectIds?: readonly string[],
) {
  return {
    scheduler: stack.scheduler,
    createDispatcher: (writer: SchedulerWorkStateWriter) =>
      new SchedulerDispatcher(writer, stack.schedulerPorts),
    leases: stack.leases,
    listDiscoverableRunIds: stack.listDiscoverableRunIds,
    databaseReachable: () => stack.db.ping(),
    isAccepting: () => true,
    runtimeId,
    workerCapabilities: ["ALL"] as const,
    discoveryBatchSize: 50,
    claimBatchSize: 1,
    ...(projectIds ? { projectIds } : {}),
  };
}

async function driveDiscoveryAndClaim(
  stack: Stack,
  cycles: number,
  projectIds?: readonly string[],
  focusRunId?: string,
): Promise<void> {
  const ports = {
    ...claimPorts(stack, stack.instanceId, projectIds),
    ...(focusRunId
      ? {
          listDiscoverableRunIds: async () => [focusRunId],
          discoveryBatchSize: 1,
        }
      : {}),
  };
  const discovery = new SchedulerDiscoveryLoop(ports);
  const claim = new SchedulerClaimLoop(ports);
  for (let i = 0; i < cycles; i++) {
    await discovery.tick();
    await claim.tick();
  }
}

async function seedEligibleWork(
  stack: Stack,
  input: {
    projectId: string;
    count: number;
    priorityClass?: "CRITICAL" | "HIGH" | "NORMAL" | "LOW" | "BACKGROUND";
    eligibleAt?: string;
  },
): Promise<string[]> {
  const now = input.eligibleAt ?? new Date().toISOString();
  const ids: string[] = [];
  for (let i = 0; i < input.count; i++) {
    const workItemId = uniquePostgresTestId(`sw${i}`);
    ids.push(workItemId);
    await stack.schedulerWorkItems.save(
      parseSchedulerWorkItem({
        workItemId,
        projectId: input.projectId,
        runId: uniquePostgresTestId(`run${i}`),
        workKind: "BUILD_OBSERVABILITY",
        status: "ELIGIBLE",
        priorityClass: input.priorityClass ?? "NORMAL",
        logicalIdentityKey: uniquePostgresTestId(`id${i}`),
        bindingHash: `bind_${i}`,
        createdAt: now,
        eligibleAt: now,
        attemptCount: 0,
        maxAttempts: 5,
        recordRevision: 1,
        dependencySetHash: "empty",
        schedulingMetadataHash: "meta",
      }),
    );
  }
  return ids;
}

async function claimWithoutDispatch(
  stack: Stack,
  opts?: { projectIds?: readonly string[] },
): Promise<{
  claimed: boolean;
  projectId?: string;
  decisionId?: string;
  fairnessRevisionBefore?: Record<string, number>;
}> {
  const { claimed, decision, lease } = await stack.scheduler.selectAndClaimWork({
    workerCapabilities: ["ALL"],
    ownerId: stack.instanceId,
    ...(opts?.projectIds ? { projectIds: opts.projectIds } : {}),
  });
  if (!claimed || !lease) {
    return { claimed: false };
  }
  const coordinationKey = `scheduler:work:${claimed.workItemId}`;
  // Settle claim without phase dispatch so fairness tests stay operational.
  const current = await stack.schedulerWorkItems.getById(claimed.workItemId);
  if (current) {
    await stack.schedulerWorkItems.updateCas(
      {
        ...current,
        status: "SUCCEEDED",
        claimOwnerId: undefined,
        fenceToken: undefined,
        leaseExpiresAt: undefined,
      },
      current.recordRevision,
    );
  }
  try {
    await stack.leases.release({
      coordinationKey,
      ownerId: stack.instanceId,
      fenceToken: lease.fenceToken,
    });
  } catch {
    // best-effort
  }
  return {
    claimed: true,
    projectId: claimed.projectId,
    decisionId: decision.decisionId,
    fairnessRevisionBefore: decision.fairnessInputs[
      "fairnessRevisionBefore"
    ] as Record<string, number> | undefined,
  };
}

describe("Phase 13 portfolio scheduler (postgres)", () => {
  it("idempotent discovery and human approval barrier + autonomous progression", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-barrier"));
    try {
      const projectId = `p13_bar_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const request = buildPostgresTestAdmissionRequest({
        testName: "p13-barrier",
        learnable: true,
        projectId,
      });
      const admitted = await env.stack.admission.admit(request);
      expect(admitted.outcome).toBe("ADMITTED");
      const runId = admitted.runId!;

      await driveDiscoveryAndClaim(env.stack, 12, [projectId], runId);

      const run = await env.stack.runs.getById(runId);
      expect(run?.state).toBe("AWAITING_APPROVAL");
      expect(await env.stack.execution.getLatestAttempt(runId)).toBeNull();
      expect(
        await env.stack.authorizationRecords.getLatestByRun(runId),
      ).toBeNull();

      const workBefore = await env.stack.scheduler.listWorkForRun(runId);
      expect(
        workBefore.some((item) => item.workKind === "EXECUTE_PLAN"),
      ).toBe(false);
      expect(
        workBefore.some((item) => item.workKind === "ROUTE_AUTHORIZATION"),
      ).toBe(true);

      await driveDiscoveryAndClaim(env.stack, 5, [projectId], runId);
      expect((await env.stack.runs.getById(runId))?.state).toBe(
        "AWAITING_APPROVAL",
      );
      expect(await env.stack.execution.getLatestAttempt(runId)).toBeNull();
      expect(
        await env.stack.authorizationRecords.getLatestByRun(runId),
      ).toBeNull();

      const approval = await env.stack.approvalRequests.getPendingByRun(runId);
      expect(approval).toBeTruthy();
      const nonce = deliveredNonce(
        env.stack.approvalDelivery,
        approval!.approvalRequestId,
      );
      const decided = await env.stack.humanAuthorization.decide({
        approvalRequestId: approval!.approvalRequestId,
        approverId: "approver_bootstrap",
        decision: "APPROVE",
        decisionNonce: nonce,
        submittedAt: new Date().toISOString(),
      });
      expect(decided.result).toBe("APPROVED");

      await driveDiscoveryAndClaim(env.stack, 20, [projectId], runId);
      const terminal = await env.stack.runs.getById(runId);
      expect(terminal?.state).toBe("COMPLETED");
      const completion = await env.stack.schedulerArtifacts.completionRecord(
        runId,
      );
      expect(completion).toBeTruthy();
      expect(
        await env.stack.authorizationRecords.getLatestByRun(runId),
      ).toBeTruthy();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("COMPLETED dependency requires CompletionRecord", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-dep"));
    try {
      const reqA = buildPostgresTestAdmissionRequest({
        testName: "p13-dep-a",
      });
      const reqB = buildPostgresTestAdmissionRequest({
        testName: "p13-dep-b",
      });
      const a = await env.stack.admission.admit(reqA);
      const b = await env.stack.admission.admit(reqB);
      expect(a.outcome).toBe("ADMITTED");
      expect(b.outcome).toBe("ADMITTED");
      await env.stack.scheduler.registerDependency({
        projectId: reqA.projectId,
        dependentRunId: b.runId!,
        prerequisiteRunId: a.runId!,
        requiredMilestone: "COMPLETED",
      });

      const runA = await env.stack.runs.getById(a.runId!);
      try {
        await env.stack.runs.save({
          ...runA!,
          state: "COMPLETED",
          updatedAt: new Date().toISOString(),
        });
        const sat = await env.stack.scheduler.areDependenciesSatisfied(b.runId!);
        expect(sat.satisfied).toBe(false);
      } finally {
        await env.stack.runs.save({
          ...runA!,
          updatedAt: new Date().toISOString(),
        });
      }
    } finally {
      await env.close();
    }
  }, 60_000);

  it("rejects dependency cycles", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-cycle"));
    try {
      const runs = [];
      for (const name of ["a", "b", "c"]) {
        const admitted = await env.stack.admission.admit(
          buildPostgresTestAdmissionRequest({ testName: `p13-cyc-${name}` }),
        );
        expect(admitted.outcome).toBe("ADMITTED");
        runs.push(admitted.runId!);
      }
      const projectId = (await env.stack.runs.getById(runs[0]!))!.projectId;
      await env.stack.scheduler.registerDependency({
        projectId,
        dependentRunId: runs[1]!,
        prerequisiteRunId: runs[0]!,
        requiredMilestone: "COMPLETED",
      });
      await env.stack.scheduler.registerDependency({
        projectId,
        dependentRunId: runs[2]!,
        prerequisiteRunId: runs[1]!,
        requiredMilestone: "COMPLETED",
      });
      await expect(
        env.stack.scheduler.registerDependency({
          projectId,
          dependentRunId: runs[0]!,
          prerequisiteRunId: runs[2]!,
          requiredMilestone: "COMPLETED",
        }),
      ).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
    } finally {
      await env.close();
    }
  }, 60_000);

  it("project concurrency cap bounds active claims", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-cap"), {
      schedulerGlobalMaxConcurrency: 32,
    });
    try {
      const projectId = `p13_cap_${uniquePostgresTestId("p")}`;
      const otherProjectId = `p13_cap_o_${uniquePostgresTestId("o")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      await seedDedicatedPostgresTestProject(env.stack.db, otherProjectId);
      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 2,
        weight: 1,
      });
      await env.stack.scheduler.upsertProjectConfig({
        projectId: otherProjectId,
        maxConcurrency: 64,
        weight: 1,
      });
      await seedEligibleWork(env.stack, { projectId, count: 8 });

      const held: Array<{
        workItemId: string;
        ownerId: string;
        fenceToken: number;
      }> = [];
      const projectItems = await env.stack.schedulerWorkItems.listByProject(
        projectId,
      );
      const eligible = projectItems.filter((item) => item.status === "ELIGIBLE");
      expect(eligible.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < 2; i++) {
        const work = eligible[i]!;
        const ownerId = `${env.stack.instanceId}-hold-${i}`;
        const coordinationKey = `scheduler:work:${work.workItemId}`;
        const lease = await env.stack.leases.acquire({
          coordinationKey,
          phase: "SCHEDULER",
          ownerId,
        });
        await env.stack.scheduler.markClaimed(
          work,
          ownerId,
          lease.fenceToken,
          lease.leaseExpiresAt,
        );
        held.push({
          workItemId: work.workItemId,
          ownerId,
          fenceToken: lease.fenceToken,
        });
      }
      expect(held).toHaveLength(2);
      expect(
        await env.stack.schedulerWorkItems.countActiveByProject(projectId),
      ).toBe(2);

      // Next selection must not grant another live claim to the capped project.
      const { selected } = await env.stack.scheduler.selectWork({
        workerCapabilities: ["ALL"],
      });
      expect(selected === null || selected.projectId !== projectId).toBe(true);

      await seedEligibleWork(env.stack, {
        projectId: otherProjectId,
        count: 3,
      });
      let gotOther = false;
      for (let i = 0; i < 10; i++) {
        const ownerId = `${env.stack.instanceId}-other-${i}`;
        const result = await env.stack.scheduler.selectAndClaimWork({
          workerCapabilities: ["ALL"],
          ownerId,
          projectIds: [otherProjectId],
        });
        if (!result.claimed || !result.lease) {
          break;
        }
        expect(result.claimed.projectId).toBe(otherProjectId);
        gotOther = true;
        const current = await env.stack.schedulerWorkItems.getById(
          result.claimed.workItemId,
        );
        if (current) {
          await env.stack.schedulerWorkItems.updateCas(
            {
              ...current,
              status: "SUCCEEDED",
              claimOwnerId: undefined,
              fenceToken: undefined,
              leaseExpiresAt: undefined,
            },
            current.recordRevision,
          );
        }
        try {
          await env.stack.leases.release({
            coordinationKey: `scheduler:work:${result.claimed.workItemId}`,
            ownerId,
            fenceToken: result.lease.fenceToken,
          });
        } catch {
          // best-effort
        }
        break;
      }
      expect(gotOther).toBe(true);

      for (const item of held) {
        const current = await env.stack.schedulerWorkItems.getById(
          item.workItemId,
        );
        if (
          current &&
          (current.status === "CLAIMED" || current.status === "RUNNING")
        ) {
          await env.stack.schedulerWorkItems.updateCas(
            {
              ...current,
              status: "SUCCEEDED",
              claimOwnerId: undefined,
              fenceToken: undefined,
              leaseExpiresAt: undefined,
            },
            current.recordRevision,
          );
        }
        try {
          await env.stack.leases.release({
            coordinationKey: `scheduler:work:${item.workItemId}`,
            ownerId: item.ownerId,
            fenceToken: item.fenceToken,
          });
        } catch {
          // best-effort
        }
      }
    } finally {
      await env.close();
    }
  }, 90_000);

  it("global concurrency cap bounds active claims", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-gcap"), {
      schedulerGlobalMaxConcurrency: 2,
    });
    try {
      await env.stack.scheduler.reconcileExpiredClaimedWork(5_000);
      const baseline =
        await env.stack.schedulerWorkItems.countActiveGlobal();
      expect(baseline).toBe(0);

      const projectA = `p13_ga_${uniquePostgresTestId("a")}`;
      const projectB = `p13_gb_${uniquePostgresTestId("b")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectA,
        maxConcurrency: 64,
        weight: 1,
      });
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectB,
        maxConcurrency: 64,
        weight: 1,
      });
      await seedEligibleWork(env.stack, { projectId: projectA, count: 10 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 10 });

      const held: Array<{
        workItemId: string;
        ownerId: string;
        fenceToken: number;
      }> = [];
      const seeded = [
        ...(await env.stack.schedulerWorkItems.listByProject(projectA)),
        ...(await env.stack.schedulerWorkItems.listByProject(projectB)),
      ].filter((item) => item.status === "ELIGIBLE");
      expect(seeded.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < 2; i++) {
        const work = seeded[i]!;
        const ownerId = `${env.stack.instanceId}-ghold-${i}`;
        const lease = await env.stack.leases.acquire({
          coordinationKey: `scheduler:work:${work.workItemId}`,
          phase: "SCHEDULER",
          ownerId,
        });
        await env.stack.scheduler.markClaimed(
          work,
          ownerId,
          lease.fenceToken,
          lease.leaseExpiresAt,
        );
        held.push({
          workItemId: work.workItemId,
          ownerId,
          fenceToken: lease.fenceToken,
        });
      }
      expect(await env.stack.schedulerWorkItems.countActiveGlobal()).toBe(2);

      const denied = await env.stack.scheduler.selectAndClaimWork({
        workerCapabilities: ["ALL"],
        ownerId: `${env.stack.instanceId}-gdeny`,
      });
      expect(denied.claimed).toBeNull();

      for (const item of held) {
        const current = await env.stack.schedulerWorkItems.getById(
          item.workItemId,
        );
        if (current) {
          await env.stack.schedulerWorkItems.updateCas(
            {
              ...current,
              status: "SUCCEEDED",
              claimOwnerId: undefined,
              fenceToken: undefined,
              leaseExpiresAt: undefined,
            },
            current.recordRevision,
          );
        }
        try {
          await env.stack.leases.release({
            coordinationKey: `scheduler:work:${item.workItemId}`,
            ownerId: item.ownerId,
            fenceToken: item.fenceToken,
          });
        } catch {
          // best-effort
        }
      }
      expect(await env.stack.schedulerWorkItems.countActiveGlobal()).toBe(0);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("two schedulers materialize one work item identity", async () => {
    const shared = await createTestStack(uniquePostgresTestId("p13-share"));
    try {
      const dbB = await createIndependentDatabase(
        uniquePostgresTestId("p13-b-db"),
      );
      const stackB = await createPostgresOrchestratorStack({
        db: dbB,
        instanceId: uniquePostgresTestId("p13-b"),
        seedControlPlane: false,
      });
      const request = buildPostgresTestAdmissionRequest({
        testName: "p13-dup",
      });
      const admitted = await shared.stack.admission.admit(request);
      expect(admitted.outcome).toBe("ADMITTED");
      const runId = admitted.runId!;
      const first = await shared.stack.scheduler.discoverForRun(runId);
      const second = await stackB.scheduler.discoverForRun(runId);
      expect(first.created.length + first.reused.length).toBeGreaterThan(0);
      expect(second.created).toHaveLength(0);
      expect(second.reused.length).toBeGreaterThan(0);
      const all = await shared.stack.scheduler.listWorkForRun(runId);
      const keys = all.map((item) => item.logicalIdentityKey);
      expect(new Set(keys).size).toBe(keys.length);
      await stackB.close();
    } finally {
      await shared.close();
    }
  }, 60_000);

  it("durable fairness: B receives service before A drains 100 under two schedulers", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-fair"));
    try {
      const projectA = `p13_fa_${uniquePostgresTestId("a")}`;
      const projectB = `p13_fb_${uniquePostgresTestId("b")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectA,
        weight: 1,
        maxConcurrency: 64,
      });
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectB,
        weight: 1,
        maxConcurrency: 64,
      });
      await seedEligibleWork(env.stack, { projectId: projectA, count: 100 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 5 });

      const dbB = await createIndependentDatabase(uniquePostgresTestId("fair-b"));
      const stackB = await createPostgresOrchestratorStack({
        db: dbB,
        instanceId: uniquePostgresTestId("fair-sched-b"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 8,
      });
      // Rebuild A-side concurrency by using claim loops with global cap via
      // temporary service — claim via both stacks sharing DB.
      const stackA = await createPostgresOrchestratorStack({
        db: await createIndependentDatabase(uniquePostgresTestId("fair-a")),
        instanceId: uniquePostgresTestId("fair-sched-a"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 8,
      });

      const served = { A: 0, B: 0 };
      let aAtFirstB = 100;
      const focus = [projectA, projectB] as const;
      for (let i = 0; i < 60; i++) {
        await Promise.all([
          claimWithoutDispatch(stackA, { projectIds: focus }),
          claimWithoutDispatch(stackB, { projectIds: focus }),
        ]);
        const fairA = await env.stack.schedulerFairness.getByProjectId(projectA);
        const fairB = await env.stack.schedulerFairness.getByProjectId(projectB);
        served.A = fairA?.serviceSequence ?? 0;
        served.B = fairB?.serviceSequence ?? 0;
        if (served.B > 0 && aAtFirstB === 100) {
          aAtFirstB = served.A;
        }
        const active =
          (await env.stack.schedulerWorkItems.countActiveByProject(projectA)) +
          (await env.stack.schedulerWorkItems.countActiveByProject(projectB));
        expect(active).toBeLessThanOrEqual(4);
        if (served.B >= 1 && served.A < 100) {
          break;
        }
      }
      expect(served.B).toBeGreaterThan(0);
      expect(aAtFirstB).toBeLessThan(100);
      await stackA.close();
      await stackB.close();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("weighted fairness approximates 3:1 over a decision window", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-wfair"));
    try {
      const projectA = `p13_wa_${uniquePostgresTestId("a")}`;
      const projectB = `p13_wb_${uniquePostgresTestId("b")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectA,
        weight: 1,
        maxConcurrency: 64,
      });
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectB,
        weight: 3,
        maxConcurrency: 64,
      });
      await seedEligibleWork(env.stack, { projectId: projectA, count: 80 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 80 });

      const stack = await createPostgresOrchestratorStack({
        db: await createIndependentDatabase(uniquePostgresTestId("wfair")),
        instanceId: uniquePostgresTestId("wfair-s"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 1,
      });
      for (let i = 0; i < 40; i++) {
        await claimWithoutDispatch(stack, {
          projectIds: [projectA, projectB],
        });
      }
      const fairA = await env.stack.schedulerFairness.getByProjectId(projectA);
      const fairB = await env.stack.schedulerFairness.getByProjectId(projectB);
      const a = fairA?.serviceSequence ?? 0;
      const b = fairB?.serviceSequence ?? 0;
      expect(a + b).toBeGreaterThanOrEqual(20);
      // Documented DRR with weights 1 vs 3: B should receive more service.
      // Tolerance: B/A >= 1.5 over this window (ideal ~3).
      expect(b / Math.max(1, a)).toBeGreaterThanOrEqual(1.5);
      await stack.close();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("fairness survives scheduler restart from PostgreSQL", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-frestart"));
    try {
      const projectA = `p13_ra_${uniquePostgresTestId("a")}`;
      const projectB = `p13_rb_${uniquePostgresTestId("b")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectA,
        weight: 1,
        maxConcurrency: 64,
      });
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectB,
        weight: 1,
        maxConcurrency: 64,
      });
      await seedEligibleWork(env.stack, { projectId: projectA, count: 10 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 10 });

      const stack1 = await createPostgresOrchestratorStack({
        db: await createIndependentDatabase(uniquePostgresTestId("fr1")),
        instanceId: uniquePostgresTestId("fr-s1"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 1,
      });
      for (let i = 0; i < 6; i++) {
        await claimWithoutDispatch(stack1, {
          projectIds: [projectA, projectB],
        });
      }
      const before = await env.stack.schedulerFairness.listAll();
      expect(before.length).toBeGreaterThan(0);
      await stack1.close();

      const stack2 = await createPostgresOrchestratorStack({
        db: await createIndependentDatabase(uniquePostgresTestId("fr2")),
        instanceId: uniquePostgresTestId("fr-s2"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 1,
      });
      const afterReload = await stack2.scheduler.loadFairnessView();
      for (const row of before) {
        expect(afterReload.deficits.get(row.projectId)).toBe(row.deficit);
      }
      await stack2.close();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("aging lets old LOW outrank young BACKGROUND without mutating priorityClass", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-age"));
    try {
      const projectId = `p13_age_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        weight: 1,
        maxConcurrency: 64,
      });
      const old = "2020-01-01T00:00:00.000Z";
      const young = "2026-01-01T00:00:00.000Z";
      await seedEligibleWork(env.stack, {
        projectId,
        count: 1,
        priorityClass: "LOW",
        eligibleAt: old,
      });
      await seedEligibleWork(env.stack, {
        projectId,
        count: 1,
        priorityClass: "BACKGROUND",
        eligibleAt: young,
      });
      const { selected, decision } = await env.stack.scheduler.selectWork({
        workerCapabilities: ["ALL"],
        projectIds: [projectId],
      });
      expect(selected?.priorityClass).toBe("LOW");
      expect(selected?.priorityClass).not.toBe("BACKGROUND");
      const scores = decision.priorityInputs["scores"] as Array<{
        priorityClass: string;
        agingContribution: number;
      }>;
      const low = scores.find((s) => s.priorityClass === "LOW");
      expect(low?.agingContribution).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  }, 60_000);

  it("stale fence cannot settle claimed work", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-stale"));
    try {
      const projectId = `p13_st_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const [workItemId] = await seedEligibleWork(env.stack, {
        projectId,
        count: 1,
      });
      const work = await env.stack.schedulerWorkItems.getById(workItemId!);
      const leases = new PostgresLeaseStore(env.db, 1);
      const key = `scheduler:work:${workItemId}`;
      const lease = await leases.acquire({
        coordinationKey: key,
        phase: "SCHEDULER",
        ownerId: "owner_a",
      });
      await env.stack.scheduler.markClaimed(
        work!,
        "owner_a",
        lease.fenceToken,
        lease.leaseExpiresAt,
        "sd_test",
      );
      await waitUntilPostgresLeaseExpired(env.db, key);
      const leaseB = await leases.acquire({
        coordinationKey: key,
        phase: "SCHEDULER",
        ownerId: "owner_b",
      });
      expect(leaseB.fenceToken).toBeGreaterThan(lease.fenceToken);
      await expect(
        leases.assertWritable({
          coordinationKey: key,
          ownerId: "owner_a",
          fenceToken: lease.fenceToken,
        }),
      ).rejects.toMatchObject({ code: "STALE_FENCE_TOKEN" });
    } finally {
      await env.close();
    }
  }, 60_000);

  it("DB outage stops claiming with no memory queue fallback", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-dbdown"));
    try {
      const ports = {
        ...claimPorts(env.stack),
        databaseReachable: async () => false,
      };
      const claim = new SchedulerClaimLoop(ports);
      const result = await claim.tick();
      expect(result.claimed).toBe(0);
      expect(result.dispatched).toBe(0);
    } finally {
      await env.close();
    }
  }, 30_000);

  it("drain stops new claims", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-drain"));
    try {
      const ports = {
        ...claimPorts(env.stack),
        isAccepting: () => false,
      };
      const claim = new SchedulerClaimLoop(ports);
      const result = await claim.tick();
      expect(result.claimed).toBe(0);
    } finally {
      await env.close();
    }
  }, 30_000);

  it("project isolation: work list stays project-scoped", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-iso"));
    try {
      const projectA = `p13_ia_${uniquePostgresTestId("a")}`;
      const projectB = `p13_ib_${uniquePostgresTestId("b")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await seedEligibleWork(env.stack, { projectId: projectA, count: 3 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 2 });
      const aWork = await env.stack.scheduler.listWorkForProject(projectA);
      const bWork = await env.stack.scheduler.listWorkForProject(projectB);
      expect(aWork.every((w) => w.projectId === projectA)).toBe(true);
      expect(bWork.every((w) => w.projectId === projectB)).toBe(true);
      expect(aWork).toHaveLength(3);
      expect(bWork).toHaveLength(2);
      void EXAMPLE_ENVIRONMENT;
    } finally {
      await env.close();
    }
  }, 60_000);

  it("concurrent schedulers never advance from the same fairness revision", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-cas-race"));
    try {
      const projectA = `p13_cr_a_${uniquePostgresTestId("a")}`;
      const projectB = `p13_cr_b_${uniquePostgresTestId("b")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectA,
        weight: 1,
        maxConcurrency: 64,
      });
      await env.stack.scheduler.upsertProjectConfig({
        projectId: projectB,
        weight: 1,
        maxConcurrency: 64,
      });
      await seedEligibleWork(env.stack, { projectId: projectA, count: 30 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 30 });

      const stackA = await createPostgresOrchestratorStack({
        db: await createIndependentDatabase(uniquePostgresTestId("cr-a")),
        instanceId: uniquePostgresTestId("cr-sched-a"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 8,
      });
      const stackB = await createPostgresOrchestratorStack({
        db: await createIndependentDatabase(uniquePostgresTestId("cr-b")),
        instanceId: uniquePostgresTestId("cr-sched-b"),
        seedControlPlane: false,
        schedulerGlobalMaxConcurrency: 8,
      });

      const revisionSignatures: string[] = [];
      let successClaims = 0;
      for (let i = 0; i < 20; i++) {
        const [r1, r2] = await Promise.all([
          claimWithoutDispatch(stackA, { projectIds: [projectA, projectB] }),
          claimWithoutDispatch(stackB, { projectIds: [projectA, projectB] }),
        ]);
        for (const result of [r1, r2]) {
          if (!result.claimed) {
            continue;
          }
          successClaims += 1;
          revisionSignatures.push(
            JSON.stringify(result.fairnessRevisionBefore ?? {}),
          );
        }
      }
      expect(successClaims).toBeGreaterThan(10);
      expect(new Set(revisionSignatures).size).toBe(revisionSignatures.length);

      const fairA = await env.stack.schedulerFairness.getByProjectId(projectA);
      const fairB = await env.stack.schedulerFairness.getByProjectId(projectB);
      const serviceTotal =
        (fairA?.serviceSequence ?? 0) + (fairB?.serviceSequence ?? 0);
      expect(serviceTotal).toBe(successClaims);

      await stackA.close();
      await stackB.close();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("noisy project cannot monopolize bounded work pages vs peer projects", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-noisy"));
    try {
      const projectA = `p13_n_a_${uniquePostgresTestId("a")}`;
      const projectB = `p13_n_b_${uniquePostgresTestId("b")}`;
      const projectC = `p13_n_c_${uniquePostgresTestId("c")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectA);
      await seedDedicatedPostgresTestProject(env.stack.db, projectB);
      await seedDedicatedPostgresTestProject(env.stack.db, projectC);
      for (const projectId of [projectA, projectB, projectC]) {
        await env.stack.scheduler.upsertProjectConfig({
          projectId,
          weight: 1,
          maxConcurrency: 64,
        });
      }
      await seedEligibleWork(env.stack, { projectId: projectA, count: 1000 });
      await seedEligibleWork(env.stack, { projectId: projectB, count: 1 });
      await seedEligibleWork(env.stack, { projectId: projectC, count: 3 });

      const { selected, decision } = await env.stack.scheduler.selectWork({
        workerCapabilities: ["ALL"],
        perProjectLimit: 8,
      });
      expect(selected).toBeTruthy();
      const projects = decision.fairnessInputs["candidateProjects"] as string[];
      expect(projects).toEqual(
        expect.arrayContaining([projectA, projectB, projectC]),
      );

      const served = { A: 0, B: 0, C: 0 };
      for (let i = 0; i < 30; i++) {
        const result = await claimWithoutDispatch(env.stack, {
          projectIds: [projectA, projectB, projectC],
        });
        if (result.projectId === projectA) {
          served.A += 1;
        }
        if (result.projectId === projectB) {
          served.B += 1;
        }
        if (result.projectId === projectC) {
          served.C += 1;
        }
      }
      expect(served.B + served.C).toBeGreaterThan(0);
    } finally {
      await env.close();
    }
  }, 180_000);

  it("fairness CAS rejects stale revision writers", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-fcas"));
    try {
      const projectId = `p13_fcas_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        weight: 1,
        maxConcurrency: 64,
      });
      await seedEligibleWork(env.stack, { projectId, count: 2 });
      const first = await claimWithoutDispatch(env.stack, {
        projectIds: [projectId],
      });
      expect(first.claimed).toBe(true);
      const row = await env.stack.schedulerFairness.getByProjectId(projectId);
      expect(row).toBeTruthy();
      const staleExpected = row!.recordRevision;
      await claimWithoutDispatch(env.stack, { projectIds: [projectId] });
      const advanced = await env.stack.schedulerFairness.getByProjectId(
        projectId,
      );
      expect(advanced!.recordRevision).toBeGreaterThan(staleExpected);
      await expect(
        env.stack.schedulerFairness.writeRowsCas({
          rows: [
            {
              ...advanced!,
              deficit: 42,
              recordRevision: advanced!.recordRevision + 1,
            },
          ],
          expectedRevisions: new Map([[projectId, staleExpected]]),
          decisionId: "stale_cas_writer",
        }),
      ).rejects.toMatchObject({ code: "SCHEDULER_CAS_CONFLICT" });
    } finally {
      await env.close();
    }
  }, 60_000);

  it("continuous admission cannot starve an older actionable ADMITTED run", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-starve"));
    try {
      const projectId = `p13_starve_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const oldReq = buildPostgresTestAdmissionRequest({
        testName: "p13-starve-old",
        projectId,
      });
      const oldAdmitted = await env.stack.admission.admit(oldReq);
      expect(oldAdmitted.outcome).toBe("ADMITTED");
      const oldRunId = oldAdmitted.runId!;
      // Deterministic: pin older than any continuous arrivals (and typical fixture times).
      const oldRun = await env.stack.runs.getById(oldRunId);
      expect(oldRun).toBeTruthy();
      await env.stack.runs.save({
        ...oldRun!,
        updatedAt: "1970-01-01T00:00:00.000Z",
      });

      const discoveryBatchSize = 3;
      const ports = {
        ...claimPorts(env.stack),
        discoveryBatchSize,
        listDiscoverableRunIds: (limit: number) =>
          env.stack.listDiscoverableRunIds(limit, [projectId]),
      };
      const discovery = new SchedulerDiscoveryLoop(ports);

      let found = false;
      for (let tick = 0; tick < 40; tick++) {
        for (let n = 0; n < discoveryBatchSize * 2; n++) {
          const newer = await env.stack.admission.admit(
            buildPostgresTestAdmissionRequest({
              testName: `p13-starve-new-${tick}-${n}`,
              projectId,
            }),
          );
          expect(newer.outcome).toBe("ADMITTED");
        }
        await discovery.tick();
        const work = await env.stack.scheduler.listWorkForRun(oldRunId);
        if (work.some((item) => item.workKind === "INGEST_REPOSITORY")) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("already-materialized work does not permanently occupy discovery batches", async () => {
    const env = await createTestStack(uniquePostgresTestId("p13-stuckdisc"));
    try {
      const projectId = `p13_stuckd_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.stack.db, projectId);
      const stuckCount = 40;
      const stuckRunIds: string[] = [];
      for (let i = 0; i < stuckCount; i++) {
        const admitted = await env.stack.admission.admit(
          buildPostgresTestAdmissionRequest({
            testName: `p13-stuckdisc-old-${i}`,
            projectId,
          }),
        );
        expect(admitted.outcome).toBe("ADMITTED");
        const runId = admitted.runId!;
        stuckRunIds.push(runId);
        const bindingHash = `ingest:${runId}`;
        const logicalIdentityKey = workLogicalIdentityKey({
          runId,
          workKind: "INGEST_REPOSITORY",
          bindingHash,
        });
        await env.stack.schedulerWorkItems.save(
          parseSchedulerWorkItem({
            workItemId: workItemIdFromIdentity(logicalIdentityKey),
            projectId,
            runId,
            workKind: "INGEST_REPOSITORY",
            status: "ELIGIBLE",
            priorityClass: "NORMAL",
            logicalIdentityKey,
            bindingHash,
            createdAt: "1980-01-01T00:00:00.000Z",
            eligibleAt: "1980-01-01T00:00:00.000Z",
            attemptCount: 0,
            maxAttempts: 5,
            recordRevision: 1,
            dependencySetHash: "empty",
            schedulingMetadataHash: "meta",
          }),
        );
        const stuckRun = await env.stack.runs.getById(runId);
        expect(stuckRun).toBeTruthy();
        await env.stack.runs.save({
          ...stuckRun!,
          updatedAt: "1980-01-01T00:00:00.000Z",
        });
      }

      const fresh = await env.stack.admission.admit(
        buildPostgresTestAdmissionRequest({
          testName: "p13-stuckdisc-fresh",
          projectId,
        }),
      );
      expect(fresh.outcome).toBe("ADMITTED");
      const freshRunId = fresh.runId!;
      const freshRun = await env.stack.runs.getById(freshRunId);
      expect(freshRun).toBeTruthy();
      await env.stack.runs.save({
        ...freshRun!,
        updatedAt: "1970-06-01T00:00:00.000Z",
      });

      const discoveryBatchSize = 5;
      const listDiscoverableRunIds = (limit: number) =>
        env.stack.listDiscoverableRunIds(limit, [projectId]);
      const discovery = new SchedulerDiscoveryLoop({
        ...claimPorts(env.stack),
        discoveryBatchSize,
        listDiscoverableRunIds,
      });

      let found = false;
      for (let tick = 0; tick < 20; tick++) {
        const before = await listDiscoverableRunIds(discoveryBatchSize);
        expect(
          before.some((id) => stuckRunIds.includes(id)),
          "already-materialized stuck runs must not fill actionable discovery",
        ).toBe(false);
        await discovery.tick();
        const work = await env.stack.scheduler.listWorkForRun(freshRunId);
        if (work.some((item) => item.workKind === "INGEST_REPOSITORY")) {
          found = true;
          break;
        }
      }
      expect(found).toBe(true);
    } finally {
      await env.close();
    }
  }, 120_000);
});
