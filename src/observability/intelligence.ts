import type { TelemetrySources } from "./sources.js";
import type { RunTelemetryRecord } from "../domain/observability/telemetry.js";

/** Observational analytics — correlation only, no authority mutation. */

export class CapabilityReliabilityService {
  async analyze(
    sources: TelemetrySources,
    runIds: readonly string[],
  ): Promise<
    Array<{
      capabilityId: string;
      version: string;
      executionCount: number;
      successCount: number;
      failureCount: number;
      containmentCount: number;
      rollbackCount: number;
      timeoutCount: number;
      affectedRunCount: number;
      averageRuntimeMs?: number;
    }>
  > {
    const stats = new Map<
      string,
      {
        capabilityId: string;
        version: string;
        executionCount: number;
        successCount: number;
        failureCount: number;
        containmentCount: number;
        rollbackCount: number;
        timeoutCount: number;
        runIds: Set<string>;
        runtimes: number[];
      }
    >();

    for (const runId of runIds) {
      const attempts = await sources.executionAttempts.listByRun(runId);
      for (const attempt of attempts) {
        const steps = await sources.stepExecutions.listByExecutionAttempt(
          attempt.executionAttemptId,
        );
        for (const step of steps) {
          const key = `${step.capabilityId}:unknown`;
          let bucket = stats.get(key);
          if (!bucket) {
            bucket = {
              capabilityId: step.capabilityId,
              version: "unknown",
              executionCount: 0,
              successCount: 0,
              failureCount: 0,
              containmentCount: 0,
              rollbackCount: 0,
              timeoutCount: 0,
              runIds: new Set<string>(),
              runtimes: [],
            };
            stats.set(key, bucket);
          }
          bucket.executionCount += 1;
          bucket.runIds.add(runId);
          if (step.status === "SUCCEEDED") bucket.successCount += 1;
          if (step.status === "FAILED") bucket.failureCount += 1;
          if (step.status === "CONTAINED") bucket.containmentCount += 1;
          if (step.status === "COMPENSATED") bucket.rollbackCount += 1;
          if (step.errorCode?.includes("TIMEOUT")) bucket.timeoutCount += 1;
          if (step.startedAt && step.completedAt) {
            bucket.runtimes.push(
              Date.parse(step.completedAt) - Date.parse(step.startedAt),
            );
          }
        }
      }
    }

    return [...stats.values()].map((s) => {
      const result: {
        capabilityId: string;
        version: string;
        executionCount: number;
        successCount: number;
        failureCount: number;
        containmentCount: number;
        rollbackCount: number;
        timeoutCount: number;
        affectedRunCount: number;
        averageRuntimeMs?: number;
      } = {
        capabilityId: s.capabilityId,
        version: s.version,
        executionCount: s.executionCount,
        successCount: s.successCount,
        failureCount: s.failureCount,
        containmentCount: s.containmentCount,
        rollbackCount: s.rollbackCount,
        timeoutCount: s.timeoutCount,
        affectedRunCount: s.runIds.size,
      };
      if (s.runtimes.length > 0) {
        result.averageRuntimeMs =
          s.runtimes.reduce((a, b) => a + b, 0) / s.runtimes.length;
      }
      return result;
    });
  }
}

export class ValidationIntelligenceService {
  async summarize(sources: TelemetrySources, runIds: readonly string[]) {
    const ruleFrequency = new Map<string, number>();
    let revise = 0;
    let block = 0;
    let human = 0;
    let tokens = 0;

    for (const runId of runIds) {
      const decisions = await sources.validationDecisions.listByRunId(runId);
      for (const d of decisions) {
        if (d.decision === "REVISE") revise += 1;
        if (d.decision === "BLOCK") block += 1;
        if (d.decision === "HUMAN_APPROVAL_REQUIRED") human += 1;
        for (const f of d.findings) {
          ruleFrequency.set(f.ruleId, (ruleFrequency.get(f.ruleId) ?? 0) + 1);
        }
      }
      const usage = await sources.validationUsage.listByRunId(runId);
      for (const u of usage) {
        tokens += u.totalUsage ?? u.reservedTokens;
      }
    }

    return {
      ruleIdFrequency: Object.fromEntries(ruleFrequency),
      reviseCount: revise,
      blockCount: block,
      humanApprovalRequiredCount: human,
      validationTokenConsumption: tokens,
    };
  }
}

export class VerificationIntelligenceService {
  async summarize(sources: TelemetrySources, runIds: readonly string[]) {
    let inconclusive = 0;
    let evidenceGap = 0;
    let artifactIntegrity = 0;
    const criterionCounts = new Map<string, number>();

    for (const runId of runIds) {
      const records = await sources.outcomeVerifications.listByRun(runId);
      for (const r of records) {
        if (r.outcome === "INCONCLUSIVE") inconclusive += 1;
        for (const f of r.findings) {
          if (f.category === "EVIDENCE_GAP") evidenceGap += 1;
          if (f.category === "ARTIFACT_INTEGRITY") artifactIntegrity += 1;
        }
        for (const c of r.criterionResults) {
          if (c.verdict === "INCONCLUSIVE") {
            criterionCounts.set(
              c.criterionId,
              (criterionCounts.get(c.criterionId) ?? 0) + 1,
            );
          }
        }
      }
    }

    return {
      inconclusiveCount: inconclusive,
      evidenceGapCount: evidenceGap,
      artifactIntegrityFailureCount: artifactIntegrity,
      inconclusiveCriterionFrequency: Object.fromEntries(criterionCounts),
    };
  }
}

export class AuthorizationIntelligenceService {
  async summarize(sources: TelemetrySources, runIds: readonly string[]) {
    let approved = 0;
    let rejected = 0;
    let expired = 0;
    let modification = 0;
    let deliveryFailed = 0;
    const latencies: number[] = [];

    for (const runId of runIds) {
      const requests = await sources.approvalRequests.listByRun(runId);
      const auth = await sources.authorizationRecords.listByRun(runId);
      for (const r of requests) {
        if (r.status === "APPROVED") approved += 1;
        if (r.status === "REJECTED") rejected += 1;
        if (r.status === "EXPIRED") expired += 1;
        if (r.status === "MODIFICATION_REQUESTED") modification += 1;
        if (r.deliveryFailureCode) deliveryFailed += 1;
      }
      if (requests[0] && auth[0]) {
        latencies.push(
          Date.parse(auth[0].decisionTimestamp) -
            Date.parse(requests[0].createdAt),
        );
      }
    }

    return {
      approvalCount: approved,
      rejectionCount: rejected,
      expiryCount: expired,
      modificationRequestCount: modification,
      deliveryFailureCount: deliveryFailed,
      meanApprovalLatencyMs:
        latencies.length > 0
          ? latencies.reduce((a, b) => a + b, 0) / latencies.length
          : undefined,
      sampleCount: latencies.length,
    };
  }
}

export class PlanningIntelligenceService {
  async summarize(sources: TelemetrySources, runIds: readonly string[]) {
    let revisionFrequency = 0;
    let compileFailures = 0;
    let precedentRetrievals = 0;
    let planningTokens = 0;

    for (const runId of runIds) {
      const plans = await sources.plans.listByRunId(runId);
      revisionFrequency += Math.max(0, plans.length - 1);
      const usage = await sources.planningUsage.listByRunId(runId);
      for (const u of usage) {
        planningTokens += u.totalUsage ?? u.reservedTokens;
      }
      const learningEvents = await sources.learningLedger.listByRun(runId);
      precedentRetrievals += learningEvents.filter(
        (e) => e.eventType === "PRECEDENT_RETRIEVED",
      ).length;
      const fence = await sources.planningCoordinator.get(runId);
      if (fence?.failureCode?.includes("COMPILE")) compileFailures += 1;
    }

    return {
      revisionFrequency,
      compileFailureCount: compileFailures,
      precedentRetrievalCount: precedentRetrievals,
      planningTokenConsumption: planningTokens,
    };
  }
}

export class PrecedentEffectivenessService {
  async observe(sources: TelemetrySources, projectId: string) {
    const precedents = await sources.promotedPrecedents.listByProject(projectId);
    const results: Array<{
      precedentId: string;
      retrievalCount: number;
      runsInfluenced: number;
      verifiedSuccessCount: number;
      partialSuccessCount: number;
      failureCount: number;
      inconclusiveCount: number;
      containmentCount: number;
      correlationDisclaimer: string;
    }> = [];

    for (const precedent of precedents) {
      const events = (await sources.learningLedger.listByProject(projectId)).filter(
        (e) =>
          e.eventType === "PRECEDENT_RETRIEVED" &&
          e.precedentId === precedent.precedentId,
      );
      const runIds = new Set(
        events.map((e) => e.runId).filter(Boolean) as string[],
      );
      let verifiedSuccess = 0;
      let partial = 0;
      let failure = 0;
      let inconclusive = 0;
      let containment = 0;

      for (const runId of runIds) {
        const hist = await sources.historicalRuns.getByRunId(runId);
        if (!hist) continue;
        if (hist.outcome === "VERIFIED_SUCCESS") verifiedSuccess += 1;
        else if (hist.outcome === "PARTIAL_SUCCESS") partial += 1;
        else if (hist.outcome === "VERIFICATION_FAILED") failure += 1;
        else if (hist.outcome === "INCONCLUSIVE") inconclusive += 1;
        else if (hist.outcome === "CONTAINED") containment += 1;
      }

      results.push({
        precedentId: precedent.precedentId,
        retrievalCount: events.length,
        runsInfluenced: runIds.size,
        verifiedSuccessCount: verifiedSuccess,
        partialSuccessCount: partial,
        failureCount: failure,
        inconclusiveCount: inconclusive,
        containmentCount: containment,
        correlationDisclaimer: "CORRELATION != CAUSATION",
      });
    }

    return results;
  }
}

export class IntelligenceAggregator {
  constructor(
    readonly capability = new CapabilityReliabilityService(),
    readonly validation = new ValidationIntelligenceService(),
    readonly verification = new VerificationIntelligenceService(),
    readonly authorization = new AuthorizationIntelligenceService(),
    readonly planning = new PlanningIntelligenceService(),
    readonly precedent = new PrecedentEffectivenessService(),
  ) {}
}

export function assertNoSensitiveTelemetryPayload(
  record: RunTelemetryRecord,
): void {
  const serialized = JSON.stringify(record);
  if (serialized.includes("decisionNonce")) {
    throw new Error("data minimization violation: nonce leaked");
  }
  if (serialized.length > 50_000) {
    throw new Error("data minimization violation: unbounded telemetry payload");
  }
}
