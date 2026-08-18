import type {
  RunTelemetryRecord,
  PhaseTelemetryRecord,
  ObservabilityPhase,
  MeasurementQuality,
  TelemetryQualityFinding,
} from "../domain/observability/index.js";
import {
  trustClassForMeasurementQuality,
  combineMeasurementQuality,
} from "../domain/observability/quality.js";
import type { HistoricalOutcome } from "../domain/memory/historical-run.js";
import { isTerminalRunState } from "../domain/run/run-state.js";
import type { TelemetrySources } from "./sources.js";
import {
  RunTelemetryHasher,
  PhaseTelemetryHasher,
} from "./hasher.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";
import { ObservabilityError } from "./errors.js";
import { aggregatePlanningUsage } from "../planning/model.js";
import { aggregateValidationUsage } from "../validation/model.js";

function msBetween(start?: string, end?: string): number | undefined {
  if (!start || !end) return undefined;
  const a = Date.parse(start);
  const b = Date.parse(end);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return undefined;
  return b - a;
}

function mapRunStateToOutcome(
  state: string,
  verificationOutcome?: string,
): HistoricalOutcome | "UNKNOWN" {
  if (verificationOutcome) {
    const known = [
      "VERIFIED_SUCCESS",
      "PARTIAL_SUCCESS",
      "VERIFICATION_FAILED",
      "INCONCLUSIVE",
    ] as const;
    if ((known as readonly string[]).includes(verificationOutcome)) {
      return verificationOutcome as HistoricalOutcome;
    }
  }
  switch (state) {
    case "COMPLETED":
      return "VERIFIED_SUCCESS";
    case "CONTAINED":
      return "CONTAINED";
    case "BLOCKED":
      return "BLOCKED";
    case "REJECTED":
      return "REJECTED";
    case "EXPIRED":
      return "EXPIRED";
    case "ESCALATED":
      return "ESCALATED";
    default:
      return "UNKNOWN";
  }
}

function inferFailurePhase(state: string): ObservabilityPhase | undefined {
  if (state === "ADMISSION_REJECTED") return "ADMISSION";
  if (state === "FAILED" || state === "BLOCKED") return "EXECUTION";
  if (state === "REJECTED" || state === "EXPIRED") return "AUTHORIZATION";
  if (state === "CONTAINED") return "EXECUTION";
  return undefined;
}

function durationQuality(
  startQuality?: MeasurementQuality,
  endQuality?: MeasurementQuality,
): MeasurementQuality {
  if (!startQuality || !endQuality) return "UNKNOWN";
  return combineMeasurementQuality([startQuality, endQuality]);
}

function mayComputeDuration(quality: MeasurementQuality): boolean {
  return quality === "EXACT" || quality === "RECONSTRUCTED";
}

export class TelemetryNormalizationService {
  private readonly runHasher = new RunTelemetryHasher();
  private readonly phaseHasher = new PhaseTelemetryHasher();

  constructor(
    private readonly sources: TelemetrySources,
    _identities?: SequenceObservabilityIdentityGenerator,
  ) {
    void _identities;
  }

  async normalizeRun(runId: string, nowIso: string): Promise<{
    runTelemetry: RunTelemetryRecord;
    phaseTelemetry: PhaseTelemetryRecord[];
    qualityFindings: TelemetryQualityFinding[];
  }> {
    const run = await this.sources.runs.getById(runId);
    if (!run) {
      throw new ObservabilityError("RUN_NOT_FOUND", `Run not found: ${runId}`);
    }

    const historical = await this.sources.historicalRuns.getByRunId(runId);
    const plans = await this.sources.plans.listByRunId(runId);
    const validationDecisions =
      await this.sources.validationDecisions.listByRunId(runId);
    const approvalRequests =
      await this.sources.approvalRequests.listByRun(runId);
    const authRecords =
      await this.sources.authorizationRecords.listByRun(runId);
    const attempts = await this.sources.executionAttempts.listByRun(runId);
    const steps: Array<
      Awaited<
        ReturnType<typeof this.sources.stepExecutions.listByExecutionAttempt>
      >[number]
    > = [];
    for (const attempt of attempts) {
      steps.push(
        ...(await this.sources.stepExecutions.listByExecutionAttempt(
          attempt.executionAttemptId,
        )),
      );
    }
    const outcomes =
      await this.sources.outcomeVerifications.listByRun(runId);
    const completion =
      await this.sources.completionRecords.getByRun(runId);
    const completions = completion ? [completion] : [];
    const planningUsage =
      await this.sources.planningUsage.listByRunId(runId);
    const validationUsage =
      await this.sources.validationUsage.listByRunId(runId);
    const verificationInference =
      await this.sources.verificationInference.listByRun(runId);
    const learningInference =
      await this.sources.learningInference.listByRun(runId);
    const learningEvents = await this.sources.learningLedger.listByRun(runId);

    const planningFence = await this.sources.planningCoordinator.get(runId);
    const ingestionFence = await this.sources.ingestionCoordinator.get(runId);
    const validationFences =
      await this.sources.validationCoordinator.listByRunId(runId);
    const lastPlan = plans[plans.length - 1];
    const lastAuth = authRecords[authRecords.length - 1];
    const executionFence =
      lastPlan && lastAuth
        ? await this.sources.executionCoordinator.get({
            runId,
            planId: lastPlan.planId,
            planVersion: lastPlan.planVersion,
            planHash: lastPlan.planHash,
            authorizationRecordId: lastAuth.authorizationRecordId,
          })
        : null;

    const latestOutcome = outcomes[outcomes.length - 1];
    const terminalOutcome =
      historical?.outcome ??
      mapRunStateToOutcome(
        run.state,
        latestOutcome?.outcome,
      );

    const startedAt = historical?.startedAt ?? run.createdAt;
    const finishedAt =
      historical?.finishedAt ??
      (isTerminalRunState(run.state) ? run.updatedAt : undefined);

    const planningAgg = aggregatePlanningUsage(planningUsage);
    const validationAgg = aggregateValidationUsage(validationUsage);

    let verificationTokens = 0;
    let verificationCalls = 0;
    for (const record of verificationInference) {
      if (record.status === "SETTLED" || record.status === "AMBIGUOUS_CHARGED") {
        verificationCalls += 1;
        verificationTokens += record.totalTokens;
      }
    }

    let learningTokens = 0;
    let learningCalls = 0;
    for (const record of learningInference) {
      if (record.status === "SETTLED" || record.status === "AMBIGUOUS_CHARGED") {
        learningCalls += 1;
        learningTokens += record.totalTokens;
      }
    }

    const approvalWaitMs = (() => {
      const request = approvalRequests.find((a) => a.status !== "PENDING")
        ?? approvalRequests[0];
      const auth = authRecords[0];
      if (request && auth) {
        return msBetween(request.createdAt, auth.decisionTimestamp);
      }
      return undefined;
    })();
    const approvalWaitQuality: MeasurementQuality =
      approvalWaitMs !== undefined ? "EXACT" : "UNKNOWN";

    const rollbackCount = steps.filter((s) => s.status === "COMPENSATED").length;
    const containmentOccurred =
      run.state === "CONTAINED" ||
      attempts.some((a) => a.status === "CONTAINED");

    const runTelemetryId = `run-tel:${runId}`;
    const sourceRecordRefs: string[] = [
      `run:${run.runId}`,
      ...(historical ? [`historical:${historical.historicalRunRecordId}`] : []),
    ];

    const qualityFindings: TelemetryQualityFinding[] = [];
    const phaseTelemetry: PhaseTelemetryRecord[] = [];

    const admissionStarted = run.createdAt;
    const admissionFinished = run.admittedAt;
    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "ADMISSION",
        startedAt: admissionStarted,
        startedAtQuality: "EXACT",
        ...(admissionFinished !== undefined
          ? { finishedAt: admissionFinished, finishedAtQuality: "EXACT" as const }
          : {}),
        status: run.admittedAt ? "COMPLETED" : run.state,
        errorCodes: run.failureReasonCode ? [run.failureReasonCode] : [],
        resourceQuality: "EXACT",
      }),
    );

    const ingestionStartExact = undefined as string | undefined;
    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "INGESTION",
        ...(ingestionStartExact !== undefined
          ? { startedAt: ingestionStartExact, startedAtQuality: "EXACT" as const }
          : {}),
        ...(ingestionFence?.verifiedAt !== undefined
          ? {
              finishedAt: ingestionFence.verifiedAt,
              finishedAtQuality: "EXACT" as const,
            }
          : {}),
        attemptCount: ingestionFence?.attempt ?? 0,
        status: ingestionFence?.status ?? "UNKNOWN",
        errorCodes: ingestionFence?.failureCode
          ? [ingestionFence.failureCode]
          : [],
        resourceQuality: "UNKNOWN",
      }),
    );
    if (!ingestionStartExact) {
      qualityFindings.push({
        findingId: `qual:${runId}:INGESTION:start`,
        projectId: run.projectId,
        reason: "MISSING_EXACT_PHASE_START",
        phase: "INGESTION",
        runId,
        explanation:
          "Ingestion fence lastUpdatedAt is a proxy and is not used as phase start",
      });
    }

    const planningStartedAt = planningUsage[0]?.startedAt;
    const planningFinishedAt =
      planningFence?.plannedAt ?? planningUsage.at(-1)?.completedAt;
    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "PLANNING",
        ...(planningStartedAt !== undefined
          ? { startedAt: planningStartedAt, startedAtQuality: "EXACT" as const }
          : {}),
        ...(planningFinishedAt !== undefined
          ? {
              finishedAt: planningFinishedAt,
              finishedAtQuality: planningFence?.plannedAt
                ? ("EXACT" as const)
                : ("EXACT" as const),
            }
          : {}),
        attemptCount: planningFence?.attempt ?? plans.length,
        retryCount: Math.max(0, (planningFence?.attempt ?? 1) - 1),
        modelCallCount: planningAgg.llmCalls,
        inputTokens: planningAgg.inputTokens,
        outputTokens: planningAgg.outputTokens,
        totalTokens: planningAgg.totalTokens,
        status: planningFence?.status ?? "UNKNOWN",
        errorCodes: planningFence?.failureCode
          ? [planningFence.failureCode]
          : [],
        resourceQuality: "EXACT",
      }),
    );

    const revisionCount = validationDecisions.filter(
      (d) => d.decision === "REVISE",
    ).length;
    const validationStartedAt = validationUsage[0]?.startedAt;
    const validationFinishedAt =
      validationFences.at(-1)?.decidedAt ??
      validationDecisions.at(-1)?.decidedAt;
    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "VALIDATION",
        ...(validationStartedAt !== undefined
          ? { startedAt: validationStartedAt, startedAtQuality: "EXACT" as const }
          : {}),
        ...(validationFinishedAt !== undefined
          ? {
              finishedAt: validationFinishedAt,
              finishedAtQuality: "EXACT" as const,
            }
          : {}),
        attemptCount: validationDecisions.length,
        retryCount: revisionCount,
        modelCallCount: validationAgg.llmCalls,
        inputTokens: validationAgg.inputTokens,
        outputTokens: validationAgg.outputTokens,
        totalTokens: validationAgg.totalTokens,
        status: validationFences.at(-1)?.status ?? "UNKNOWN",
        errorCodes: validationDecisions
          .flatMap((d) => d.findings.map((f) => f.ruleId))
          .slice(0, 20),
        resourceQuality: "EXACT",
      }),
    );
    if (!validationStartedAt) {
      qualityFindings.push({
        findingId: `qual:${runId}:VALIDATION:start`,
        projectId: run.projectId,
        reason: "MISSING_EXACT_PHASE_START",
        phase: "VALIDATION",
        runId,
        explanation:
          "Validation fence lastUpdatedAt is a proxy and is not used as phase start",
      });
    }

    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "AUTHORIZATION",
        ...(approvalRequests[0]?.createdAt !== undefined
          ? {
              startedAt: approvalRequests[0].createdAt,
              startedAtQuality: "EXACT" as const,
            }
          : {}),
        ...(authRecords[0]?.decisionTimestamp !== undefined
          ? {
              finishedAt: authRecords[0].decisionTimestamp,
              finishedAtQuality: "EXACT" as const,
            }
          : {}),
        attemptCount: approvalRequests.length,
        status: approvalRequests.at(-1)?.status ?? "UNKNOWN",
        errorCodes: [
          ...(approvalRequests
            .map((a) => a.failureReasonCode)
            .filter(Boolean) as string[]),
          ...(approvalRequests
            .map((a) => a.deliveryFailureCode)
            .filter(Boolean) as string[]),
        ],
        resourceConsumption:
          approvalWaitMs !== undefined ? { approvalWaitMs } : {},
        resourceQuality: approvalWaitQuality,
      }),
    );

    let execMinutes = 0;
    let attemptsWithBounds = 0;
    for (const attempt of attempts) {
      const dur = msBetween(attempt.startedAt, attempt.completedAt);
      if (dur !== undefined) {
        execMinutes += dur / 60_000;
        attemptsWithBounds += 1;
      }
    }
    const executionResourceQuality: MeasurementQuality =
      attempts.length === 0
        ? "UNKNOWN"
        : attemptsWithBounds === attempts.length
          ? "PARTIAL"
          : "PARTIAL";
    const executionFinishedAt = attempts.at(-1)?.completedAt;
    const executionStartedAt = attempts[0]?.startedAt;
    const executionDurationQuality =
      attempts.length === 1 &&
      executionStartedAt !== undefined &&
      executionFinishedAt !== undefined
        ? "EXACT"
        : executionStartedAt !== undefined && executionFinishedAt !== undefined
          ? "RECONSTRUCTED"
          : "UNKNOWN";

    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "EXECUTION",
        ...(executionStartedAt !== undefined
          ? { startedAt: executionStartedAt, startedAtQuality: "EXACT" as const }
          : {}),
        ...(executionFinishedAt !== undefined
          ? {
              finishedAt: executionFinishedAt,
              finishedAtQuality: "EXACT" as const,
            }
          : {}),
        durationQualityOverride: executionDurationQuality,
        attemptCount: attempts.length,
        status: executionFence?.status ?? attempts.at(-1)?.status ?? "UNKNOWN",
        errorCodes: steps
          .map((s) => s.errorCode)
          .filter((c): c is string => Boolean(c)),
        resourceConsumption: { executionMinutes: execMinutes },
        resourceQuality: executionResourceQuality,
      }),
    );
    qualityFindings.push({
      findingId: `qual:${runId}:EXECUTION:resources`,
      projectId: run.projectId,
      reason: "PARTIAL_RESOURCE_LEDGER",
      phase: "EXECUTION",
      runId,
      explanation:
        "Execution resources reconstructed from attempt/step records; no durable ExecutionResourceLedger",
    });

    const verificationStartedAt = verificationInference[0]?.createdAt;
    const lastSettled = [...verificationInference]
      .reverse()
      .find((r) => r.settledAt !== undefined);
    const verificationFinishedAt =
      lastSettled?.settledAt ?? completions.at(-1)?.completedAt;
    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "VERIFICATION",
        ...(verificationStartedAt !== undefined
          ? {
              startedAt: verificationStartedAt,
              startedAtQuality: "EXACT" as const,
            }
          : {}),
        ...(verificationFinishedAt !== undefined
          ? {
              finishedAt: verificationFinishedAt,
              finishedAtQuality: lastSettled?.settledAt
                ? ("EXACT" as const)
                : ("RECONSTRUCTED" as const),
            }
          : {}),
        attemptCount: outcomes.length,
        modelCallCount: verificationCalls,
        totalTokens: verificationTokens,
        status: latestOutcome?.outcome ?? "UNKNOWN",
        errorCodes: (latestOutcome?.findings ?? []).map((f) => f.findingId),
        resourceQuality: "EXACT",
      }),
    );

    const learningStartedAt = learningInference[0]?.createdAt;
    const lastLearningSettled = [...learningInference]
      .reverse()
      .find((r) => r.settledAt !== undefined);
    const learningFinishedAt = lastLearningSettled?.settledAt;
    phaseTelemetry.push(
      await this.buildPhaseRecord({
        runId,
        projectId: run.projectId,
        phase: "LEARNING",
        ...(learningStartedAt !== undefined
          ? { startedAt: learningStartedAt, startedAtQuality: "EXACT" as const }
          : {}),
        ...(learningFinishedAt !== undefined
          ? {
              finishedAt: learningFinishedAt,
              finishedAtQuality: "EXACT" as const,
            }
          : {}),
        attemptCount: learningEvents.length,
        modelCallCount: learningCalls,
        totalTokens: learningTokens,
        status: learningEvents.length > 0 ? "PROCESSED" : "SKIPPED",
        errorCodes: [],
        resourceQuality: "EXACT",
      }),
    );

    const phaseDurations = phaseTelemetry.map((p) => ({
      phase: p.phase,
      durationMs: p.durationMs,
      unknown: p.durationMs === undefined,
      measurementQuality: p.durationQuality,
      sourceRecordRefs: [],
    }));

    const historicalExactBounds = Boolean(
      historical?.startedAt && historical?.finishedAt,
    );
    const totalDurationQuality: MeasurementQuality = historicalExactBounds
      ? "EXACT"
      : isTerminalRunState(run.state) && run.createdAt && run.updatedAt
        ? "RECONSTRUCTED"
        : "UNKNOWN";
    const totalDurationMs = mayComputeDuration(totalDurationQuality)
      ? msBetween(startedAt, finishedAt)
      : undefined;

    const partial: Omit<RunTelemetryRecord, "telemetryHash" | "createdAt"> = {
      runTelemetryId,
      runId,
      projectId: run.projectId,
      objectiveId: run.objectiveId,
      terminalState: run.state,
      terminalOutcome,
      startedAt,
      finishedAt,
      totalDurationMs,
      totalDurationQuality,
      phaseDurations,
      planningRevisionCount: Math.max(0, plans.length - 1),
      validationAttemptCount: validationDecisions.length,
      approvalWaitMs,
      approvalWaitQuality,
      executionAttemptCount: attempts.length,
      rollbackCount,
      containmentOccurred,
      verificationAttemptCount: outcomes.length,
      learningProcessed: learningEvents.length > 0,
      resourceSummary: [
        {
          category: "PLANNING",
          modelCallCount: planningAgg.llmCalls,
          inputTokens: planningAgg.inputTokens,
          outputTokens: planningAgg.outputTokens,
          totalTokens: planningAgg.totalTokens,
          executionMinutes: 0,
          apiCallCount: 0,
          measurementQuality: "EXACT",
          usageCompleteness: "COMPLETE",
        },
        {
          category: "VALIDATION",
          modelCallCount: validationAgg.llmCalls,
          inputTokens: validationAgg.inputTokens,
          outputTokens: validationAgg.outputTokens,
          totalTokens: validationAgg.totalTokens,
          executionMinutes: 0,
          apiCallCount: 0,
          measurementQuality: "EXACT",
          usageCompleteness: "COMPLETE",
        },
        {
          category: "EXECUTION",
          modelCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          executionMinutes: execMinutes,
          apiCallCount: steps.length,
          measurementQuality: "PARTIAL",
          usageCompleteness: "PARTIAL",
        },
      ],
      failureStage: inferFailurePhase(run.state),
      trustClass: "AUTHORITATIVE_DERIVED",
      sourceRecordRefs,
    };

    const runTelemetry: RunTelemetryRecord = {
      ...partial,
      createdAt: nowIso,
      telemetryHash: this.runHasher.hash(partial),
    };

    return { runTelemetry, phaseTelemetry, qualityFindings };
  }

  private async buildPhaseRecord(input: {
    runId: string;
    projectId: string;
    phase: ObservabilityPhase;
    startedAt?: string;
    finishedAt?: string;
    startedAtQuality?: MeasurementQuality;
    finishedAtQuality?: MeasurementQuality;
    durationQualityOverride?: MeasurementQuality;
    attemptCount?: number;
    retryCount?: number;
    modelCallCount?: number;
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    status: string;
    errorCodes: string[];
    resourceConsumption?: Record<string, number>;
    resourceQuality?: MeasurementQuality;
  }): Promise<PhaseTelemetryRecord> {
    const phaseTelemetryId = `phase-tel:${input.runId}:${input.phase}`;
    const startedAtQuality = input.startedAtQuality ?? "UNKNOWN";
    const finishedAtQuality = input.finishedAtQuality ?? "UNKNOWN";
    const computedDurationQuality =
      input.durationQualityOverride ??
      durationQuality(
        input.startedAt !== undefined ? startedAtQuality : undefined,
        input.finishedAt !== undefined ? finishedAtQuality : undefined,
      );
    const durationMs = mayComputeDuration(computedDurationQuality)
      ? msBetween(input.startedAt, input.finishedAt)
      : undefined;
    const resourceQuality = input.resourceQuality ?? "UNKNOWN";
    const partial: Omit<PhaseTelemetryRecord, "phaseTelemetryHash"> = {
      phaseTelemetryId,
      runId: input.runId,
      projectId: input.projectId,
      phase: input.phase,
      attemptCount: input.attemptCount ?? 1,
      retryCount: input.retryCount ?? 0,
      modelCallCount: input.modelCallCount ?? 0,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      totalTokens: input.totalTokens ?? 0,
      status: input.status,
      errorCodes: input.errorCodes,
      resourceConsumption: input.resourceConsumption ?? {},
      startedAtQuality,
      finishedAtQuality,
      durationQuality: computedDurationQuality,
      resourceQuality,
      trustClass: trustClassForMeasurementQuality(
        combineMeasurementQuality([computedDurationQuality, resourceQuality]),
      ),
    };
    if (input.startedAt !== undefined) partial.startedAt = input.startedAt;
    if (input.finishedAt !== undefined) partial.finishedAt = input.finishedAt;
    if (durationMs !== undefined) partial.durationMs = durationMs;

    return {
      ...partial,
      phaseTelemetryHash: this.phaseHasher.hash(partial),
    };
  }
}
