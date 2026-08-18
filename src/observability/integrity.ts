import type { RunTelemetryRecord } from "../domain/observability/telemetry.js";
import type { TelemetrySources } from "./sources.js";
import { ObservabilityError } from "./errors.js";

export class TelemetryIntegrityService {
  verifyRunTelemetry(
    record: RunTelemetryRecord,
    expectedHash?: string,
  ): { ok: true } | { ok: false; code: "TELEMETRY_INTEGRITY_FAILED"; reason: string } {
    if (expectedHash && record.telemetryHash !== expectedHash) {
      return {
        ok: false,
        code: "TELEMETRY_INTEGRITY_FAILED",
        reason: "telemetry hash mismatch",
      };
    }
    if (!record.runId || !record.projectId) {
      return {
        ok: false,
        code: "TELEMETRY_INTEGRITY_FAILED",
        reason: "missing run identity",
      };
    }
    return { ok: true };
  }

  async verifyAgainstSources(
    record: RunTelemetryRecord,
    sources: TelemetrySources,
  ): Promise<void> {
    const run = await sources.runs.getById(record.runId);
    if (!run) {
      throw new ObservabilityError(
        "TELEMETRY_INTEGRITY_FAILED",
        `Source run missing for telemetry ${record.runTelemetryId}`,
      );
    }
    if (run.projectId !== record.projectId) {
      throw new ObservabilityError(
        "TELEMETRY_INTEGRITY_FAILED",
        "Project isolation violation in telemetry",
      );
    }
    if (run.state !== record.terminalState) {
      throw new ObservabilityError(
        "TELEMETRY_INTEGRITY_FAILED",
        "Terminal state mismatch with source run repository",
      );
    }
  }

  reconcileMetric(numerator: number, denominator: number): boolean {
    return numerator <= denominator;
  }
}

export function deriveHealthStatus(input: {
  sloEvaluations: readonly { status: string; sloId: string }[];
  sloDefinitions: readonly { sloId: string; severity: string; enabled?: boolean }[];
  anomalies: readonly { severity: string; status: string }[];
}): "HEALTHY" | "DEGRADED" | "CRITICAL" | "INSUFFICIENT_DATA" {
  const severityBySlo = new Map(
    input.sloDefinitions.map((d) => [d.sloId, d.severity]),
  );
  const criticalFail = input.sloEvaluations.some(
    (e) =>
      e.status === "FAIL" && severityBySlo.get(e.sloId) === "CRITICAL",
  );
  if (criticalFail) return "CRITICAL";

  const enabledCritical = input.sloDefinitions.filter(
    (d) => d.severity === "CRITICAL" && d.enabled !== false,
  );
  const criticalUnevaluable = enabledCritical.some((d) => {
    const evaluation = input.sloEvaluations.find((e) => e.sloId === d.sloId);
    return !evaluation || evaluation.status === "INSUFFICIENT_DATA";
  });
  if (criticalUnevaluable) {
    return "INSUFFICIENT_DATA";
  }

  const evaluated = input.sloEvaluations.filter(
    (e) => e.status !== "INSUFFICIENT_DATA",
  );
  if (evaluated.length === 0) {
    return "INSUFFICIENT_DATA";
  }

  const anyFail = input.sloEvaluations.some((e) => e.status === "FAIL");
  const materialAnomaly = input.anomalies.some(
    (a) =>
      a.status === "OPEN" &&
      (a.severity === "MATERIAL" || a.severity === "CRITICAL"),
  );
  if (anyFail || materialAnomaly) return "DEGRADED";

  const allPass = evaluated.every((e) => e.status === "PASS");
  return allPass ? "HEALTHY" : "INSUFFICIENT_DATA";
}
