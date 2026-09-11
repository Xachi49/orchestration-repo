import { createHash } from "node:crypto";
import { z } from "zod";

export const READINESS_CHECK_IDS = [
  "DATABASE_CONNECTIVITY",
  "SCHEMA_COMPATIBILITY",
  "MIGRATION_HEAD",
  "PRODUCTION_CONFIG",
  "RUNTIME_MANIFEST",
  "ARTIFACT_INTEGRITY",
  "PHASE23_CERTIFICATE",
  "FAULT_INJECTION_DISABLED",
  "RECOVERY_STATE",
  "WORKER_CONFIGURATION",
  "OBSERVABILITY",
  "DATA_MINIMIZATION",
  "SECURITY_BOUNDARY",
  "SHUTDOWN_CAPABILITY",
  "CANDIDATE_FINGERPRINT",
  "GOLDEN_PATH",
  "RESTART_RECOVERY",
  "NO_AUTHORITY_BYPASS",
] as const;

export type ReadinessCheckId = (typeof READINESS_CHECK_IDS)[number];

export const CRITICAL_READINESS_CHECKS: readonly ReadinessCheckId[] = [
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
];

export const ReadinessCheckResultSchema = z
  .object({
    checkId: z.enum(READINESS_CHECK_IDS),
    result: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    reasonCode: z.string().min(1),
    critical: z.boolean(),
  })
  .strict();

export type ReadinessCheckResult = z.infer<typeof ReadinessCheckResultSchema>;

export const ReadinessReportSchema = z
  .object({
    reportId: z.string().min(1),
    results: z.array(ReadinessCheckResultSchema).min(1),
    overall: z.enum(["PASS", "FAIL", "INCONCLUSIVE"]),
    evidenceSetFingerprint: z.string().min(1),
    evaluatedAt: z.string().datetime(),
  })
  .strict();

export type ReadinessReport = z.infer<typeof ReadinessReportSchema>;

export function computeReadinessEvidenceSetFingerprint(
  results: readonly ReadinessCheckResult[],
): string {
  const sorted = [...results]
    .map((r) => ({
      checkId: r.checkId,
      result: r.result,
      reasonCode: r.reasonCode,
      critical: r.critical,
    }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId));
  return createHash("sha256")
    .update(JSON.stringify({ results: sorted }), "utf8")
    .digest("hex");
}

export function evaluateReadinessOverall(
  results: readonly ReadinessCheckResult[],
): "PASS" | "FAIL" | "INCONCLUSIVE" {
  const critical = results.filter((r) => r.critical);
  if (critical.some((r) => r.result === "FAIL")) return "FAIL";
  if (critical.some((r) => r.result === "INCONCLUSIVE")) return "INCONCLUSIVE";
  if (results.some((r) => r.result === "FAIL")) return "FAIL";
  if (results.some((r) => r.result === "INCONCLUSIVE")) return "INCONCLUSIVE";
  return "PASS";
}

export function withReadinessReport(
  input: Omit<ReadinessReport, "evidenceSetFingerprint" | "overall"> & {
    overall?: ReadinessReport["overall"];
    evidenceSetFingerprint?: string;
  },
): ReadinessReport {
  const overall = input.overall ?? evaluateReadinessOverall(input.results);
  const evidenceSetFingerprint =
    input.evidenceSetFingerprint ??
    computeReadinessEvidenceSetFingerprint(input.results);
  return ReadinessReportSchema.parse({
    ...input,
    overall,
    evidenceSetFingerprint,
  });
}
