import { isTerminalRunState } from "../domain/run/run-state.js";
import type { MetricWindow, MetricWindowKind } from "../domain/observability/window.js";
import { windowFingerprint } from "./hasher.js";
import type { RunRepository } from "../admission/run-repository.js";
import type { HistoricalRunRepository } from "../memory/historical-run-repository.js";
import { ObservabilityError } from "./errors.js";

export interface BuildWindowRequest {
  projectId: string;
  kind: MetricWindowKind;
  lastN?: number;
  startAt?: string;
  endAt?: string;
}

export async function buildMetricWindow(
  runs: RunRepository,
  historicalRuns: HistoricalRunRepository,
  request: BuildWindowRequest,
): Promise<MetricWindow> {
  const allRuns = await runs.listByProject(request.projectId);
  const terminalRuns = allRuns.filter((r) => isTerminalRunState(r.state));

  let included = terminalRuns;
  if (request.kind === "TIME_RANGE") {
    if (!request.startAt || !request.endAt) {
      throw new ObservabilityError(
        "INVALID_WINDOW",
        "TIME_RANGE requires startAt and endAt",
      );
    }
    included = terminalRuns.filter((r) => {
      const ts = r.updatedAt;
      return ts >= request.startAt! && ts <= request.endAt!;
    });
  } else if (request.kind === "LAST_N_RUNS") {
    const n = request.lastN ?? 10;
    included = [...terminalRuns]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-n);
  }

  const includedRunIds = included.map((r) => r.runId).sort();
  const fingerprint = windowFingerprint({
    projectId: request.projectId,
    kind: request.kind,
    includedRunIds,
    ...(request.startAt !== undefined ? { startAt: request.startAt } : {}),
    ...(request.endAt !== undefined ? { endAt: request.endAt } : {}),
    ...(request.lastN !== undefined ? { lastN: request.lastN } : {}),
  });

  const window: MetricWindow = {
    projectId: request.projectId,
    kind: request.kind,
    includedRunIds,
    windowFingerprint: fingerprint,
  };
  if (request.startAt !== undefined) window.startAt = request.startAt;
  if (request.endAt !== undefined) window.endAt = request.endAt;
  if (request.lastN !== undefined) window.lastN = request.lastN;
  return window;
}

export async function resolveTerminalRunIds(
  runs: RunRepository,
  projectId: string,
): Promise<string[]> {
  const all = await runs.listByProject(projectId);
  return all.filter((r) => isTerminalRunState(r.state)).map((r) => r.runId);
}

/** Baseline window: prior N terminal runs before current window runs. */
export async function buildBaselineWindow(
  runs: RunRepository,
  projectId: string,
  currentRunIds: readonly string[],
  baselineCount: number,
): Promise<{ runIds: string[]; fingerprint: string } | null> {
  const all = await runs.listByProject(projectId);
  const terminal = [...all]
    .filter((r) => isTerminalRunState(r.state))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const currentSet = new Set(currentRunIds);
  const prior = terminal.filter((r) => !currentSet.has(r.runId));
  if (prior.length < baselineCount) {
    return null;
  }
  const baselineRuns = prior.slice(-baselineCount);
  const runIds = baselineRuns.map((r) => r.runId).sort();
  return {
    runIds,
    fingerprint: windowFingerprint({
      projectId,
      kind: "LAST_N_RUNS",
      includedRunIds: runIds,
      lastN: baselineCount,
    }),
  };
}
