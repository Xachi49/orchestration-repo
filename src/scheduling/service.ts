import type { RunRecord } from "../admission/run-repository.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { CoordinatorLease } from "../domain/durability/index.js";
import type { CompletionRecord } from "../domain/verification/index.js";
import { DurabilityError, isDurabilityError } from "../durability/errors.js";
import {
  detectDependencyCycle,
  parseCrossRunDependency,
  type CrossRunDependency,
  type DependencyMilestone,
} from "./dependency.js";
import {
  bindingHashForWorkKind,
  candidateWorkKinds,
  type DiscoveryContext,
} from "./discovery-map.js";
import { evaluateEligibility } from "./eligibility.js";
import { SchedulingError } from "./errors.js";
import {
  createFairnessState,
  fairnessSnapshot,
  getProjectDeficit,
  projectWeightClamp,
  type FairnessState,
} from "./fairness.js";
import {
  emptyDependencySetHash,
  hashDependencySet,
  hashSchedulingMetadata,
  workItemIdFromIdentity,
  workLogicalIdentityKey,
} from "./identity.js";
import {
  SCHEDULER_LEASE_PHASE,
  schedulerWorkCoordinationKey,
  type SchedulerLeaseStorePort,
} from "./lease-port.js";
import { parsePriorityClass, PRIORITY_RANK, type PriorityClass } from "./priority.js";
import type {
  PortfolioSnapshot,
  SchedulerDecisionRecord,
  SchedulerPauseRecord,
  SchedulerProjectConfig,
} from "./records.js";
import type {
  SchedulerDecisionRepository,
  SchedulerDependencyRepository,
  SchedulerFairnessRepository,
  SchedulerPauseRepository,
  SchedulerProjectConfigRepository,
  SchedulerWorkItemRepository,
} from "./repositories.js";
import {
  compareCandidates,
  computeSchedulingScore,
  type SchedulingReasonCode,
} from "./score.js";
import {
  DEFAULT_WORK_MAX_ATTEMPTS,
  parseSchedulerWorkItem,
  type SchedulerWorkItem,
} from "./work-item.js";
import {
  workerSupportsKind,
  type SchedulerWorkKind,
  type WorkerCapabilityLabel,
} from "./work-kind.js";
import { createHash, randomUUID } from "node:crypto";

export interface RunArtifactProbe {
  hasVerifiedRepository(runId: string): Promise<boolean>;
  hasPlan(runId: string): Promise<boolean>;
  planBinding(
    runId: string,
  ): Promise<{ planVersion: number; planHash: string; repositoryFingerprint: string } | null>;
  hasValidationPassOrApprovalRequired(runId: string): Promise<boolean>;
  validationDecisionId(runId: string): Promise<string | null>;
  authorizationRecordId(runId: string): Promise<string | null>;
  executionAttemptId(runId: string): Promise<string | null>;
  hasExecutionTerminalForVerification(runId: string): Promise<boolean>;
  completionRecord(runId: string): Promise<CompletionRecord | null>;
  hasLearned(runId: string): Promise<boolean>;
  hasObservabilitySnapshot(projectId: string): Promise<boolean>;
}

export interface PortfolioSchedulerDeps {
  runs: RunRepository;
  workItems: SchedulerWorkItemRepository;
  dependencies: SchedulerDependencyRepository;
  decisions: SchedulerDecisionRepository;
  projectConfigs: SchedulerProjectConfigRepository;
  pauses: SchedulerPauseRepository;
  fairness: SchedulerFairnessRepository;
  artifacts: RunArtifactProbe;
  /** Phase 11 lease store — used inside fairness allocation transactions. */
  leases: SchedulerLeaseStorePort;
  nowIso: () => string;
  globalMaxConcurrency: number;
  runtimeId: string;
}

export interface SelectWorkOptions {
  workerCapabilities: readonly WorkerCapabilityLabel[];
  /**
   * Bounded per-project work page size. Contender discovery is project-aware
   * (DISTINCT schedulable projects), so a noisy project cannot monopolize the
   * global candidate set.
   */
  perProjectLimit?: number;
  /** @deprecated Prefer perProjectLimit — kept as alias for callers. */
  limit?: number;
  /**
   * Optional project allowlist. When set, only these currently schedulable
   * projects compete. Used for scoped capacity/fairness fixtures on shared DBs.
   */
  projectIds?: readonly string[];
}

export interface SelectAndClaimOptions extends SelectWorkOptions {
  ownerId: string;
}

type ScoredCandidate = {
  work: SchedulerWorkItem;
  score: number;
  waitingAgeMs: number;
  priorityContribution: number;
  agingContribution: number;
  deficitContribution: number;
  reason: SchedulingReasonCode;
};

type SelectionSnapshot = {
  now: string;
  scored: ScoredCandidate[];
  weights: Map<string, number>;
  contenderProjectIds: string[];
  globalActive: number;
  fairnessView: FairnessState;
};

export interface MaterializeResult {
  created: SchedulerWorkItem[];
  reused: SchedulerWorkItem[];
}

/**
 * Portfolio scheduler application service.
 * SCHEDULING != AUTHORITY. Dispatch still re-checks phase readiness.
 * Fairness state is durable; process memory is not authority.
 */
export class PortfolioSchedulerService {
  constructor(private readonly deps: PortfolioSchedulerDeps) {}

  /** Reload durable deficits for tests/diagnostics. */
  async loadFairnessView(): Promise<FairnessState> {
    return createFairnessState(await this.deps.fairness.listAll());
  }

  async discoverForRun(runId: string): Promise<MaterializeResult> {
    let run;
    try {
      run = await this.deps.runs.getById(runId);
    } catch (error) {
      // Historical corrupt payloads must not abort a bounded discovery batch.
      if (
        isDurabilityError(error) &&
        error.code === "PERSISTED_RECORD_INVALID"
      ) {
        return { created: [], reused: [] };
      }
      throw error;
    }
    if (!run) {
      return { created: [], reused: [] };
    }
    const context = await this.buildDiscoveryContext(run);
    const kinds = candidateWorkKinds(context);
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    const config = await this.configFor(run.projectId);
    const depsForRun = await this.deps.dependencies.listByDependentRun(runId);
    const dependencySetHash = hashDependencySet(
      depsForRun.map((item) => item.dependencyId),
    );

    for (const workKind of kinds) {
      const fingerprints = await this.fingerprintsFor(run, workKind);
      const bindingHash = bindingHashForWorkKind(workKind, fingerprints);
      const logicalIdentityKey = workLogicalIdentityKey({
        runId: run.runId,
        workKind,
        bindingHash,
      });
      const existing =
        await this.deps.workItems.getByLogicalIdentity(logicalIdentityKey);
      if (existing) {
        reused.push(existing);
        continue;
      }
      const now = this.deps.nowIso();
      const priorityClass = config.defaultPriorityClass;
      const item = parseSchedulerWorkItem({
        workItemId: workItemIdFromIdentity(logicalIdentityKey),
        projectId: run.projectId,
        runId: run.runId,
        workKind,
        status: depsForRun.length > 0 ? "WAITING" : "ELIGIBLE",
        priorityClass,
        logicalIdentityKey,
        bindingHash,
        createdAt: now,
        eligibleAt: now,
        attemptCount: 0,
        maxAttempts: DEFAULT_WORK_MAX_ATTEMPTS,
        recordRevision: 1,
        dependencySetHash:
          depsForRun.length > 0 ? dependencySetHash : emptyDependencySetHash(),
        schedulingMetadataHash: hashSchedulingMetadata({
          priorityClass,
          projectWeight: config.weight,
        }),
      });
      const depsOk = await this.areDependenciesSatisfied(run.runId);
      if (!depsOk.satisfied) {
        item.status = depsOk.unsatisfiable
          ? "CANCELLED"
          : "BLOCKED_DEPENDENCY";
        if (depsOk.unsatisfiable) {
          item.failureReasonCode = "DEPENDENCY_UNSATISFIABLE";
        }
      } else {
        item.status = "ELIGIBLE";
      }
      await this.deps.workItems.save(item);
      created.push(item);
    }
    return { created, reused };
  }

  async discoverBatch(runIds: readonly string[]): Promise<MaterializeResult> {
    const created: SchedulerWorkItem[] = [];
    const reused: SchedulerWorkItem[] = [];
    for (const runId of runIds) {
      const result = await this.discoverForRun(runId);
      created.push(...result.created);
      reused.push(...result.reused);
    }
    return { created, reused };
  }

  async registerDependency(input: {
    projectId: string;
    dependentRunId: string;
    prerequisiteRunId: string;
    requiredMilestone: DependencyMilestone;
  }): Promise<CrossRunDependency> {
    if (input.dependentRunId === input.prerequisiteRunId) {
      throw new SchedulingError(
        "SELF_DEPENDENCY",
        "Run cannot depend on itself",
      );
    }
    const dependent = await this.deps.runs.getById(input.dependentRunId);
    const prerequisite = await this.deps.runs.getById(input.prerequisiteRunId);
    if (!dependent || !prerequisite) {
      throw new SchedulingError(
        "INVALID_WORK_ITEM",
        "Dependency references unknown run",
      );
    }
    if (
      dependent.projectId !== input.projectId ||
      prerequisite.projectId !== input.projectId
    ) {
      throw new SchedulingError(
        "CROSS_PROJECT_DEPENDENCY_DENIED",
        "Cross-project dependencies are forbidden in Phase 13",
      );
    }
    const existing = await this.deps.dependencies.listByProject(input.projectId);
    const tentative = [
      ...existing.map((item) => ({
        dependentRunId: item.dependentRunId,
        prerequisiteRunId: item.prerequisiteRunId,
      })),
      {
        dependentRunId: input.dependentRunId,
        prerequisiteRunId: input.prerequisiteRunId,
      },
    ];
    const cycle = detectDependencyCycle(tentative);
    if (cycle.cyclic) {
      throw new SchedulingError("DEPENDENCY_CYCLE", "Dependency cycle detected", {
        path: cycle.path,
      });
    }
    const now = this.deps.nowIso();
    const dependencyHash = createHash("sha256")
      .update(
        JSON.stringify({
          dependentRunId: input.dependentRunId,
          prerequisiteRunId: input.prerequisiteRunId,
          requiredMilestone: input.requiredMilestone,
        }),
        "utf8",
      )
      .digest("hex");
    const dependency = parseCrossRunDependency({
      dependencyId: `sdep_${dependencyHash.slice(0, 24)}`,
      projectId: input.projectId,
      dependentRunId: input.dependentRunId,
      prerequisiteRunId: input.prerequisiteRunId,
      requiredMilestone: input.requiredMilestone,
      createdAt: now,
      dependencyHash,
    });
    return this.deps.dependencies.save(dependency);
  }

  async areDependenciesSatisfied(
    dependentRunId: string,
  ): Promise<{ satisfied: boolean; unsatisfiable: boolean }> {
    const deps =
      await this.deps.dependencies.listByDependentRun(dependentRunId);
    if (deps.length === 0) {
      return { satisfied: true, unsatisfiable: false };
    }
    let unsatisfiable = false;
    for (const dep of deps) {
      const ok = await this.milestoneSatisfied(dep);
      if (ok === "UNSATISFIABLE") {
        unsatisfiable = true;
      }
      if (ok !== "SATISFIED") {
        return { satisfied: false, unsatisfiable };
      }
    }
    return { satisfied: true, unsatisfiable: false };
  }

  async selectWork(
    options: SelectWorkOptions,
  ): Promise<{
    selected: SchedulerWorkItem | null;
    decision: SchedulerDecisionRecord;
  }> {
    await this.reconcileExpiredClaimedWork();
    const fairnessView = createFairnessState(
      await this.deps.fairness.listAll(),
    );
    const snapshot = await this.buildSelectionSnapshot(options, fairnessView);
    const decision = this.buildSelectionDecision(snapshot, {
      serviceCreditPending: Boolean(snapshot.scored[0]),
    });
    await this.deps.decisions.append(decision);
    return { selected: snapshot.scored[0]?.work ?? null, decision };
  }

  /**
   * CLAIMED + missing/expired Phase 11 lease → return to ELIGIBLE.
   * Does not touch RUNNING (Phase 11/12 recovery / containment).
   */
  async reconcileExpiredClaimedWork(limit = 200): Promise<number> {
    const expired = await this.deps.workItems.listExpiredClaimed(limit);
    let recovered = 0;
    for (const item of expired) {
      const live = await this.deps.leases.isLiveHeld(
        schedulerWorkCoordinationKey(item.workItemId),
      );
      if (live) {
        continue;
      }
      try {
        await this.deps.workItems.updateCas(
          {
            ...item,
            status: "ELIGIBLE",
            claimOwnerId: undefined,
            fenceToken: undefined,
            leaseExpiresAt: undefined,
          },
          item.recordRevision,
        );
        recovered += 1;
      } catch (error) {
        if (
          error instanceof SchedulingError &&
          error.code === "SCHEDULER_CAS_CONFLICT"
        ) {
          continue;
        }
        throw error;
      }
    }
    return recovered;
  }

  /**
   * Atomic allocation boundary:
   * lock fairness → load current deficits → project-aware select →
   * Phase 11 lease claim → fairness service charge → decision → COMMIT.
   * Phase dispatch must happen outside this method.
   */
  async selectAndClaimWork(
    options: SelectAndClaimOptions,
  ): Promise<{
    claimed: SchedulerWorkItem | null;
    decision: SchedulerDecisionRecord;
    lease: CoordinatorLease | null;
  }> {
    await this.reconcileExpiredClaimedWork();
    return this.deps.fairness.runSerializedAllocation(async (api) => {
      const fairnessRows = await api.loadState();
      const fairnessView = createFairnessState(fairnessRows);
      const snapshot = await this.buildSelectionSnapshot(
        options,
        fairnessView,
      );
      if (snapshot.scored.length === 0) {
        const decision = this.buildSelectionDecision(snapshot, {
          serviceCreditPending: false,
        });
        await this.deps.decisions.append(decision);
        return { claimed: null, decision, lease: null };
      }

      for (const candidate of snapshot.scored) {
        const coordinationKey = schedulerWorkCoordinationKey(
          candidate.work.workItemId,
        );
        let lease: CoordinatorLease;
        try {
          lease = await this.deps.leases.acquire({
            coordinationKey,
            phase: SCHEDULER_LEASE_PHASE,
            ownerId: options.ownerId,
          });
        } catch (error) {
          if (
            error instanceof DurabilityError &&
            error.code === "LEASE_ALREADY_HELD"
          ) {
            continue;
          }
          throw error;
        }

        let claimed: SchedulerWorkItem;
        const decisionId = `sd_${randomUUID()}`;
        try {
          claimed = await this.deps.workItems.updateCas(
            {
              ...candidate.work,
              status: "CLAIMED",
              claimOwnerId: options.ownerId,
              fenceToken: lease.fenceToken,
              leaseExpiresAt: lease.leaseExpiresAt,
              attemptCount: candidate.work.attemptCount + 1,
              lastDecisionId: decisionId,
            },
            candidate.work.recordRevision,
          );
        } catch (error) {
          try {
            await this.deps.leases.release({
              coordinationKey,
              ownerId: options.ownerId,
              fenceToken: lease.fenceToken,
            });
          } catch {
            // best-effort
          }
          if (
            error instanceof SchedulingError &&
            error.code === "SCHEDULER_CAS_CONFLICT"
          ) {
            continue;
          }
          throw error;
        }

        const charge = await api.applyCharge({
          selectedProjectId: claimed.projectId,
          weights: snapshot.weights,
          servedAt: snapshot.now,
          decisionId,
        });

        const decision = this.buildSelectionDecision(
          {
            ...snapshot,
            scored: [
              candidate,
              ...snapshot.scored.filter((c) => c !== candidate),
            ],
          },
          {
            serviceCreditPending: false,
            decisionId,
            selectedOverride: candidate,
            fairnessCharge: {
              deficitsBefore: Object.fromEntries(
                charge.before.map((row) => [row.projectId, row.deficit]),
              ),
              deficitsAfter: Object.fromEntries(
                charge.after.map((row) => [row.projectId, row.deficit]),
              ),
              claimOwnerId: options.ownerId,
              fenceToken: lease.fenceToken,
              fairnessRevisionBefore: Object.fromEntries(
                charge.before.map((row) => [row.projectId, row.recordRevision]),
              ),
              fairnessRevisionAfter: Object.fromEntries(
                charge.after.map((row) => [row.projectId, row.recordRevision]),
              ),
            },
          },
        );
        await this.deps.decisions.append(decision);
        return { claimed, decision, lease };
      }

      const decision = this.buildSelectionDecision(snapshot, {
        serviceCreditPending: false,
        reasonCode: "SKIPPED",
      });
      await this.deps.decisions.append(decision);
      return { claimed: null, decision, lease: null };
    });
  }

  /**
   * Establishes durable CLAIMED status only. Fairness service credit belongs
   * exclusively to selectAndClaimWork so claim+charge stay atomic.
   */
  async markClaimed(
    work: SchedulerWorkItem,
    ownerId: string,
    fenceToken: number,
    leaseExpiresAt: string,
    decisionId?: string,
  ): Promise<SchedulerWorkItem> {
    return this.deps.workItems.updateCas(
      {
        ...work,
        status: "CLAIMED",
        claimOwnerId: ownerId,
        fenceToken,
        leaseExpiresAt,
        attemptCount: work.attemptCount + 1,
        ...(decisionId !== undefined ? { lastDecisionId: decisionId } : {}),
      },
      work.recordRevision,
    );
  }

  private async buildSelectionSnapshot(
    options: SelectWorkOptions,
    fairnessView: FairnessState,
  ): Promise<SelectionSnapshot> {
    const perProjectLimit = options.perProjectLimit ?? options.limit ?? 16;
    const now = this.deps.nowIso();
    const globalPause = await this.deps.pauses.getGlobal();
    const globalPaused = Boolean(globalPause?.paused);
    const globalActive = await this.deps.workItems.countActiveGlobal();
    const contenders =
      await this.deps.workItems.listSchedulableProjectSummaries(now);
    const contenderProjectIds = contenders.map((c) => c.projectId);
    const weights = new Map<string, number>();
    const scored: ScoredCandidate[] = [];
    const activeByProject = new Map<string, number>();

    for (const contender of contenders) {
      if (
        options.projectIds &&
        !options.projectIds.includes(contender.projectId)
      ) {
        continue;
      }
      const config = await this.configFor(contender.projectId);
      weights.set(contender.projectId, config.weight);
      const projectPause = await this.deps.pauses.getProject(
        contender.projectId,
      );
      if (projectPause?.paused || globalPaused) {
        continue;
      }
      const projectActive =
        activeByProject.get(contender.projectId) ??
        (await this.deps.workItems.countActiveByProject(contender.projectId));
      activeByProject.set(contender.projectId, projectActive);

      const candidates = await this.deps.workItems.listCandidateWorkByProject(
        contender.projectId,
        ["WAITING", "ELIGIBLE", "BLOCKED_DEPENDENCY"],
        perProjectLimit,
      );

      for (const work of candidates) {
        const deps = await this.areDependenciesSatisfied(work.runId);
        if (
          work.status === "BLOCKED_DEPENDENCY" &&
          deps.satisfied &&
          !deps.unsatisfiable
        ) {
          await this.deps.workItems.updateCas(
            {
              ...work,
              status: "ELIGIBLE",
              eligibleAt: now,
            },
            work.recordRevision,
          );
          work.status = "ELIGIBLE";
          work.eligibleAt = now;
        }
        const eligibility = evaluateEligibility({
          work,
          nowIso: now,
          projectPaused: Boolean(projectPause?.paused),
          globalPaused,
          dependenciesSatisfied: deps.satisfied,
          dependencyUnsatisfiable: deps.unsatisfiable,
          projectActiveClaims: projectActive,
          projectMaxConcurrency: config.maxConcurrency,
          globalActiveClaims: globalActive,
          globalMaxConcurrency: this.deps.globalMaxConcurrency,
          workerSupports: workerSupportsKind(
            options.workerCapabilities,
            work.workKind,
          ),
        });
        if (!eligibility.eligible) {
          continue;
        }
        const waitingAgeMs = Math.max(
          0,
          Date.parse(now) - Date.parse(work.eligibleAt),
        );
        const deadlineProximityMs =
          work.deadlineAt !== undefined
            ? Date.parse(work.deadlineAt) - Date.parse(now)
            : undefined;
        const projectDeficit = getProjectDeficit(fairnessView, work.projectId);
        const priorityContribution = PRIORITY_RANK[work.priorityClass];
        const agingContribution = Math.min(
          400,
          Math.floor(waitingAgeMs / 60_000) * 10,
        );
        const deficitContribution = Math.min(300, projectDeficit);
        const score = computeSchedulingScore({
          priorityClass: work.priorityClass,
          waitingAgeMs,
          projectWeight: config.weight,
          projectDeficit,
          ...(deadlineProximityMs !== undefined ? { deadlineProximityMs } : {}),
        });
        scored.push({
          work,
          score,
          waitingAgeMs,
          priorityContribution,
          agingContribution,
          deficitContribution,
          reason: "SELECTED",
        });
      }
    }

    scored.sort((a, b) =>
      compareCandidates(
        {
          score: a.score,
          workItemId: a.work.workItemId,
          createdAt: a.work.createdAt,
        },
        {
          score: b.score,
          workItemId: b.work.workItemId,
          createdAt: b.work.createdAt,
        },
      ),
    );

    return {
      now,
      scored,
      weights,
      contenderProjectIds,
      globalActive,
      fairnessView,
    };
  }

  private buildSelectionDecision(
    snapshot: SelectionSnapshot,
    opts: {
      serviceCreditPending: boolean;
      decisionId?: string;
      selectedOverride?: ScoredCandidate;
      reasonCode?: SchedulingReasonCode;
      fairnessCharge?: {
        deficitsBefore: Record<string, number>;
        deficitsAfter: Record<string, number>;
        claimOwnerId: string;
        fenceToken: number;
        fairnessRevisionBefore: Record<string, number>;
        fairnessRevisionAfter: Record<string, number>;
      };
    },
  ): SchedulerDecisionRecord {
    const winner = opts.selectedOverride ?? snapshot.scored[0];
    const reasonCode =
      opts.reasonCode ?? (winner ? "SELECTED" : "SKIPPED");
    return {
      decisionId: opts.decisionId ?? `sd_${randomUUID()}`,
      timestamp: snapshot.now,
      candidateWorkIds: snapshot.scored.map((item) => item.work.workItemId),
      selectedWorkId: winner?.work.workItemId ?? null,
      priorityInputs: {
        scores: snapshot.scored.slice(0, 10).map((item) => ({
          workItemId: item.work.workItemId,
          projectId: item.work.projectId,
          priorityClass: item.work.priorityClass,
          priorityContribution: item.priorityContribution,
          agingContribution: item.agingContribution,
          deficitContribution: item.deficitContribution,
          waitingAgeMs: item.waitingAgeMs,
          score: item.score,
        })),
      },
      fairnessInputs: {
        deficitsBefore: opts.fairnessCharge?.deficitsBefore ??
          fairnessSnapshot(snapshot.fairnessView),
        candidateProjects: snapshot.contenderProjectIds,
        selectedProjectId: winner?.work.projectId ?? null,
        weights: Object.fromEntries(snapshot.weights),
        serviceCreditPending: opts.serviceCreditPending,
        ...(opts.fairnessCharge
          ? {
              event: "SERVICE_CREDIT",
              deficitsAfter: opts.fairnessCharge.deficitsAfter,
              claimOwnerId: opts.fairnessCharge.claimOwnerId,
              fenceToken: opts.fairnessCharge.fenceToken,
              fairnessRevisionBefore:
                opts.fairnessCharge.fairnessRevisionBefore,
              fairnessRevisionAfter: opts.fairnessCharge.fairnessRevisionAfter,
            }
          : {}),
      },
      capacityState: {
        globalActive: snapshot.globalActive,
        globalMax: this.deps.globalMaxConcurrency,
      },
      reasonCode,
      ...(winner
        ? {
            score: winner.score,
            workKind: winner.work.workKind,
            priorityClass: winner.work.priorityClass,
            projectId: winner.work.projectId,
          }
        : {}),
    };
  }

  async markRunning(work: SchedulerWorkItem): Promise<SchedulerWorkItem> {
    return this.deps.workItems.updateCas(
      { ...work, status: "RUNNING" },
      work.recordRevision,
    );
  }

  async markSucceeded(
    work: SchedulerWorkItem,
    resultRef?: string,
  ): Promise<SchedulerWorkItem> {
    return this.deps.workItems.updateCas(
      {
        ...work,
        status: "SUCCEEDED",
        ...(resultRef !== undefined ? { resultRef } : {}),
        claimOwnerId: undefined,
        fenceToken: undefined,
        leaseExpiresAt: undefined,
      },
      work.recordRevision,
    );
  }

  async markFailed(
    work: SchedulerWorkItem,
    input: {
      failureClass: string;
      reasonCode: string;
      message: string;
      retryable: boolean;
    },
  ): Promise<SchedulerWorkItem> {
    const exhausted = work.attemptCount >= work.maxAttempts || !input.retryable;
    const nextEligible = new Date(
      Date.parse(this.deps.nowIso()) +
        Math.min(300_000, 1_000 * 2 ** Math.min(8, work.attemptCount)),
    ).toISOString();
    return this.deps.workItems.updateCas(
      {
        ...work,
        status: exhausted ? "FAILED" : "ELIGIBLE",
        eligibleAt: exhausted ? work.eligibleAt : nextEligible,
        failureClass: input.failureClass,
        failureReasonCode: input.reasonCode,
        lastErrorSafeMessage: input.message.slice(0, 2000),
        claimOwnerId: undefined,
        fenceToken: undefined,
        leaseExpiresAt: undefined,
      },
      work.recordRevision,
    );
  }

  async markStale(
    work: SchedulerWorkItem,
    reasonCode: string,
  ): Promise<SchedulerWorkItem> {
    return this.deps.workItems.updateCas(
      {
        ...work,
        status: "CANCELLED",
        failureReasonCode: reasonCode,
        lastErrorSafeMessage: `Stale work: ${reasonCode}`,
        claimOwnerId: undefined,
        fenceToken: undefined,
        leaseExpiresAt: undefined,
      },
      work.recordRevision,
    );
  }

  async setPause(input: {
    scope: "GLOBAL" | "PROJECT";
    projectId?: string;
    paused: boolean;
    principalId: string;
  }): Promise<SchedulerPauseRecord> {
    if (input.scope === "PROJECT" && !input.projectId) {
      throw new SchedulingError(
        "SCHEDULER_CONFIG_INVALID",
        "PROJECT pause requires projectId",
      );
    }
    const existing =
      input.scope === "GLOBAL"
        ? await this.deps.pauses.getGlobal()
        : await this.deps.pauses.getProject(input.projectId!);
    const pause: SchedulerPauseRecord = {
      pauseId:
        existing?.pauseId ??
        (input.scope === "GLOBAL"
          ? "pause_global"
          : `pause_${input.projectId}`),
      scope: input.scope,
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      paused: input.paused,
      updatedAt: this.deps.nowIso(),
      updatedByPrincipalId: input.principalId,
      recordRevision: (existing?.recordRevision ?? 0) + 1,
    };
    return this.deps.pauses.save(pause);
  }

  async upsertProjectConfig(
    input: Partial<SchedulerProjectConfig> & { projectId: string },
  ): Promise<SchedulerProjectConfig> {
    const existing = await this.deps.projectConfigs.getByProjectId(
      input.projectId,
    );
    const config: SchedulerProjectConfig = {
      projectId: input.projectId,
      weight: projectWeightClamp(input.weight ?? existing?.weight ?? 1),
      maxConcurrency: input.maxConcurrency ?? existing?.maxConcurrency ?? 4,
      defaultPriorityClass:
        input.defaultPriorityClass ??
        existing?.defaultPriorityClass ??
        "NORMAL",
      recordRevision: (existing?.recordRevision ?? 0) + 1,
    };
    return this.deps.projectConfigs.save(config);
  }

  async portfolioSnapshot(): Promise<PortfolioSnapshot> {
    const waiting = await this.deps.workItems.listByStatus(["WAITING"], 10_000);
    const eligible = await this.deps.workItems.listByStatus(
      ["ELIGIBLE"],
      10_000,
    );
    const claimed = await this.deps.workItems.listByStatus(["CLAIMED"], 10_000);
    const running = await this.deps.workItems.listByStatus(["RUNNING"], 10_000);
    const blocked = await this.deps.workItems.listByStatus(
      ["BLOCKED_DEPENDENCY"],
      10_000,
    );
    const now = Date.parse(this.deps.nowIso());
    let oldest: number | null = null;
    for (const item of eligible) {
      const age = now - Date.parse(item.eligibleAt);
      if (oldest === null || age > oldest) {
        oldest = age;
      }
    }
    const workByKind: Record<string, number> = {};
    for (const item of [...waiting, ...eligible, ...claimed, ...running]) {
      workByKind[item.workKind] = (workByKind[item.workKind] ?? 0) + 1;
    }
    const globalPause = await this.deps.pauses.getGlobal();
    const active =
      (await this.deps.workItems.countActiveGlobal()) /
      Math.max(1, this.deps.globalMaxConcurrency);
    const projectIds = new Set(
      [...waiting, ...eligible, ...claimed, ...running].map(
        (item) => item.projectId,
      ),
    );
    const runIds = new Set(
      [...waiting, ...eligible, ...claimed, ...running].map((item) => item.runId),
    );
    return {
      capturedAt: this.deps.nowIso(),
      projectsActive: projectIds.size,
      runsActive: runIds.size,
      workWaiting: waiting.length,
      workEligible: eligible.length,
      workClaimed: claimed.length,
      workRunning: running.length,
      workBlockedDependency: blocked.length,
      workByKind,
      oldestEligibleAgeMs: oldest,
      capacityUtilization: active,
      dependencyBlockedCount: blocked.length,
      globalPaused: Boolean(globalPause?.paused),
    };
  }

  async getWorkItem(workItemId: string): Promise<SchedulerWorkItem | null> {
    return this.deps.workItems.getById(workItemId);
  }

  async listWorkForRun(runId: string): Promise<readonly SchedulerWorkItem[]> {
    return this.deps.workItems.listByRun(runId);
  }

  async listWorkForProject(
    projectId: string,
  ): Promise<readonly SchedulerWorkItem[]> {
    return this.deps.workItems.listByProject(projectId);
  }

  async explainWork(workItemId: string) {
    const work = await this.deps.workItems.getById(workItemId);
    if (!work) {
      return null;
    }
    const decisions = await this.deps.decisions.listByWorkItem(workItemId);
    const deps = await this.deps.dependencies.listByDependentRun(work.runId);
    return {
      work,
      dependencies: deps,
      decisions,
    };
  }

  private async configFor(projectId: string): Promise<SchedulerProjectConfig> {
    const existing =
      await this.deps.projectConfigs.getByProjectId(projectId);
    if (existing) {
      return existing;
    }
    return {
      projectId,
      weight: 1,
      maxConcurrency: 4,
      defaultPriorityClass: "NORMAL",
      recordRevision: 1,
    };
  }

  private async buildDiscoveryContext(run: RunRecord): Promise<DiscoveryContext> {
    const [
      hasVerifiedRepository,
      hasPlan,
      hasValidationPassOrApprovalRequired,
      hasAuthorizationRecord,
      hasExecutionTerminalForVerification,
      completion,
      hasLearned,
      hasObservabilitySnapshot,
    ] = await Promise.all([
      this.deps.artifacts.hasVerifiedRepository(run.runId),
      this.deps.artifacts.hasPlan(run.runId),
      this.deps.artifacts.hasValidationPassOrApprovalRequired(run.runId),
      this.deps.artifacts
        .authorizationRecordId(run.runId)
        .then((id) => Boolean(id)),
      this.deps.artifacts.hasExecutionTerminalForVerification(run.runId),
      this.deps.artifacts.completionRecord(run.runId),
      this.deps.artifacts.hasLearned(run.runId),
      this.deps.artifacts.hasObservabilitySnapshot(run.projectId),
    ]);
    return {
      runState: run.state,
      hasVerifiedRepository,
      hasPlan,
      hasValidationPassOrApprovalRequired,
      hasAuthorizationRecord,
      hasExecutionTerminalForVerification,
      hasCompletionRecord: Boolean(completion),
      hasLearned,
      hasObservabilitySnapshot,
    };
  }

  private async fingerprintsFor(
    run: RunRecord,
    workKind: SchedulerWorkKind,
  ): Promise<{
    repositoryFingerprint?: string;
    planVersion?: number;
    planHash?: string;
    authorizationRecordId?: string;
    validationDecisionId?: string;
    executionAttemptId?: string;
    completionRecordId?: string;
    runId: string;
  }> {
    const plan = await this.deps.artifacts.planBinding(run.runId);
    const validationDecisionId =
      await this.deps.artifacts.validationDecisionId(run.runId);
    const authorizationRecordId =
      await this.deps.artifacts.authorizationRecordId(run.runId);
    const executionAttemptId =
      await this.deps.artifacts.executionAttemptId(run.runId);
    const completion = await this.deps.artifacts.completionRecord(run.runId);
    return {
      runId: run.runId,
      ...(plan
        ? {
            repositoryFingerprint: plan.repositoryFingerprint,
            planVersion: plan.planVersion,
            planHash: plan.planHash,
          }
        : {}),
      ...(validationDecisionId ? { validationDecisionId } : {}),
      ...(authorizationRecordId ? { authorizationRecordId } : {}),
      ...(executionAttemptId ? { executionAttemptId } : {}),
      ...(completion
        ? { completionRecordId: completion.completionRecordId }
        : {}),
    };
  }

  private async milestoneSatisfied(
    dep: CrossRunDependency,
  ): Promise<"SATISFIED" | "PENDING" | "UNSATISFIABLE"> {
    const run = await this.deps.runs.getById(dep.prerequisiteRunId);
    if (!run) {
      return "UNSATISFIABLE";
    }
    switch (dep.requiredMilestone) {
      case "REPOSITORY_VERIFIED":
        return (await this.deps.artifacts.hasVerifiedRepository(run.runId))
          ? "SATISFIED"
          : run.state === "FAILED" ||
              run.state === "CANCELLED" ||
              run.state === "REJECTED" ||
              run.state === "CONTAINED"
            ? "UNSATISFIABLE"
            : "PENDING";
      case "PLAN_VALIDATED":
        return (await this.deps.artifacts.hasValidationPassOrApprovalRequired(
          run.runId,
        ))
          ? "SATISFIED"
          : run.state === "FAILED" ||
              run.state === "CANCELLED" ||
              run.state === "REJECTED"
            ? "UNSATISFIABLE"
            : "PENDING";
      case "APPROVED":
        return run.state === "APPROVED" ||
          run.state === "EXECUTING" ||
          run.state === "VERIFYING" ||
          run.state === "COMPLETED"
          ? "SATISFIED"
          : run.state === "REJECTED" ||
              run.state === "CANCELLED" ||
              run.state === "FAILED" ||
              run.state === "CONTAINED"
            ? "UNSATISFIABLE"
            : "PENDING";
      case "COMPLETED": {
        // CRITICAL: COMPLETED without CompletionRecord does NOT satisfy.
        if (run.state !== "COMPLETED") {
          return run.state === "FAILED" ||
            run.state === "CANCELLED" ||
            run.state === "REJECTED" ||
            run.state === "CONTAINED"
            ? "UNSATISFIABLE"
            : "PENDING";
        }
        const completion = await this.deps.artifacts.completionRecord(run.runId);
        return completion ? "SATISFIED" : "PENDING";
      }
      default: {
        const _exhaustive: never = dep.requiredMilestone;
        return _exhaustive;
      }
    }
  }
}

export function admitPriorityFromRequest(
  raw: string | undefined,
): PriorityClass {
  return parsePriorityClass(raw);
}
