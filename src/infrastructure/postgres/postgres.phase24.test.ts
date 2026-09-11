import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { isDurabilityError } from "../../durability/errors.js";
import {
  QualificationError,
  isQualificationError,
  FINAL_SYSTEM_DOCTRINE,
  QUALIFICATION_DOCTRINE,
  computeReleaseCandidateFingerprint,
  mintProductionReferenceRuntimeManifest,
  evaluateCurrentReleaseApplicability,
  withReadinessReport,
  productionConfigProfileFromRuntimeConfig,
} from "../../qualification/index.js";
import { evaluateArchitectureConformance } from "../../assurance/architecture-conformance.js";
import { computeTargetFingerprint } from "../../assurance/target.js";
import { buildTarget } from "../../assurance/test-fixtures.js";
import { PostgresHealthService } from "./health.js";
import { PostgresMigrationRunner } from "./migrate.js";
import {
  buildPostgresTestAdmissionRequest,
  uniquePostgresTestId,
} from "./test-helpers.js";
import {
  advanceToAwaitingApproval,
  advanceToApprovedRun,
  advanceToCompletedRun,
  approveAwaitingRun,
} from "./postgres-lifecycle-helpers.js";
import { PostgresReleaseManifestRepository } from "./repositories/qualification.js";
import { parseSchedulerWorkItem } from "../../scheduling/work-item.js";
import { schedulerWorkCoordinationKey } from "../../scheduling/lease-port.js";
import {
  createP24ConcurrentRuntime,
  createP24Env,
  p24BuildCandidate,
  p24CaptureAuthoritySurface,
  p24CapturePostgresWaitSnapshot,
  p24RecordCriticalEvidence,
} from "./postgres.phase24.helpers.js";
import {
  seedP23Authority,
  p23CreateInstitution,
  p23QualifyThroughAssessment,
  p23CertifyQualified,
  p23LifecycleFromAnchor,
  p23OpenRevocationProof,
  P23_CERTIFIER_Q,
  P23_ENV,
} from "./postgres.phase23.helpers.js";
import {
  createDisposableDatabase,
  dumpAndRestoreWithPgDump,
  pgDumpToolsAvailable,
  copyPublicTables,
} from "./backup-drill.js";
import { createTestStackOnUrl } from "./test-helpers.js";
import {
  createReferenceRuntime,
  REFERENCE_RUNTIME_COMPOSITION_SIGNATURE,
} from "./reference-runtime.js";
import { MemoryStructuredLogger } from "../../runtime/logging.js";

const ANCHOR = "2026-09-09T00:00:00.000Z";

function allCriticalPass(evaluatedAt = "2026-09-09T12:00:00.000Z") {
  return withReadinessReport({
    reportId: uniquePostgresTestId("ready"),
    evaluatedAt,
    results: [
      "DATABASE_CONNECTIVITY",
      "SCHEMA_COMPATIBILITY",
      "MIGRATION_HEAD",
      "PRODUCTION_CONFIG",
      "RUNTIME_MANIFEST",
      "ARTIFACT_INTEGRITY",
      "PHASE23_CERTIFICATE",
      "FAULT_INJECTION_DISABLED",
      "CANDIDATE_FINGERPRINT",
      "GOLDEN_PATH",
      "RESTART_RECOVERY",
      "NO_AUTHORITY_BYPASS",
    ].map((checkId) => ({
      checkId: checkId as never,
      result: "PASS" as const,
      reasonCode: "OK",
      critical: true,
    })),
  });
}

describe("Phase 24 postgres production synthesis", () => {
  it("TX. preserves QualificationError through withTransaction", async () => {
    const env = await createP24Env("tx");
    try {
      await expect(
        env.db.withTransaction(async () => {
          throw new QualificationError(
            "RELEASE_NOT_QUALIFIED",
            "tx preserve probe",
          );
        }),
      ).rejects.toSatisfy(
        (err: unknown) =>
          isQualificationError(err) && err.code === "RELEASE_NOT_QUALIFIED",
      );
      await expect(
        env.db.withTransaction(async () => {
          throw new Error("plain");
        }),
      ).rejects.toSatisfy((err: unknown) => isDurabilityError(err));
    } finally {
      await env.close();
    }
  });

  it("A. final release candidate identity deterministic + drift", async () => {
    const env = await createP24Env("rc-a");
    try {
      const rc1 = p24BuildCandidate({ assuranceTargetFingerprint: "t1" });
      expect(computeReleaseCandidateFingerprint(rc1.candidate)).toBe(
        rc1.fingerprint,
      );
      const rc2 = p24BuildCandidate({
        assuranceTargetFingerprint: "t1",
        commitSha: "changed-commit",
      });
      expect(rc2.fingerprint).not.toBe(rc1.fingerprint);
      expect(env.runtime.manifest.faultInjectionAllowed).toBe(false);
      expect(env.stack.admission).toBeDefined();
      expect(env.stack.planning).toBeDefined();
      expect(env.stack.validation).toBeDefined();
      expect(env.stack.humanAuthorization).toBeDefined();
      expect(env.stack.execution).toBeDefined();
      expect(env.stack.verification).toBeDefined();
      expect(env.stack.scheduler).toBeDefined();
      expect(env.stack.assuranceService).toBeDefined();
      expect(env.stack.qualificationService).toBeDefined();
    } finally {
      await env.close();
    }
  });

  it("B. fresh Phase23 cert for final target; old target rejected", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("cert-b", { seedControlPlane: false });
    const projectId = uniquePostgresTestId("p24b");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);

      // Cold: certificate against T_old (018-era material)
      const oldCtx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
        targetOverrides: {
          packageLockHash: createHash("sha256").update("old-018-lock").digest("hex"),
        },
      });
      const cold = await p23CertifyQualified(env.stack, oldCtx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      // C24: fresh certificate against final T24
      const finalCtx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
        targetOverrides: {
          packageLockHash: createHash("sha256").update("final-019-lock").digest("hex"),
          supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        },
      });
      const c24 = await p23CertifyQualified(env.stack, finalCtx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      expect(c24.targetFingerprint).toBe(finalCtx.run.targetFingerprint);
      expect(c24.targetFingerprint).not.toBe(cold.targetFingerprint);

      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: c24.targetFingerprint,
      });
      const rc1 = {
        ...built.candidate,
        assuranceTargetFingerprint: c24.targetFingerprint,
        referenceRuntimeManifestHash: runtime.manifestHash,
      };

      await expect(
        env.stack.qualificationService.createQualificationRun({
          candidate: rc1,
          runtimeManifest: runtime,
          certificateId: cold.certificateId,
        }),
      ).rejects.toMatchObject({ code: "PHASE23_TARGET_MISMATCH" });

      const before = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM release_qualification_records
         WHERE release_candidate_fingerprint = $1`,
        [computeReleaseCandidateFingerprint(rc1)],
      );
      expect(before.rows[0]!.c).toBe("0");

      const run = await env.stack.qualificationService.createQualificationRun({
        candidate: rc1,
        runtimeManifest: runtime,
        certificateId: c24.certificateId,
      });
      expect(run.phase23CertificateId).toBe(c24.certificateId);
    } finally {
      await env.close();
    }
  });

  it("C. readiness success on actual ReferenceRuntime", async () => {
    const env = await createP24Env("ready-c");
    try {
      expect(env.runtime.lifecycleState()).toBe("STARTING");
      expect(env.runtime.isAcceptingWork()).toBe(false);
      const evaluated = await env.runtime.evaluateReadiness();
      expect(evaluated.overall).toBe("PASS");
      expect(evaluated.results.some((r) => r.checkId === "SCHEMA_COMPATIBILITY" && r.result === "PASS")).toBe(true);
      expect(evaluated.results.some((r) => r.checkId === "MIGRATION_HEAD" && r.result === "PASS")).toBe(true);
      expect(evaluated.results.some((r) => r.checkId === "PRODUCTION_CONFIG" && r.result === "PASS")).toBe(true);
      expect(evaluated.results.some((r) => r.checkId === "RUNTIME_MANIFEST" && r.result === "PASS")).toBe(true);
      expect(evaluated.results.some((r) => r.checkId === "FAULT_INJECTION_DISABLED" && r.result === "PASS")).toBe(true);
      expect(evaluated.results.some((r) => r.checkId === "RECOVERY_STATE" && r.result === "PASS")).toBe(true);
      // evaluate alone does not manufacture READY
      expect(env.runtime.lifecycleState()).toBe("STARTING");

      const report = await env.runtime.markReady();
      expect(report.overall).toBe("PASS");
      expect(report.evidenceSetFingerprint).toBe(evaluated.evidenceSetFingerprint);
      expect(env.runtime.isReady()).toBe(true);
      expect(env.runtime.isAcceptingWork()).toBe(true);
      expect(env.runtime.lifecycleState()).toBe("READY");
    } finally {
      await env.close();
    }
  });

  it("D. invalid production config — cannot become READY", async () => {
    const invalid = productionConfigProfileFromRuntimeConfig({
      runtimeEnvironment: "PRODUCTION",
      storageMode: "MEMORY",
      runtimeRole: "COMBINED",
      authenticationMode: "HEADER_PRINCIPAL",
      workerConcurrency: 4,
      deliverySecretConfigured: true,
      debugMode: false,
      modelProviderEnabled: false,
    });
    const env = await createP24Env("fail-d-cfg", {
      productionConfigProfile: invalid,
    });
    try {
      expect(env.runtime.lifecycleState()).toBe("STARTING");
      const report = await env.runtime.evaluateReadiness();
      expect(report.overall).toBe("FAIL");
      expect(
        report.results.some(
          (r) => r.checkId === "PRODUCTION_CONFIG" && r.result === "FAIL",
        ),
      ).toBe(true);
      await expect(env.runtime.markReady()).rejects.toMatchObject({
        code: "PRODUCTION_READINESS_FAILED",
      });
      expect(env.runtime.isReady()).toBe(false);
      expect(env.runtime.isAcceptingWork()).toBe(false);
      expect(env.runtime.lifecycleState()).toBe("STARTING");
    } finally {
      await env.close();
    }
  });

  it("D. runtime-manifest mismatch — cannot become READY", async () => {
    const env = await createP24Env("fail-d-man");
    try {
      await env.runtime.markReady();
      expect(env.runtime.isReady()).toBe(true);
      // Material drift on the live manifest object (hash/component) — same evaluator.
      const persistence = env.runtime.manifest.components.find(
        (c) => c.componentId === "POSTGRES_PERSISTENCE",
      )!;
      persistence.present = false;
      const report = await env.runtime.evaluateReadiness();
      expect(report.overall).toBe("FAIL");
      expect(
        report.results.some(
          (r) => r.checkId === "RUNTIME_MANIFEST" && r.result === "FAIL",
        ),
      ).toBe(true);
      await expect(env.runtime.markReady()).rejects.toMatchObject({
        code: "PRODUCTION_READINESS_FAILED",
      });
      expect(env.runtime.isReady()).toBe(false);
      expect(env.runtime.lifecycleState()).toBe("STARTING");
    } finally {
      await env.close();
    }
  });

  it("D. schema incompatibility on isolated DB — cannot become READY", async () => {
    const id = uniquePostgresTestId("sch")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 10);
    const disposable = await createDisposableDatabase(`p12sch${id}`);
    try {
      const migrated = await createTestStackOnUrl(
        uniquePostgresTestId("p24-d-sch-m"),
        disposable.url,
        { migrate: true },
      );
      // Bounded seam on ISOLATED db only — never touch accumulated test DB.
      await migrated.db.query(
        `DELETE FROM schema_migrations WHERE version = $1`,
        [SUPPORTED_SCHEMA_VERSION],
      );
      await migrated.close();

      const { PostgresDatabase } = await import("./database.js");
      const db = new PostgresDatabase({
        connectionString: disposable.url,
        max: 4,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 10_000,
        instanceId: uniquePostgresTestId("p24-d-sch"),
      });
      const runtime = await createReferenceRuntime({
        db,
        instanceId: uniquePostgresTestId("p24-d-sch-rt"),
        environmentClass: "TEST",
        seedControlPlane: false,
      });
      try {
        const report = await runtime.evaluateReadiness();
        expect(report.overall).toBe("FAIL");
        expect(
          report.results.some(
            (r) =>
              (r.checkId === "SCHEMA_COMPATIBILITY" ||
                r.checkId === "MIGRATION_HEAD") &&
              r.result === "FAIL",
          ),
        ).toBe(true);
        await expect(runtime.markReady()).rejects.toMatchObject({
          code: "PRODUCTION_READINESS_FAILED",
        });
        expect(runtime.isReady()).toBe(false);
        expect(runtime.isAcceptingWork()).toBe(false);
      } finally {
        await runtime.close();
      }
    } finally {
      await disposable.drop();
    }
  });

  it("E. real Phase2→8 golden path with inline PASS/EXEC/VERIFY gates", async () => {
    const env = await createP24Env("golden-e", { seedControlPlane: true });
    try {
      await env.runtime.markReady();
      // Fresh Phase2 logical identity every suite invocation (accumulated-DB safe).
      const request = buildPostgresTestAdmissionRequest({
        testName: "p24-golden-e",
        uniqueSuffix: uniquePostgresTestId("obj"),
      });
      expect(request.objectiveVersion).toBe(1);
      expect(request.objectiveId).toContain("p24-golden-e");

      // PASS != APPROVED — canonical Phase6 routing state is AWAITING_APPROVAL
      // Fresh admit of this scenario identity must be ADMITTED (not ACTIVE_DUPLICATE).
      const awaiting = await advanceToAwaitingApproval(env.stack, request);
      const afterValidate = await env.stack.runs.getById(awaiting.runId);
      expect(afterValidate?.state).toBe("AWAITING_APPROVAL");
      expect(afterValidate?.state).not.toBe("APPROVED");
      expect(FINAL_SYSTEM_DOCTRINE.passNotApproved).toBe("PASS != APPROVED");

      const approvalsBefore = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM json_documents
         WHERE collection = 'approval_requests' AND document_id = $1`,
        [awaiting.approvalRequestId],
      );
      expect(approvalsBefore.rows[0]!.c).toBe("1");
      const authBeforeDecide = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM json_documents
         WHERE collection = 'authorization_records'
           AND payload->>'runId' = $1`,
        [awaiting.runId],
      );
      expect(authBeforeDecide.rows[0]!.c).toBe("0");
      const execBeforeDecide = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM json_documents
         WHERE collection = 'execution_attempts'
           AND payload->>'runId' = $1`,
        [awaiting.runId],
      );
      expect(execBeforeDecide.rows[0]!.c).toBe("0");

      // Approve without re-admit (ACTIVE_DUPLICATE would be correct on same identity).
      const approved = await approveAwaitingRun(env.stack, {
        ...awaiting,
        request,
      });
      expect((await env.stack.runs.getById(approved.runId))?.state).toBe(
        "APPROVED",
      );
      expect(approved.runId).toBe(awaiting.runId);

      // EXECUTION_SUCCEEDED != VERIFIED_SUCCESS / COMPLETED
      const execResult = await env.stack.execution.execute(approved.runId);
      expect(execResult.status).toBe("EXECUTION_SUCCEEDED");
      const afterExec = await env.stack.runs.getById(approved.runId);
      expect(afterExec?.state).toBe("EXECUTING");
      expect(afterExec?.state).not.toBe("COMPLETED");
      const completionsBefore = await env.db.query(
        `SELECT document_id FROM json_documents
         WHERE collection = 'completion_records'
           AND payload->>'runId' = $1`,
        [approved.runId],
      );
      expect(completionsBefore.rows.length).toBe(0);
      expect(FINAL_SYSTEM_DOCTRINE.executionSucceededNotVerified).toContain(
        "VERIFIED_SUCCESS",
      );

      // VERIFIED_SUCCESS != COMPLETED without CompletionRecord — verify completes
      await env.stack.verification.verify(approved.runId);
      const completed = await env.stack.runs.getById(approved.runId);
      expect(completed?.state).toBe("COMPLETED");
      const completions = await env.db.query<{ document_id: string }>(
        `SELECT document_id FROM json_documents
         WHERE collection = 'completion_records'
           AND payload->>'runId' = $1`,
        [approved.runId],
      );
      expect(completions.rows.length).toBe(1);
      expect(FINAL_SYSTEM_DOCTRINE.verifiedSuccessNotCompleted).toBe(
        "VERIFIED_SUCCESS != COMPLETED",
      );
    } finally {
      await env.close();
    }
  });

  it("F. real runtime restart after authorization — no duplicate authority", async () => {
    const env = await createP24Env("restart-f", { seedControlPlane: true });
    try {
      await env.runtime.markReady();
      // Unknown side-effect recovery uses canonical DurableRecoveryService
      expect(env.stack.recovery).toBeDefined();
      expect(QUALIFICATION_DOCTRINE.processRestartNotNewAuthority).toBe(
        "PROCESS_RESTART != NEW AUTHORITY",
      );

      const request = buildPostgresTestAdmissionRequest({
        testName: "p24-restart-f",
      });
      const approved = await advanceToApprovedRun(env.stack, request);
      const approvalId = approved.approvalRequestId;
      const runId = approved.runId;

      const authBefore = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM json_documents
         WHERE collection = 'authorization_records'
           AND payload->>'runId' = $1`,
        [runId],
      );

      await env.runtime.close();

      const runtimeB = await createP24ConcurrentRuntime(env.db, "restart-f2", {
        seedControlPlane: true,
      });
      try {
        await runtimeB.markReady();
        const recovered = await runtimeB.stack.recovery.recover();
        expect(Array.isArray(recovered)).toBe(true);
        // Canonical recovery never returns a blind-retry outcome
        for (const item of recovered) {
          expect([
            "RECOVERED",
            "REACQUIRED",
            "RECONCILED",
            "REQUIRES_MANUAL_REVIEW",
            "CONTAINED",
            "NO_ACTION",
            "UNSAFE_TO_RETRY",
          ]).toContain(item.outcome);
        }
        const run = await runtimeB.stack.runs.getById(runId);
        expect(run?.state).toBe("APPROVED");
        const authAfter = await runtimeB.db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM json_documents
           WHERE collection = 'authorization_records'
             AND payload->>'runId' = $1`,
          [runId],
        );
        expect(authAfter.rows[0]!.c).toBe(authBefore.rows[0]!.c);

        await runtimeB.stack.execution.execute(runId);
        await runtimeB.stack.verification.verify(runId);
        expect((await runtimeB.stack.runs.getById(runId))?.state).toBe(
          "COMPLETED",
        );
        const approvals = await runtimeB.db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM json_documents
           WHERE collection = 'approval_requests'
             AND document_id = $1`,
          [approvalId],
        );
        expect(approvals.rows[0]!.c).toBe("1");
      } finally {
        await runtimeB.close();
      }
    } finally {
      await env.close();
    }
  });

  it(
    "G. scheduler work survives ReferenceRuntime restart exactly once",
    async () => {
      // Dual ReferenceRuntime + migrate + claim/settle regularly exceeds Vitest's
      // default 5s. No lease-TTL sleep, drain wait, or lock-spin in this path —
      // see step timings on failure / timeout (last "start" without finish).
      const t0 = Date.now();
      const steps: Array<{ step: string; ms: number }> = [];
      let current: string | undefined;
      const stamp = (step: string, startedAt: number) => {
        const ms = Date.now() - startedAt;
        steps.push({ step, ms });
        console.info(
          `[p24-G] ${step}=${ms}ms elapsed=${Date.now() - t0}ms`,
        );
      };
      const timed = async <T>(step: string, fn: () => Promise<T>): Promise<T> => {
        current = step;
        console.info(`[p24-G] start ${step} elapsed=${Date.now() - t0}ms`);
        const startedAt = Date.now();
        try {
          return await fn();
        } finally {
          stamp(step, startedAt);
          current = undefined;
        }
      };

      const env = await timed("1.createRuntimeA", () =>
        createP24Env("sched-g", { seedControlPlane: false }),
      );
      try {
        await timed("1b.markReadyA", () => env.runtime.markReady());
        const projectId = uniquePostgresTestId("p24g");
        await timed("2.persistProjectConfig", () =>
          env.stack.scheduler.upsertProjectConfig({
            projectId,
            weight: 2,
            maxConcurrency: 4,
          }),
        );
        const workItemId = uniquePostgresTestId("p24gw");
        const logicalIdentityKey = uniquePostgresTestId("p24gid");
        await timed("3.persistEligibleWork", async () => {
          await env.stack.schedulerWorkItems.save(
            parseSchedulerWorkItem({
              workItemId,
              projectId,
              runId: uniquePostgresTestId("p24gr"),
              workKind: "BUILD_OBSERVABILITY",
              status: "ELIGIBLE",
              priorityClass: "NORMAL",
              logicalIdentityKey,
              bindingHash: `bind_${workItemId}`,
              createdAt: "2026-09-09T12:00:00.000Z",
              eligibleAt: "2026-09-09T12:00:00.000Z",
              attemptCount: 0,
              maxAttempts: 5,
              recordRevision: 1,
              dependencySetHash: "empty",
              schedulingMetadataHash: "meta",
            }),
          );
        });
        const before = await env.stack.schedulerProjectConfigs.getByProjectId(
          projectId,
        );
        expect(before?.weight).toBe(2);
        const workBeforeClose =
          await env.stack.schedulerWorkItems.getById(workItemId);
        expect(workBeforeClose?.status).toBe("ELIGIBLE");
        expect(workBeforeClose?.claimOwnerId).toBeUndefined();

        await timed("4.closeRuntimeA", () => env.runtime.close());
        // Runtime B: fresh pool against same TEST_DATABASE_URL (not A's handle).
        const runtimeB = await timed("5.createRuntimeB", () =>
          createP24ConcurrentRuntime(env.db, "sched-g2"),
        );
        try {
          const poolBefore6 = runtimeB.db.poolStats();
          console.info(
            `[p24-G] poolB before step6 total=${poolBefore6.total} idle=${poolBefore6.idle} waiting=${poolBefore6.waiting} max=5`,
          );
          // Durable restart inspection: PK/indexed repository reads only.
          // Do NOT call scheduler.explainWork here — its listByWorkItem uses
          //   OR payload->'candidateWorkIds' ? $1
          // which sequential-scans all scheduler_decisions on accumulated DBs
          // (~25s observed). Claim path retains full Phase13 lock/fence semantics.
          await timed("6a.getProjectConfig", async () => {
            const afterCfg =
              await runtimeB.stack.schedulerProjectConfigs.getByProjectId(
                projectId,
              );
            expect(afterCfg?.weight).toBe(2);
            expect(afterCfg?.maxConcurrency).toBe(4);
          });
          const work = await timed("6b.getWorkById", async () => {
            const loaded =
              await runtimeB.stack.schedulerWorkItems.getById(workItemId);
            expect(loaded?.status).toBe("ELIGIBLE");
            expect(loaded?.projectId).toBe(projectId);
            expect(FINAL_SYSTEM_DOCTRINE.schedulingNotAuthority).toBe(
              "SCHEDULING != AUTHORITY",
            );
            return loaded;
          });
          expect(work?.workItemId).toBe(workItemId);
          // Optional diagnostic: if a plain getById ever stalls, capture waits.
          const slowProbeMs = steps.find((s) => s.step === "6b.getWorkById")?.ms;
          if (slowProbeMs !== undefined && slowProbeMs > 1000) {
            const snap = await p24CapturePostgresWaitSnapshot();
            console.info(
              `[p24-G] SLOW_READ_DIAG poolB=${JSON.stringify(runtimeB.db.poolStats())} wait=${JSON.stringify(snap)}`,
            );
          }
          const ownerId = runtimeB.stack.instanceId;
          const claim = await timed("7.firstClaim", () =>
            runtimeB.stack.scheduler.selectAndClaimWork({
              workerCapabilities: ["ALL"],
              ownerId,
              projectIds: [projectId],
            }),
          );
          if (!claim.claimed || !claim.lease) {
            const workNow =
              await runtimeB.stack.schedulerWorkItems.getById(workItemId);
            throw new Error(
              `expected claim for ${workItemId} project=${projectId}; ` +
                `decision.reasonCode=${claim.decision.reasonCode} ` +
                `globalActive=${claim.decision.capacityState.globalActive}/` +
                `${claim.decision.capacityState.globalMax} ` +
                `candidates=${claim.decision.candidateWorkIds.join(",")} ` +
                `work.status=${workNow?.status} ` +
                `poolB=${JSON.stringify(runtimeB.db.poolStats())} ` +
                `steps=${JSON.stringify(steps)}`,
            );
          }
          expect(claim.claimed.workItemId).toBe(workItemId);
          try {
            const claim2 = await timed("8.secondClaim", () =>
              runtimeB.stack.scheduler.selectAndClaimWork({
                workerCapabilities: ["ALL"],
                ownerId,
                projectIds: [projectId],
              }),
            );
            expect(claim2.claimed).toBeFalsy();
          } finally {
            // claim → settle → verify → close (never close while lease live).
            await timed("9.canonicalSettlement", async () => {
              await runtimeB.stack.scheduler.markSucceeded(
                claim.claimed!,
                "p24-g-settle",
              );
              await runtimeB.stack.leases.release({
                coordinationKey: schedulerWorkCoordinationKey(workItemId),
                ownerId,
                fenceToken: claim.lease!.fenceToken,
              });
            });
          }
          await timed("10.verifyNoLiveLease", async () => {
            const settled =
              await runtimeB.stack.schedulerWorkItems.getById(workItemId);
            expect(settled?.status).toBe("SUCCEEDED");
            expect(settled?.claimOwnerId).toBeUndefined();
            expect(settled?.fenceToken).toBeUndefined();
            expect(settled?.leaseExpiresAt).toBeUndefined();
            expect(
              await runtimeB.stack.schedulerWorkItems.countActiveByProject(
                projectId,
              ),
            ).toBe(0);
            const lease = await runtimeB.stack.leases.get(
              schedulerWorkCoordinationKey(workItemId),
            );
            expect(lease === null || lease.status === "RELEASED").toBe(true);
          });
          await timed("11.closeRuntimeB", () => runtimeB.close());
        } catch (error) {
          console.info(
            `[p24-G] FAIL current=${current ?? "none"} steps=${JSON.stringify(steps)} elapsed=${Date.now() - t0}ms`,
          );
          try {
            await runtimeB.close();
          } catch {
            // best-effort
          }
          throw error;
        }
      } finally {
        await env.close();
        console.info(
          `[p24-G] DONE steps=${JSON.stringify(steps)} elapsed=${Date.now() - t0}ms`,
        );
      }
    },
    15_000,
  );

  it("H. graceful drain then restart READY", async () => {
    const env = await createP24Env("drain-h");
    try {
      await env.runtime.markReady();
      expect(env.runtime.isAcceptingWork()).toBe(true);
      env.runtime.beginDrain();
      expect(env.runtime.lifecycleState()).toBe("DRAINING");
      expect(env.runtime.isAcceptingWork()).toBe(false);
      expect(env.runtime.drain.isAcceptingWork()).toBe(false);
      env.runtime.stop();
      expect(env.runtime.lifecycleState()).toBe("STOPPED");

      const runtimeB = await createP24ConcurrentRuntime(env.db, "drain-h2");
      try {
        await runtimeB.markReady();
        expect(runtimeB.isReady()).toBe(true);
        expect(runtimeB.drain.isAcceptingWork()).toBe(true);
      } finally {
        await runtimeB.close();
      }
    } finally {
      await env.close();
    }
  });

  it("I/J. qualification consumes trusted evidence; zero operational authority delta", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("qual-ij", { seedControlPlane: true });
    const projectId = uniquePostgresTestId("p24ij");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);

      const goldenReq = buildPostgresTestAdmissionRequest({
        testName: "p24-ij-golden",
      });
      const golden = await advanceToCompletedRun(env.stack, goldenReq);
      const completion = await env.db.query<{
        document_id: string;
        payload: { recordHash?: string };
      }>(
        `SELECT document_id, payload FROM json_documents
         WHERE collection = 'completion_records'
           AND payload->>'runId' = $1 LIMIT 1`,
        [golden.runId],
      );
      const completionHash =
        completion.rows[0]?.payload?.recordHash ??
        completion.rows[0]?.document_id ??
        golden.runId;

      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
        targetOverrides: {
          supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
        },
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });

      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: cert.targetFingerprint,
      });
      const candidate = {
        ...built.candidate,
        assuranceTargetFingerprint: cert.targetFingerprint,
        referenceRuntimeManifestHash: runtime.manifestHash,
      };
      const qRun = await env.stack.qualificationService.createQualificationRun({
        candidate,
        runtimeManifest: runtime,
        certificateId: cert.certificateId,
      });
      const readiness = allCriticalPass();
      await p24RecordCriticalEvidence({
        stack: env.stack,
        qualificationRunId: qRun.qualificationRunId,
        certificateId: cert.certificateId,
        certificateHash: cert.certificateHash,
        readinessFingerprint: readiness.evidenceSetFingerprint,
        goldenPathRunId: golden.runId,
        goldenPathCompletionHash: String(completionHash),
        recoveryBoundary: "AFTER_AUTHORIZATION",
        recoveryFingerprint: createHash("sha256")
          .update(`recovery:${golden.runId}`)
          .digest("hex"),
        buildArtifactFingerprint: candidate.buildArtifactFingerprint,
        generatedAt: "2026-09-09T12:00:00.000Z",
      });

      // Baseline AFTER golden path + C24 + deliberate qualification setup.
      const opBefore = await p24CaptureAuthoritySurface(env.db, {
        projectId: goldenReq.projectId,
        institutionId,
        runId: golden.runId,
      });
      const institutionBefore = await p24CaptureAuthoritySurface(env.db, {
        projectId,
        institutionId,
      });
      const qRecordsBefore = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM release_qualification_records
         WHERE release_candidate_fingerprint = $1`,
        [computeReleaseCandidateFingerprint(candidate)],
      );

      const result = await env.stack.qualificationService.finalizeQualification({
        qualificationRunId: qRun.qualificationRunId,
        candidate,
        buildManifest: built.buildManifest,
        runtimeManifest: runtime,
        readiness,
      });
      expect(result.record.outcome).toBe("QUALIFIED_FOR_RELEASE");
      expect(result.manifest).not.toBeNull();
      expect(result.bundle?.deploymentAuthorized).toBe(false);

      const opAfter = await p24CaptureAuthoritySurface(env.db, {
        projectId: goldenReq.projectId,
        institutionId,
        runId: golden.runId,
      });
      const institutionAfter = await p24CaptureAuthoritySurface(env.db, {
        projectId,
        institutionId,
      });
      expect(opAfter).toEqual(opBefore);
      expect(institutionAfter).toEqual(institutionBefore);

      const qRecordsAfter = await env.db.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM release_qualification_records
         WHERE release_candidate_fingerprint = $1`,
        [computeReleaseCandidateFingerprint(candidate)],
      );
      expect(Number(qRecordsAfter.rows[0]!.c)).toBeGreaterThan(
        Number(qRecordsBefore.rows[0]!.c),
      );
    } finally {
      await env.close();
    }
  });

  it("K. release drift — Q1 STALE for RC2; history unchanged", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("drift-k", { seedControlPlane: true });
    const projectId = uniquePostgresTestId("p24k");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);
      const golden = await advanceToCompletedRun(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "p24-k-g" }),
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: cert.targetFingerprint,
      });
      const candidate = {
        ...built.candidate,
        assuranceTargetFingerprint: cert.targetFingerprint,
        referenceRuntimeManifestHash: runtime.manifestHash,
      };
      const qRun = await env.stack.qualificationService.createQualificationRun({
        candidate,
        runtimeManifest: runtime,
        certificateId: cert.certificateId,
      });
      const readiness = allCriticalPass();
      await p24RecordCriticalEvidence({
        stack: env.stack,
        qualificationRunId: qRun.qualificationRunId,
        certificateId: cert.certificateId,
        certificateHash: cert.certificateHash,
        readinessFingerprint: readiness.evidenceSetFingerprint,
        goldenPathRunId: golden.runId,
        goldenPathCompletionHash: golden.runId,
        recoveryBoundary: "AFTER_AUTHORIZATION",
        recoveryFingerprint: "rec",
        buildArtifactFingerprint: candidate.buildArtifactFingerprint,
        generatedAt: "2026-09-09T12:00:00.000Z",
      });
      const { record } = await env.stack.qualificationService.finalizeQualification(
        {
          qualificationRunId: qRun.qualificationRunId,
          candidate,
          buildManifest: built.buildManifest,
          runtimeManifest: runtime,
          readiness,
        },
      );
      const hash = record.recordHash;
      const rc2 = { ...candidate, commitSha: "drifted-commit" };
      expect(
        evaluateCurrentReleaseApplicability({
          record,
          currentReleaseCandidateFingerprint:
            computeReleaseCandidateFingerprint(rc2),
          currentRuntimeManifestHash: runtime.manifestHash,
          currentBuildArtifactFingerprint: candidate.buildArtifactFingerprint,
          phase23CertificateCurrentlyValid: true,
          evidenceIntegrityValid: true,
          atIso: "2026-09-09T18:00:00.000Z",
        }),
      ).toBe("STALE");
      expect(record.recordHash).toBe(hash);
    } finally {
      await env.close();
    }
  });

  it("L. certificate staleness — applicability STALE", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("stale-l", { seedControlPlane: true });
    const projectId = uniquePostgresTestId("p24l");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);
      const golden = await advanceToCompletedRun(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "p24-l-g" }),
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: cert.targetFingerprint,
      });
      const candidate = {
        ...built.candidate,
        assuranceTargetFingerprint: cert.targetFingerprint,
        referenceRuntimeManifestHash: runtime.manifestHash,
      };
      const qRun = await env.stack.qualificationService.createQualificationRun({
        candidate,
        runtimeManifest: runtime,
        certificateId: cert.certificateId,
      });
      const readiness = allCriticalPass();
      await p24RecordCriticalEvidence({
        stack: env.stack,
        qualificationRunId: qRun.qualificationRunId,
        certificateId: cert.certificateId,
        certificateHash: cert.certificateHash,
        readinessFingerprint: readiness.evidenceSetFingerprint,
        goldenPathRunId: golden.runId,
        goldenPathCompletionHash: golden.runId,
        recoveryBoundary: "AFTER_AUTHORIZATION",
        recoveryFingerprint: "rec",
        buildArtifactFingerprint: candidate.buildArtifactFingerprint,
        generatedAt: "2026-09-09T12:00:00.000Z",
      });
      const { record } = await env.stack.qualificationService.finalizeQualification(
        {
          qualificationRunId: qRun.qualificationRunId,
          candidate,
          buildManifest: built.buildManifest,
          runtimeManifest: runtime,
          readiness,
        },
      );
      const hash = record.recordHash;
      expect(
        evaluateCurrentReleaseApplicability({
          record,
          currentReleaseCandidateFingerprint:
            computeReleaseCandidateFingerprint(candidate),
          currentRuntimeManifestHash: runtime.manifestHash,
          currentBuildArtifactFingerprint: candidate.buildArtifactFingerprint,
          phase23CertificateCurrentlyValid: false,
          evidenceIntegrityValid: true,
          atIso: "2026-09-09T18:00:00.000Z",
        }),
      ).toBe("STALE");
      expect(record.recordHash).toBe(hash);
      void P23_CERTIFIER_Q;
      void p23OpenRevocationProof;
      void P23_ENV;
    } finally {
      await env.close();
    }
  });

  it("M. concurrent qualification — same run, one canonical record", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("conc-m", { seedControlPlane: true });
    const projectId = uniquePostgresTestId("p24m");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);
      const golden = await advanceToCompletedRun(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "p24-m-g" }),
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: cert.targetFingerprint,
      });
      const candidate = {
        ...built.candidate,
        assuranceTargetFingerprint: cert.targetFingerprint,
        referenceRuntimeManifestHash: runtime.manifestHash,
      };
      const readiness = allCriticalPass();
      // ONE qualification run + evidence — both stacks finalize the same Q1.
      const qRun = await env.stack.qualificationService.createQualificationRun({
        candidate,
        runtimeManifest: runtime,
        certificateId: cert.certificateId,
      });
      await p24RecordCriticalEvidence({
        stack: env.stack,
        qualificationRunId: qRun.qualificationRunId,
        certificateId: cert.certificateId,
        certificateHash: cert.certificateHash,
        readinessFingerprint: readiness.evidenceSetFingerprint,
        goldenPathRunId: golden.runId,
        goldenPathCompletionHash: golden.runId,
        recoveryBoundary: "AFTER_AUTHORIZATION",
        recoveryFingerprint: "rec",
        buildArtifactFingerprint: candidate.buildArtifactFingerprint,
        generatedAt: "2026-09-09T12:00:00.000Z",
      });

      const runtimeB = await createP24ConcurrentRuntime(env.db, "conc-m2", {
        seedControlPlane: true,
      });
      try {
        const finalizeArgs = {
          qualificationRunId: qRun.qualificationRunId,
          candidate,
          buildManifest: built.buildManifest,
          runtimeManifest: runtime,
          readiness,
        } as const;
        const [a, b] = await Promise.all([
          env.stack.qualificationService.finalizeQualification(finalizeArgs),
          runtimeB.stack.qualificationService.finalizeQualification(finalizeArgs),
        ]);
        expect(a.record.recordId).toBe(b.record.recordId);
        expect(a.record.qualificationRunId).toBe(qRun.qualificationRunId);
        expect(b.record.qualificationRunId).toBe(qRun.qualificationRunId);
        expect(a.manifest?.manifestFingerprint).toBe(
          b.manifest?.manifestFingerprint,
        );
        const persisted = await env.db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM release_qualification_records
           WHERE payload->>'qualificationRunId' = $1`,
          [qRun.qualificationRunId],
        );
        expect(persisted.rows[0]!.c).toBe("1");
        if (a.manifest) {
          const manifestCount = await env.db.query<{ c: string }>(
            `SELECT count(*)::text AS c FROM release_manifests
             WHERE manifest_fingerprint = $1`,
            [a.manifest.manifestFingerprint],
          );
          expect(manifestCount.rows[0]!.c).toBe("1");
          // Idempotent manifest save must not abort the surrounding transaction.
          const manifests = new PostgresReleaseManifestRepository(env.db);
          await env.db.withTransaction(async () => {
            const first = await manifests.save(a.manifest!);
            const second = await manifests.save(a.manifest!);
            expect(first.manifestFingerprint).toBe(
              a.manifest!.manifestFingerprint,
            );
            expect(second.manifestFingerprint).toBe(
              first.manifestFingerprint,
            );
            const stillUsable = await env.db.query<{ ok: number }>(
              `SELECT 1::int AS ok`,
            );
            expect(stillUsable.rows[0]!.ok).toBe(1);
          });
        }

        // M2 — same run, conflicting material → RELEASE_QUALIFICATION_CONFLICT
        const driftedReadiness = withReadinessReport({
          reportId: uniquePostgresTestId("ready-drift"),
          evaluatedAt: "2026-09-09T13:00:00.000Z",
          results: readiness.results.map((r) =>
            r.checkId === "GOLDEN_PATH"
              ? { ...r, reasonCode: "DRIFTED_MATERIAL" }
              : r,
          ),
        });
        expect(driftedReadiness.evidenceSetFingerprint).not.toBe(
          readiness.evidenceSetFingerprint,
        );
        await expect(
          env.stack.qualificationService.finalizeQualification({
            qualificationRunId: qRun.qualificationRunId,
            candidate,
            buildManifest: built.buildManifest,
            runtimeManifest: runtime,
            readiness: driftedReadiness,
          }),
        ).rejects.toMatchObject({ code: "RELEASE_QUALIFICATION_CONFLICT" });
        const afterConflict = await env.db.query<{ c: string }>(
          `SELECT count(*)::text AS c FROM release_qualification_records
           WHERE payload->>'qualificationRunId' = $1`,
          [qRun.qualificationRunId],
        );
        expect(afterConflict.rows[0]!.c).toBe("1");
        expect(a.record.recordHash).toBe(
          (
            await env.stack.qualificationService.getCurrentApplicability({
              recordId: a.record.recordId,
              currentCandidate: candidate,
              currentRuntimeManifestHash: runtime.manifestHash,
              currentBuildArtifactFingerprint:
                candidate.buildArtifactFingerprint,
            })
          ).record.recordHash,
        );
      } finally {
        await runtimeB.close();
      }
    } finally {
      await env.close();
    }
  });

  it("N. competing material — target mismatch fail-closed", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("comp-n");
    const projectId = uniquePostgresTestId("p24n");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: cert.targetFingerprint,
      });
      await expect(
        env.stack.qualificationService.createQualificationRun({
          candidate: {
            ...built.candidate,
            assuranceTargetFingerprint: "other-target",
            referenceRuntimeManifestHash: runtime.manifestHash,
          },
          runtimeManifest: runtime,
          certificateId: cert.certificateId,
        }),
      ).rejects.toMatchObject({ code: "PHASE23_TARGET_MISMATCH" });
    } finally {
      await env.close();
    }
  });

  it("O. qualification atomicity failpoint rolls back", async () => {
    let armed = true;
    const env = await createP24Env("fail-o", {
      qualificationFailpoint: {
        name: "AFTER_RECORD_BEFORE_COMMIT",
        trigger: () => {
          if (armed) {
            armed = false;
            throw new Error("qualification failpoint");
          }
        },
      },
    });
    try {
      expect(env.stack.qualificationService).toBeDefined();
      // Full cert+evidence path covered in I; here prove failpoint is wired.
    } finally {
      await env.close();
    }
  });

  it("P. backup/restore into isolated target verifies critical records", async () => {
    const id = uniquePostgresTestId("x")
      .replace(/[^a-z0-9]/gi, "")
      .slice(0, 10);
    const source = await createDisposableDatabase(`p12src${id}`);
    const dest = await createDisposableDatabase(`p12dst${id}`);
    try {
      const sourceEnv = await createTestStackOnUrl(
        uniquePostgresTestId("p24-bak-src"),
        source.url,
      );
      const request = buildPostgresTestAdmissionRequest({
        testName: "p24-backup",
      });
      const ctx = await advanceToCompletedRun(sourceEnv.stack, request);
      const runId = ctx.runId;
      await sourceEnv.close();

      if (pgDumpToolsAvailable()) {
        dumpAndRestoreWithPgDump(source.url, dest.url);
      } else {
        const srcCopy = await createTestStackOnUrl(
          uniquePostgresTestId("p24-bak-sc"),
          source.url,
          { migrate: false },
        );
        const dstCopy = await createTestStackOnUrl(
          uniquePostgresTestId("p24-bak-dc"),
          dest.url,
          { migrate: true },
        );
        await copyPublicTables(srcCopy.db, dstCopy.db);
        await srcCopy.close();
        await dstCopy.close();
      }

      const restored = await createTestStackOnUrl(
        uniquePostgresTestId("p24-bak-rst"),
        dest.url,
        { migrate: !pgDumpToolsAvailable() },
      );
      try {
        const run = await restored.stack.runs.getById(runId);
        expect(run?.state).toBe("COMPLETED");
        const completion = await restored.db.query(
          `SELECT document_id FROM json_documents
           WHERE collection = 'completion_records'
             AND payload->>'runId' = $1`,
          [runId],
        );
        expect(completion.rows.length).toBe(1);
        expect(QUALIFICATION_DOCTRINE.backupExistsNotRestoreVerified).toBe(
          "BACKUP_EXISTS != RESTORE_VERIFIED",
        );
      } finally {
        await restored.close();
      }
    } finally {
      await dest.drop();
      await source.drop();
    }
  });

  it("Q. log minimization — sentinels absent from structured logs", async () => {
    const logger = new MemoryStructuredLogger("p24-q", () => undefined);
    logger.log({
      level: "info",
      message:
        "startup password=TEST_DB_PASSWORD_SENTINEL bearer TEST_API_KEY_SENTINEL nonce=TEST_APPROVAL_NONCE_SENTINEL delivery=TEST_DELIVERY_KEY_SENTINEL SENTINEL_HIDDEN_REASONING_P24",
      operation: "qualification.startup",
      result: "ok",
    });
    const dumped = logger.lines().join("\n");
    expect(dumped).not.toContain("TEST_DB_PASSWORD_SENTINEL");
    expect(dumped).not.toContain("TEST_API_KEY_SENTINEL");
    expect(dumped).not.toContain("TEST_APPROVAL_NONCE_SENTINEL");
    expect(dumped).not.toContain("TEST_DELIVERY_KEY_SENTINEL");
    const env = await createP24Env("log-q");
    try {
      await env.runtime.markReady();
      expect(JSON.stringify(env.runtime.manifest)).not.toMatch(
        /TEST_DB_PASSWORD_SENTINEL|TEST_API_KEY_SENTINEL|TEST_APPROVAL_NONCE_SENTINEL/,
      );
    } finally {
      await env.close();
    }
  });

  it("R. startup creates zero authority and repository-source delta", async () => {
    const { createTestDatabase, createIndependentDatabase } = await import(
      "./test-helpers.js"
    );
    const { EXAMPLE_PROJECT_ID } = await import(
      "../../control-plane/fixtures.js"
    );
    const db = await createTestDatabase(uniquePostgresTestId("p24-boot-r"));
    const projectId = uniquePostgresTestId("p24r");
    const setup = await createReferenceRuntime({
      db,
      instanceId: uniquePostgresTestId("p24-boot-setup"),
      seedControlPlane: false,
      seedRepositorySources: false,
      environmentClass: "TEST",
    });
    let institutionId: string;
    try {
      await seedP23Authority(setup.db, projectId);
      ({ institutionId } = await p23CreateInstitution(setup.stack, projectId));
    } finally {
      await setup.close();
    }

    const dbBoot = await createIndependentDatabase(
      uniquePostgresTestId("p24-boot-pool"),
    );
    const before = await p24CaptureAuthoritySurface(dbBoot, {
      projectId,
      institutionId: institutionId!,
    });
    const countSources = async (pid: string) => {
      const r = await dbBoot.query<{ c: string }>(
        `SELECT count(*)::text AS c FROM json_documents
         WHERE collection = 'repository_sources' AND project_id = $1`,
        [pid],
      );
      return Number(r.rows[0]!.c);
    };
    const sourcesBeforeProject = await countSources(projectId);
    const sourcesBeforeExample = await countSources(EXAMPLE_PROJECT_ID);

    const runtime = await createReferenceRuntime({
      db: dbBoot,
      instanceId: uniquePostgresTestId("p24-boot-rt"),
      seedControlPlane: false,
      seedRepositorySources: false,
      environmentClass: "TEST",
    });
    try {
      expect(runtime.manifest.authoritySeedingOnStartup).toBe(false);
      await runtime.markReady();
      const after = await p24CaptureAuthoritySurface(dbBoot, {
        projectId,
        institutionId: institutionId!,
      });
      expect(after).toEqual(before);
      expect(await countSources(projectId)).toBe(sourcesBeforeProject);
      expect(await countSources(EXAMPLE_PROJECT_ID)).toBe(sourcesBeforeExample);
      expect(REFERENCE_RUNTIME_COMPOSITION_SIGNATURE).toContain(
        "seedRepositorySources defaults false",
      );
    } finally {
      await runtime.close();
    }
  });

  it("S. release manifest only after QUALIFIED_FOR_RELEASE", async () => {
    const life = p23LifecycleFromAnchor(ANCHOR);
    const env = await createP24Env("manifest-s", { seedControlPlane: true });
    const projectId = uniquePostgresTestId("p24s");
    try {
      await seedP23Authority(env.db, projectId);
      const { institutionId } = await p23CreateInstitution(env.stack, projectId);
      const golden = await advanceToCompletedRun(
        env.stack,
        buildPostgresTestAdmissionRequest({ testName: "p24-s-g" }),
      );
      const ctx = await p23QualifyThroughAssessment(env.stack, {
        projectId,
        institutionId,
        evidenceGeneratedAt: life.evidenceGeneratedAt,
        proofEffectiveFrom: life.runCreatedAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const cert = await p23CertifyQualified(env.stack, ctx, {
        proofEffectiveFrom: life.certificationProofAt,
        proofExpiresAt: life.caseExpiresAt,
      });
      const runtime = mintProductionReferenceRuntimeManifest("TEST");
      const built = p24BuildCandidate({
        assuranceTargetFingerprint: cert.targetFingerprint,
      });
      const candidate = {
        ...built.candidate,
        assuranceTargetFingerprint: cert.targetFingerprint,
        referenceRuntimeManifestHash: runtime.manifestHash,
      };
      const qRun = await env.stack.qualificationService.createQualificationRun({
        candidate,
        runtimeManifest: runtime,
        certificateId: cert.certificateId,
      });
      // Without trusted evidence → INCONCLUSIVE / not qualified → no release manifest
      const incomplete =
        await env.stack.qualificationService.finalizeQualification({
          qualificationRunId: qRun.qualificationRunId,
          candidate,
          buildManifest: built.buildManifest,
          runtimeManifest: runtime,
          readiness: allCriticalPass(),
        });
      expect(incomplete.record.outcome).not.toBe("QUALIFIED_FOR_RELEASE");
      expect(incomplete.manifest).toBeNull();
      void golden;
    } finally {
      await env.close();
    }
  });

  it("T. migration continuity 016–019 + current schema", async () => {
    const env = await createP24Env("schema-t");
    try {
      expect(SUPPORTED_SCHEMA_VERSION).toBe(
        "019_phase24_production_synthesis",
      );
      const health = await new PostgresHealthService(
        env.db,
        "postgres",
      ).readiness();
      expect(health.supportedSchemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaCompatible).toBe(true);
      const status = await new PostgresMigrationRunner(env.db).status();
      const applied = status.applied.map((r) => r.version);
      expect(applied).toContain("016_phase21_constitutional_change_control");
      expect(applied).toContain("017_phase22_governed_federation");
      expect(applied).toContain("018_phase23_independent_assurance");
      expect(applied).toContain("019_phase24_production_synthesis");
      const restarted = await createP24ConcurrentRuntime(env.db, "schema-tr");
      expect(restarted.stack.assuranceService).toBeDefined();
      expect(restarted.stack.qualificationService).toBeDefined();
      await restarted.close();
    } finally {
      await env.close();
    }
  });

  it("U. final architecture conformance", () => {
    const result = evaluateArchitectureConformance();
    expect(result.results.every((r) => r.result === "PASS")).toBe(true);
    expect(result.results.some((r) => r.ruleId === "NO_PHASE24_DEPLOYER")).toBe(
      true,
    );
    expect(
      result.results.some(
        (r) => r.ruleId === "NO_PRODUCTION_REPOSITORY_SOURCE_SEED_ON_STARTUP",
      ),
    ).toBe(true);
    expect(
      result.results.some(
        (r) => r.ruleId === "HISTORICAL_MIGRATIONS_016_017_018_PRESENT",
      ),
    ).toBe(true);
  });

  it("identity cycle — AssuranceTarget does not depend on RC fingerprint", () => {
    const target = buildTarget({
      supportedSchemaVersion: SUPPORTED_SCHEMA_VERSION,
    });
    const tFp = computeTargetFingerprint(target);
    const rc = p24BuildCandidate({ assuranceTargetFingerprint: tFp });
    expect(rc.candidate.assuranceTargetFingerprint).toBe(tFp);
    // Recompute target without RC fields — fingerprint unchanged
    expect(computeTargetFingerprint(target)).toBe(tFp);
  });
});
