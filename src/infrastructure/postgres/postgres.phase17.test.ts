import { describe, expect, it } from "vitest";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import {
  EXAMPLE_ENVIRONMENT,
  EXAMPLE_PROJECT,
} from "../../control-plane/fixtures.js";
import { EXAMPLE_REQUESTER_ID } from "../../admission/fixtures.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import { deliveredNonce } from "./postgres-lifecycle-helpers.js";
import {
  assumptionSetHash,
  withAssumptionSetHash,
  type ScenarioAssumption,
} from "../../scenarios/assumptions.js";

type Stack = Awaited<ReturnType<typeof createTestStack>>["stack"];

const SPONSOR_ONLY = "sponsor_only_p17";
const OPERATIONAL_APPROVER = "approver_bootstrap";

const DEFAULT_BUDGET = {
  maximumActions: 10,
  maximumDurationHours: 24,
  maximumModelCalls: 5,
  maximumTotalTokens: 10_000,
  maximumSampleSize: 100,
  maximumEstimatedCost: 50,
  maximumExternalSideEffects: 0,
} as const;

const SAMPLE_ASSUMPTIONS: ScenarioAssumption[] = [
  {
    assumptionId: "asm_p17_latency",
    name: "Latency bound",
    description: "p95 latency stays under 200ms",
    value: 1,
    unit: "RATIO",
    sourceClass: "ASSUMPTION",
    confidenceClassification: "MEDIUM",
    sensitivityEligible: true,
    materiality: "HIGH",
  },
];

async function seedTwoPrincipalAuthority(
  db: Parameters<typeof seedDedicatedPostgresTestProject>[0],
  projectId: string,
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  // Principal S: EXPERIMENT_SPONSOR only — never APPROVER.
  await authority.seed([
    {
      principalId: SPONSOR_ONLY,
      principalType: "EXPERIMENT_SPONSOR",
      projectId,
      environments: EXAMPLE_PROJECT.allowedEnvironments,
    },
  ]);
}

async function admitExperiment(
  stack: Stack,
  projectId: string,
  opts?: {
    sourceAssumptionIds?: string[];
    sourceAssumptionSetHash?: string;
    objective?: string;
  },
) {
  return stack.experimentService.admit({
    projectId,
    requestedEnvironment: EXAMPLE_ENVIRONMENT,
    objective: opts?.objective ?? "Measure assumption latency under load",
    sourceAssumptionIds: opts?.sourceAssumptionIds ?? ["asm_latency"],
    ...(opts?.sourceAssumptionSetHash
      ? { sourceAssumptionSetHash: opts.sourceAssumptionSetHash }
      : {}),
    riskClass: "LOW",
    budgetEnvelope: { ...DEFAULT_BUDGET },
    createdBy: EXAMPLE_REQUESTER_ID,
    submittedAt: stack.clock.nowIso(),
  });
}

async function ladderToAuthorized(
  stack: Stack,
  projectId: string,
  opts?: {
    sourceAssumptionIds?: string[];
    sourceAssumptionSetHash?: string;
    sponsorId?: string;
  },
) {
  const admitted = await admitExperiment(stack, projectId, {
    sourceAssumptionIds: opts?.sourceAssumptionIds,
    sourceAssumptionSetHash: opts?.sourceAssumptionSetHash,
  });
  expect(admitted.outcome).toBe("ADMITTED");
  if (admitted.outcome !== "ADMITTED") {
    throw new Error("admit failed");
  }
  const id = admitted.experiment.experimentId;
  await stack.experimentService.design(id);
  await stack.experimentService.validate(id);
  const routed = await stack.experimentService.routeAuthorization(id);
  const decided = await stack.experimentService.decideAuthorization({
    authorizationId: routed.request.authorizationId,
    sponsorId: opts?.sponsorId ?? SPONSOR_ONLY,
    decision: "APPROVE_EXPERIMENT",
    decisionNonce: routed.decisionNonce,
    submittedAt: stack.clock.nowIso(),
  });
  return { id, decided, routed };
}

async function countExecutionAttempts(
  db: Stack["db"],
  runId: string,
): Promise<number> {
  const attempts = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM json_documents
     WHERE collection = 'execution_attempts' AND run_id = $1`,
    [runId],
  );
  return Number(attempts.rows[0]?.c ?? 0);
}

async function countPhase6AuthRecords(
  db: Stack["db"],
  runId: string,
): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM json_documents
     WHERE collection = 'authorization_records' AND run_id = $1`,
    [runId],
  );
  return Number(rows.rows[0]?.c ?? 0);
}

describe("postgres phase17 governed experiments", () => {
  it("admits an experiment and grants EXPERIMENT_SPONSOR via seed defaults", async () => {
    const env = await createTestStack(uniquePostgresTestId("p17"));
    try {
      const projectId = `proj_p17_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isExperimentSponsorEnabled(
          "approver_bootstrap",
          projectId,
        ),
      ).toBe(true);

      const admitted = await env.stack.experimentService.admit({
        projectId,
        requestedEnvironment: EXAMPLE_ENVIRONMENT,
        objective: "Measure assumption latency under load",
        riskClass: "LOW",
        budgetEnvelope: { ...DEFAULT_BUDGET },
        createdBy: EXAMPLE_REQUESTER_ID,
        submittedAt: env.stack.clock.nowIso(),
      });
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") {
        return;
      }
      const loaded = await env.stack.experiments.getById(
        admitted.experiment.experimentId,
      );
      expect(loaded?.status).toBe("ADMITTED");
      expect(loaded?.projectId).toBe(projectId);
    } finally {
      await env.close();
    }
  });

  it("primary ladder: sponsor authorization remains separate from operational approval and verified evidence", async () => {
    const env = await createTestStack(uniquePostgresTestId("p17-ladder"));
    try {
      const projectId = `p17_ladder_${uniquePostgresTestId("p")}`;
      await seedTwoPrincipalAuthority(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      expect(
        await authority.isExperimentSponsorEnabled(SPONSOR_ONLY, projectId),
      ).toBe(true);
      expect(await authority.isApproverEnabled(SPONSOR_ONLY, projectId)).toBe(
        false,
      );
      expect(
        await authority.isApproverEnabled(OPERATIONAL_APPROVER, projectId),
      ).toBe(true);

      const asmSet = withAssumptionSetHash(SAMPLE_ASSUMPTIONS);
      const assumptionHashBefore = assumptionSetHash(SAMPLE_ASSUMPTIONS);

      const { id, decided } = await ladderToAuthorized(env.stack, projectId, {
        sourceAssumptionIds: ["asm_p17_latency"],
        sourceAssumptionSetHash: asmSet.assumptionSetHash,
        sponsorId: SPONSOR_ONLY,
      });
      expect(decided.experiment.status).toBe("AUTHORIZED");
      expect(decided.record?.decision).toBe("APPROVE_EXPERIMENT");
      expect(decided.record?.sponsorId).toBe(SPONSOR_ONLY);

      const compiled = await env.stack.experimentService.compileExecution(id);
      expect(compiled.experiment.status).toBe(
        "AWAITING_EXECUTION_AUTHORIZATION",
      );
      expect(compiled.compiled.requiresPhase6Authorization).toBe(true);
      const runId = compiled.lineage.compiledRunId!;
      expect(runId).toBeTruthy();
      expect(compiled.lineage.phase2AdmissionOutcome).toMatch(
        /ADMITTED|DUPLICATE_REUSED/,
      );
      expect(compiled.lineage.phase6AuthorizationRecordId).toBeUndefined();
      expect(compiled.lineage.executionAttemptId).toBeUndefined();
      expect(await countExecutionAttempts(env.db, runId)).toBe(0);
      expect(await countPhase6AuthRecords(env.db, runId)).toBe(0);

      // Advance admitted experiment Objective through the real operational path.
      // First (and only) AuthorizationRoutingService.route() while VALIDATING.
      await env.stack.ingestion.ingest(runId, projectId, EXAMPLE_ENVIRONMENT);
      await env.stack.planning.plan(runId);
      await env.stack.validation.validate(runId);
      expect((await env.stack.runs.getById(runId))?.state).toBe("VALIDATING");
      const routed = await env.stack.authorizationRouting.route(runId);
      expect(routed.outcome).toBe("PENDING_APPROVAL");
      if (routed.outcome !== "PENDING_APPROVAL") {
        throw new Error("expected PENDING_APPROVAL");
      }
      expect((await env.stack.runs.getById(runId))?.state).toBe(
        "AWAITING_APPROVAL",
      );
      const approvalRequestA = routed.approvalRequestId;
      const pendingBeforeSponsor =
        await env.stack.humanAuthorization.getPendingRequest(runId);
      expect(pendingBeforeSponsor?.approvalRequestId).toBe(approvalRequestA);
      expect(
        (await env.stack.approvalRequests.listByRun(runId)).filter(
          (r) => r.status === "PENDING",
        ),
      ).toHaveLength(1);
      const nonceA = deliveredNonce(
        env.stack.approvalDelivery,
        approvalRequestA,
      );

      // Principal S attempts Phase 6 approval via the real decide path.
      // beginDecision consumes the nonce before UNKNOWN_APPROVER fails closed.
      await expect(
        env.stack.humanAuthorization.decide({
          approvalRequestId: approvalRequestA,
          approverId: SPONSOR_ONLY,
          decision: "APPROVE",
          decisionNonce: nonceA,
          submittedAt: env.stack.clock.nowIso(),
        }),
      ).rejects.toMatchObject({ code: "UNKNOWN_APPROVER" });
      expect(await countExecutionAttempts(env.db, runId)).toBe(0);
      expect(await countPhase6AuthRecords(env.db, runId)).toBe(0);
      expect(
        (await env.stack.approvalRequests.getById(approvalRequestA))?.status,
      ).toBe("PENDING");
      expect((await env.stack.runs.getById(runId))?.state).toBe(
        "AWAITING_APPROVAL",
      );

      // A is unusable (nonce burned). Canonical Phase 6 reissue keeps the run
      // in AWAITING_APPROVAL — no REVISING/VALIDATING regression.
      await expect(
        env.stack.humanAuthorization.decide({
          approvalRequestId: approvalRequestA,
          approverId: OPERATIONAL_APPROVER,
          decision: "APPROVE",
          decisionNonce: nonceA,
          submittedAt: env.stack.clock.nowIso(),
        }),
      ).rejects.toMatchObject({ code: "AUTHORIZATION_DECISION_REPLAYED" });

      const reissued = await env.stack.humanAuthorization.reissueApprovalRequest({
        runId,
        replacedApprovalRequestId: approvalRequestA,
      });
      expect(reissued.runState).toBe("AWAITING_APPROVAL");
      expect((await env.stack.runs.getById(runId))?.state).toBe(
        "AWAITING_APPROVAL",
      );
      expect(reissued.approvalRequestId).not.toBe(approvalRequestA);
      expect(reissued.replacesApprovalRequestId).toBe(approvalRequestA);
      expect(
        (await env.stack.approvalRequests.getById(approvalRequestA))?.status,
      ).toBe("CANCELLED");
      const pendingB = await env.stack.humanAuthorization.getPendingRequest(
        runId,
      );
      expect(pendingB?.approvalRequestId).toBe(reissued.approvalRequestId);
      expect(pendingB?.replacesApprovalRequestId).toBe(approvalRequestA);
      expect(
        (await env.stack.approvalRequests.listByRun(runId)).filter(
          (r) => r.status === "PENDING",
        ),
      ).toHaveLength(1);
      const nonceB = deliveredNonce(
        env.stack.approvalDelivery,
        reissued.approvalRequestId,
      );
      expect(nonceB).not.toBe(nonceA);

      // Principal A (operational APPROVER) authorizes execution on B.
      const approved = await env.stack.humanAuthorization.decide({
        approvalRequestId: reissued.approvalRequestId,
        approverId: OPERATIONAL_APPROVER,
        decision: "APPROVE",
        decisionNonce: nonceB,
        submittedAt: env.stack.clock.nowIso(),
      });
      expect(approved.result).toBe("APPROVED");
      expect(await countPhase6AuthRecords(env.db, runId)).toBe(1);

      await env.stack.execution.execute(runId);
      expect(await countExecutionAttempts(env.db, runId)).toBeGreaterThan(0);

      await env.stack.verification.verify(runId);
      const phase8 = await env.stack.outcomeVerifications.getLatestByRun(runId);
      expect(phase8).toBeTruthy();
      expect(phase8!.outcome).toBe("VERIFIED_SUCCESS");
      expect(phase8!.runId).toBe(runId);

      let experiment = (await env.stack.experiments.getById(id))!;
      experiment = await env.stack.experiments.transition(
        id,
        experiment.status,
        experiment.recordRevision,
        "EXECUTING",
        env.stack.clock.nowIso(),
      );
      expect(experiment.status).toBe("EXECUTING");

      const completed = await env.stack.experimentService.verifyAndComplete(id, {
        measurementResults: [
          {
            measurementId: `meas_${id}_primary`,
            observedValue: 1.12,
            unit: "RATIO",
            sampleCount: 12,
            quality: "UNKNOWN",
            evidenceRefs: [],
            limitations: [],
          },
        ],
        outcomeVerificationIds: [phase8!.outcomeVerificationId],
      });

      expect(completed.experiment.status).toBe("COMPLETED");
      expect(completed.evidenceBundle.qualityClassification).toBe("VALIDATED");
      expect(completed.updateCandidates.length).toBeGreaterThan(0);
      expect(
        completed.updateCandidates.every((c) => c.requiresPhase16Reanalysis),
      ).toBe(true);
      expect(completed.updateCandidates[0]?.assumptionId).toBe("asm_p17_latency");
      expect(completed.updateCandidates[0]?.outcomeVerificationIds).toEqual([
        phase8!.outcomeVerificationId,
      ]);
      expect(completed.completion.terminalStatus).toBe("COMPLETED");
      expect(assumptionSetHash(SAMPLE_ASSUMPTIONS)).toBe(assumptionHashBefore);
      expect(asmSet.assumptionSetHash).toBe(assumptionHashBefore);

      const evidenceRows = await env.db.query(
        `SELECT 1 FROM experiment_evidence_bundles WHERE experiment_id = $1`,
        [id],
      );
      expect(evidenceRows.rows.length).toBe(1);
      const completionRows = await env.db.query(
        `SELECT 1 FROM experiment_completion_records WHERE experiment_id = $1`,
        [id],
      );
      expect(completionRows.rows.length).toBe(1);
    } finally {
      await env.close();
    }
  }, 240_000);

  it("authority separation: sponsor approve creates zero execution attempts", async () => {
    const env = await createTestStack(uniquePostgresTestId("p17-authsep"));
    try {
      const projectId = `p17_authsep_${uniquePostgresTestId("p")}`;
      await seedTwoPrincipalAuthority(env.db, projectId);
      const { id } = await ladderToAuthorized(env.stack, projectId);
      await env.stack.experimentService.compileExecution(id);

      const attempts = await env.db.query<{ c: number }>(
        `SELECT COUNT(*)::int AS c FROM json_documents
         WHERE collection = 'execution_attempts'
           AND (run_id = $1 OR payload::text LIKE '%' || $1 || '%')`,
        [id],
      );
      expect(attempts.rows[0]!.c).toBe(0);

      const lineage = await env.db.query<{
        phase6: string | null;
        attempt: string | null;
      }>(
        `SELECT payload->>'phase6AuthorizationRecordId' AS phase6,
                payload->>'executionAttemptId' AS attempt
         FROM experiment_execution_lineage
         WHERE experiment_id = $1`,
        [id],
      );
      expect(lineage.rows.length).toBe(1);
      expect(lineage.rows[0]!.phase6).toBeNull();
      expect(lineage.rows[0]!.attempt).toBeNull();
    } finally {
      await env.close();
    }
  }, 120_000);

  it("rejects non-sponsor principals with EXPERIMENT_SPONSOR_SCOPE_INSUFFICIENT", async () => {
    const env = await createTestStack(uniquePostgresTestId("p17-role"));
    try {
      const projectId = `p17_role_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);
      const authority = new PostgresAuthorityDirectory(env.db);
      await authority.seed([
        {
          principalId: "approver_only",
          principalType: "APPROVER",
          projectId,
          environments: [EXAMPLE_ENVIRONMENT],
        },
        {
          principalId: "selector_only",
          principalType: "STRATEGY_SELECTOR",
          projectId,
          environments: [EXAMPLE_ENVIRONMENT],
        },
      ]);

      const admitted = await admitExperiment(env.stack, projectId);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const id = admitted.experiment.experimentId;
      await env.stack.experimentService.design(id);
      await env.stack.experimentService.validate(id);
      const routed = await env.stack.experimentService.routeAuthorization(id);

      for (const sponsorId of ["approver_only", "selector_only"]) {
        await expect(
          env.stack.experimentService.decideAuthorization({
            authorizationId: routed.request.authorizationId,
            sponsorId,
            decision: "APPROVE_EXPERIMENT",
            decisionNonce: routed.decisionNonce,
            submittedAt: env.stack.clock.nowIso(),
          }),
        ).rejects.toMatchObject({
          code: "EXPERIMENT_SPONSOR_SCOPE_INSUFFICIENT",
        });
      }

      const records = await env.db.query(
        `SELECT 1 FROM experiment_authorization_records WHERE experiment_id = $1`,
        [id],
      );
      expect(records.rows.length).toBe(0);

      const still = await env.stack.experiments.getById(id);
      expect(still?.status).toBe("AWAITING_AUTHORIZATION");
    } finally {
      await env.close();
    }
  }, 120_000);

  it("claim lifecycle: DESIGN_EXPERIMENT claim succeeds and releases lease", async () => {
    const env = await createTestStack(uniquePostgresTestId("p17-claim"));
    try {
      const projectId = `p17_claim_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(env.db, projectId);

      const admitted = await admitExperiment(env.stack, projectId);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const id = admitted.experiment.experimentId;

      await env.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 2,
        weight: 1,
      });

      const discovered =
        await env.stack.experimentWorkMaterializer.discoverForExperiment(id);
      expect(discovered.created.length + discovered.reused.length).toBeGreaterThan(
        0,
      );

      const items = await env.stack.schedulerWorkItems.listByRun(id);
      const designItems = items.filter((i) => i.workKind === "DESIGN_EXPERIMENT");
      expect(designItems.length).toBe(1);

      const ownerId = `${env.stack.instanceId}-sched`;
      const claim = await env.stack.scheduler.selectAndClaimWork({
        ownerId,
        workerCapabilities: ["EXPERIMENT_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      expect(claim.claimed).not.toBeNull();
      expect(claim.claimed?.workKind).toBe("DESIGN_EXPERIMENT");

      const claimed = claim.claimed!;
      const lease = claim.lease!;
      await env.stack.scheduler.markSucceeded(claimed, "p17-claim-owner");
      await env.stack.leases.release({
        coordinationKey: `scheduler:work:${claimed.workItemId}`,
        ownerId,
        fenceToken: lease.fenceToken,
      });
      expect(
        await env.stack.schedulerWorkItems.countActiveByProject(projectId),
      ).toBe(0);
    } finally {
      await env.close();
    }
  }, 120_000);

  it("distributed: two stacks reuse one DESIGN_EXPERIMENT work identity", async () => {
    const envA = await createTestStack(uniquePostgresTestId("p17-dist-a"));
    const envB = await createTestStack(uniquePostgresTestId("p17-dist-b"));
    try {
      const projectId = `p17_dist_${uniquePostgresTestId("p")}`;
      await seedDedicatedPostgresTestProject(envA.stack.db, projectId);

      const admitted = await admitExperiment(envA.stack, projectId);
      expect(admitted.outcome).toBe("ADMITTED");
      if (admitted.outcome !== "ADMITTED") return;
      const id = admitted.experiment.experimentId;

      await envA.stack.scheduler.upsertProjectConfig({
        projectId,
        maxConcurrency: 2,
        weight: 1,
      });

      const d1 =
        await envA.stack.experimentWorkMaterializer.discoverForExperiment(id);
      const d2 =
        await envB.stack.experimentWorkMaterializer.discoverForExperiment(id);
      expect(d1.created.length + d1.reused.length).toBeGreaterThan(0);
      expect(d2.reused.length + d2.created.length).toBeGreaterThan(0);

      const items = await envA.stack.schedulerWorkItems.listByRun(id);
      const designItems = items.filter((i) => i.workKind === "DESIGN_EXPERIMENT");
      expect(designItems.length).toBe(1);

      const ownerA = `${envA.stack.instanceId}-sched_a`;
      const ownerB = `${envB.stack.instanceId}-sched_b`;
      const claimA = await envA.stack.scheduler.selectAndClaimWork({
        ownerId: ownerA,
        workerCapabilities: ["EXPERIMENT_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      const claimB = await envB.stack.scheduler.selectAndClaimWork({
        ownerId: ownerB,
        workerCapabilities: ["EXPERIMENT_ORCHESTRATION", "ALL"],
        projectIds: [projectId],
      });
      expect(claimA.claimed).not.toBeNull();
      expect(claimB.claimed).toBeNull();

      const claimed = claimA.claimed!;
      const lease = claimA.lease!;
      await envA.stack.scheduler.markSucceeded(claimed, "distributed-owner");
      await envA.stack.leases.release({
        coordinationKey: `scheduler:work:${claimed.workItemId}`,
        ownerId: ownerA,
        fenceToken: lease.fenceToken,
      });
      expect(
        await envA.stack.schedulerWorkItems.countActiveByProject(projectId),
      ).toBe(0);
    } finally {
      await envA.close();
      await envB.close();
    }
  }, 120_000);
});
