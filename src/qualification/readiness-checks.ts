import { randomUUID } from "node:crypto";
import {
  CRITICAL_READINESS_CHECKS,
  withReadinessReport,
  type ReadinessCheckResult,
  type ReadinessReport,
} from "./readiness.js";

export function mintReadinessReportId(): string {
  return `rqready_${randomUUID()}`;
}

export function buildReadinessCheck(input: {
  checkId: ReadinessCheckResult["checkId"];
  result: ReadinessCheckResult["result"];
  reasonCode: string;
  critical?: boolean;
}): ReadinessCheckResult {
  return {
    checkId: input.checkId,
    result: input.result,
    reasonCode: input.reasonCode,
    critical:
      input.critical ??
      CRITICAL_READINESS_CHECKS.includes(input.checkId),
  };
}

/** Compose a readiness report from discrete check results (no averaging). */
export function assembleReadinessReport(input: {
  results: readonly ReadinessCheckResult[];
  evaluatedAt: string;
  reportId?: string;
}): ReadinessReport {
  return withReadinessReport({
    reportId: input.reportId ?? mintReadinessReportId(),
    results: [...input.results],
    evaluatedAt: input.evaluatedAt,
  });
}
