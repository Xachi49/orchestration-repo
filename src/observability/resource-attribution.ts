import type {
  ResourceAttributionRecord,
  RunTelemetryRecord,
  PhaseTelemetryRecord,
} from "../domain/observability/index.js";
import { hashCanonical } from "../ingestion/hashing.js";
import { SequenceObservabilityIdentityGenerator } from "./identity.js";

const CATEGORIES = [
  "PLANNING",
  "VALIDATION",
  "SEMANTIC_REVISION",
  "VERIFICATION",
  "LEARNING",
  "EXECUTION",
] as const;

export class ResourceAttributionService {
  constructor(
    private readonly identities = new SequenceObservabilityIdentityGenerator(),
  ) {}

  aggregate(
    projectId: string,
    windowFingerprint: string,
    runRecords: readonly RunTelemetryRecord[],
    phaseRecords: readonly PhaseTelemetryRecord[],
  ): ResourceAttributionRecord[] {
    const sourceRunIds = runRecords.map((r) => r.runId).sort();
    const byCategory = new Map<
      (typeof CATEGORIES)[number],
      ResourceAttributionRecord
    >();

    for (const category of CATEGORIES) {
      byCategory.set(category, {
        attributionId: this.identities.next("res-attr"),
        projectId,
        windowFingerprint,
        category,
        modelCallCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        executionMinutes: 0,
        testRuns: 0,
        artifactBytes: 0,
        apiCallCount: 0,
        approvalWaitMs: 0,
        rollbackCount: 0,
        sourceRunIds,
        measurementQuality: "UNKNOWN",
        usageCompleteness: "UNKNOWN",
        attributionHash: "",
      });
    }

    for (const run of runRecords) {
      for (const summary of run.resourceSummary) {
        const cat = summary.category.toUpperCase();
        const bucket =
          cat === "EXECUTION"
            ? byCategory.get("EXECUTION")
            : cat === "PLANNING"
              ? byCategory.get("PLANNING")
              : cat === "VALIDATION"
                ? byCategory.get("VALIDATION")
                : undefined;
        if (!bucket) continue;
        bucket.modelCallCount += summary.modelCallCount;
        bucket.inputTokens += summary.inputTokens;
        bucket.outputTokens += summary.outputTokens;
        bucket.totalTokens += summary.totalTokens;
        bucket.executionMinutes += summary.executionMinutes;
        bucket.apiCallCount += summary.apiCallCount;
        if (
          summary.measurementQuality === "PARTIAL" ||
          summary.usageCompleteness === "PARTIAL"
        ) {
          bucket.measurementQuality = "PARTIAL";
          bucket.usageCompleteness = "PARTIAL";
        } else if (
          bucket.measurementQuality === "UNKNOWN" &&
          summary.measurementQuality === "EXACT"
        ) {
          bucket.measurementQuality = "EXACT";
          bucket.usageCompleteness = "COMPLETE";
        }
      }
      byCategory.get("EXECUTION")!.rollbackCount += run.rollbackCount;
      if (run.approvalWaitMs !== undefined) {
        byCategory.get("VALIDATION")!.approvalWaitMs += run.approvalWaitMs;
      }
    }

    for (const phase of phaseRecords) {
      const target =
        phase.phase === "PLANNING"
          ? byCategory.get("PLANNING")
          : phase.phase === "VALIDATION"
            ? byCategory.get("VALIDATION")
            : phase.phase === "VERIFICATION"
              ? byCategory.get("VERIFICATION")
              : phase.phase === "LEARNING"
                ? byCategory.get("LEARNING")
                : phase.phase === "EXECUTION"
                  ? byCategory.get("EXECUTION")
                  : undefined;
      if (!target) continue;
      target.modelCallCount += phase.modelCallCount;
      target.inputTokens += phase.inputTokens;
      target.outputTokens += phase.outputTokens;
      target.totalTokens += phase.totalTokens;
      if (phase.resourceConsumption["executionMinutes"]) {
        target.executionMinutes += phase.resourceConsumption["executionMinutes"];
      }
      if (phase.resourceConsumption["approvalWaitMs"]) {
        target.approvalWaitMs += phase.resourceConsumption["approvalWaitMs"];
      }
      if (phase.resourceQuality === "PARTIAL") {
        target.measurementQuality = "PARTIAL";
        target.usageCompleteness = "PARTIAL";
      } else if (
        target.measurementQuality === "UNKNOWN" &&
        phase.resourceQuality === "EXACT"
      ) {
        target.measurementQuality = "EXACT";
        target.usageCompleteness = "COMPLETE";
      }
    }

    return [...byCategory.values()].map((record) => {
      const isExecution = record.category === "EXECUTION";
      const measurementQuality = isExecution
        ? "PARTIAL"
        : record.measurementQuality === "UNKNOWN"
          ? "EXACT"
          : record.measurementQuality;
      const usageCompleteness = isExecution
        ? "PARTIAL"
        : record.usageCompleteness === "UNKNOWN"
          ? "COMPLETE"
          : record.usageCompleteness;
      const complete = {
        ...record,
        measurementQuality,
        usageCompleteness,
        coverage: {
          candidateCount: sourceRunIds.length,
          eligibleCount: isExecution ? 0 : sourceRunIds.length,
          excludedCount: isExecution ? sourceRunIds.length : 0,
          exclusionReasons: isExecution ? ["PARTIAL_RESOURCE_LEDGER"] : [],
        },
      };
      return {
        ...complete,
        attributionHash: hashCanonical({
          attributionId: complete.attributionId,
          projectId: complete.projectId,
          windowFingerprint: complete.windowFingerprint,
          category: complete.category,
          modelCallCount: complete.modelCallCount,
          inputTokens: complete.inputTokens,
          outputTokens: complete.outputTokens,
          totalTokens: complete.totalTokens,
          executionMinutes: complete.executionMinutes,
          sourceRunIds: complete.sourceRunIds,
          measurementQuality: complete.measurementQuality,
          usageCompleteness: complete.usageCompleteness,
        }),
      };
    });
  }
}
