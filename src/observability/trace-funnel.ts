import type { RunTrace, RunFunnelReport, RunFunnelStage } from "../domain/observability/health.js";
import type { TelemetrySources } from "./sources.js";
import { RunTraceHasher, RunFunnelHasher } from "./hasher.js";
import { ObservabilityError } from "./errors.js";

export class RunTraceService {
  private readonly hasher = new RunTraceHasher();

  constructor(private readonly sources: TelemetrySources) {}

  async trace(runId: string): Promise<RunTrace> {
    const run = await this.sources.runs.getById(runId);
    if (!run) {
      throw new ObservabilityError("RUN_NOT_FOUND", `Run not found: ${runId}`);
    }

    const plans = await this.sources.plans.listByRunId(runId);
    const validation = await this.sources.validationDecisions.getLatestByRunId(runId);
    const approval = (await this.sources.approvalRequests.listByRun(runId)).at(-1);
    const auth = (await this.sources.authorizationRecords.listByRun(runId)).at(-1);
    const attempt = (await this.sources.executionAttempts.listByRun(runId)).at(-1);
    const outcome = await this.sources.outcomeVerifications.getLatestByRun(runId);
    const completion = await this.sources.completionRecords.getByRun(runId);
    const historical = await this.sources.historicalRuns.getByRunId(runId);
    const learning = await this.sources.learningLedger.listByRun(runId);

    const stages = [
      {
        phase: "ADMISSION",
        reached: Boolean(run.admittedAt),
        recordId: run.runId,
        status: run.state,
        timestamp: run.admittedAt ?? run.createdAt,
      },
      {
        phase: "INGESTION",
        reached: plans.length > 0,
        timestamp: undefined as string | undefined,
      },
      {
        phase: "PLANNING",
        reached: plans.length > 0,
        recordId: plans.at(-1)?.planId,
        recordHash: plans.at(-1)?.planHash,
        status: plans.length > 0 ? "PLANNED" : undefined,
      },
      {
        phase: "VALIDATION",
        reached: Boolean(validation),
        recordId: validation?.validationDecisionId,
        status: validation?.decision,
        timestamp: validation?.decidedAt,
      },
      {
        phase: "AUTHORIZATION",
        reached: Boolean(auth),
        recordId: auth?.authorizationRecordId,
        status: approval?.status,
        timestamp: auth?.decisionTimestamp,
      },
      {
        phase: "EXECUTION",
        reached: Boolean(attempt),
        recordId: attempt?.executionAttemptId,
        status: attempt?.status,
        timestamp: attempt?.completedAt ?? attempt?.startedAt,
      },
      {
        phase: "VERIFICATION",
        reached: Boolean(outcome),
        recordId: outcome?.outcomeVerificationId,
        status: outcome?.outcome,
        timestamp: outcome?.createdAt,
      },
      {
        phase: "COMPLETION",
        reached: Boolean(completion),
        recordId: completion?.completionRecordId,
        timestamp: completion?.completedAt,
      },
      {
        phase: "LEARNING",
        reached: learning.length > 0 || Boolean(historical),
        recordId: historical?.historicalRunRecordId,
        timestamp: learning.at(-1)?.createdAt,
      },
    ];

    const partial = {
      runId,
      projectId: run.projectId,
      correlationId: run.correlationId,
      traceId: run.traceId,
      terminalState: run.state,
      stages,
    };
    return {
      ...partial,
      traceHash: this.hasher.hash(partial),
    };
  }
}

export class RunFunnelService {
  private readonly hasher = new RunFunnelHasher();

  constructor(private readonly sources: TelemetrySources) {}

  async report(
    projectId: string,
    windowFingerprint: string,
    runIds: readonly string[],
  ): Promise<RunFunnelReport> {
    const stageCounts: Record<RunFunnelStage, number> = {
      ADMITTED: 0,
      INGESTED: 0,
      PLANNED: 0,
      VALIDATED: 0,
      AWAITING_APPROVAL: 0,
      APPROVED: 0,
      EXECUTED: 0,
      VERIFIED_SUCCESS: 0,
      COMPLETED: 0,
      LEARNED: 0,
    };
    const dropOffByPhase: Record<string, number> = {};

    for (const runId of runIds) {
      const run = await this.sources.runs.getById(runId);
      if (!run || run.projectId !== projectId) continue;

      if (run.admittedAt) stageCounts.ADMITTED += 1;
      else {
        dropOffByPhase["ADMISSION"] = (dropOffByPhase["ADMISSION"] ?? 0) + 1;
        continue;
      }

      const plans = await this.sources.plans.listByRunId(runId);
      if (plans.length > 0) {
        stageCounts.INGESTED += 1;
        stageCounts.PLANNED += 1;
      } else {
        dropOffByPhase["INGESTION"] = (dropOffByPhase["INGESTION"] ?? 0) + 1;
        continue;
      }

      const validation =
        await this.sources.validationDecisions.getLatestByRunId(runId);
      if (validation) stageCounts.VALIDATED += 1;
      else {
        dropOffByPhase["PLANNING"] = (dropOffByPhase["PLANNING"] ?? 0) + 1;
        continue;
      }

      const approvals = await this.sources.approvalRequests.listByRun(runId);
      if (approvals.some((a) => a.status === "PENDING")) {
        stageCounts.AWAITING_APPROVAL += 1;
      }

      const auth = await this.sources.authorizationRecords.listByRun(runId);
      if (auth.length > 0) stageCounts.APPROVED += 1;
      else if (run.state === "REJECTED" || run.state === "EXPIRED") {
        dropOffByPhase["AUTHORIZATION"] =
          (dropOffByPhase["AUTHORIZATION"] ?? 0) + 1;
        continue;
      }

      const attempts = await this.sources.executionAttempts.listByRun(runId);
      if (attempts.length > 0) stageCounts.EXECUTED += 1;
      else if (run.state === "FAILED" || run.state === "CONTAINED") {
        dropOffByPhase["EXECUTION"] = (dropOffByPhase["EXECUTION"] ?? 0) + 1;
        continue;
      }

      const outcome =
        await this.sources.outcomeVerifications.getLatestByRun(runId);
      if (outcome?.outcome === "VERIFIED_SUCCESS") {
        stageCounts.VERIFIED_SUCCESS += 1;
      }

      const completion = await this.sources.completionRecords.getByRun(runId);
      if (completion) stageCounts.COMPLETED += 1;

      const learning = await this.sources.learningLedger.listByRun(runId);
      if (learning.length > 0) stageCounts.LEARNED += 1;
    }

    const partial = {
      projectId,
      windowFingerprint,
      stageCounts,
      dropOffByPhase,
    };
    return {
      ...partial,
      funnelHash: this.hasher.hash(partial),
    };
  }
}
