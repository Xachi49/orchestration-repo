/**
 * Deterministic work kinds. SCHEDULING != AUTHORITY.
 * HUMAN_APPROVAL is intentionally absent — never autonomous.
 * ROUTE_AUTHORIZATION creates the human gate; it does not approve.
 */
export const SCHEDULER_WORK_KINDS = [
  "INGEST_REPOSITORY",
  "PLAN_RUN",
  "VALIDATE_PLAN",
  "ROUTE_AUTHORIZATION",
  "EXECUTE_PLAN",
  "VERIFY_OUTCOME",
  "LEARN_FROM_RUN",
  "BUILD_OBSERVABILITY",
] as const;

export type SchedulerWorkKind = (typeof SCHEDULER_WORK_KINDS)[number];

export const WORKER_CAPABILITY_LABELS = [
  "INGESTION",
  "PLANNING",
  "VALIDATION",
  "AUTHORIZATION_ROUTING",
  "EXECUTION",
  "VERIFICATION",
  "LEARNING",
  "OBSERVABILITY",
  "ALL",
] as const;

export type WorkerCapabilityLabel = (typeof WORKER_CAPABILITY_LABELS)[number];

export function workKindToCapability(
  kind: SchedulerWorkKind,
): Exclude<WorkerCapabilityLabel, "ALL"> {
  switch (kind) {
    case "INGEST_REPOSITORY":
      return "INGESTION";
    case "PLAN_RUN":
      return "PLANNING";
    case "VALIDATE_PLAN":
      return "VALIDATION";
    case "ROUTE_AUTHORIZATION":
      return "AUTHORIZATION_ROUTING";
    case "EXECUTE_PLAN":
      return "EXECUTION";
    case "VERIFY_OUTCOME":
      return "VERIFICATION";
    case "LEARN_FROM_RUN":
      return "LEARNING";
    case "BUILD_OBSERVABILITY":
      return "OBSERVABILITY";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function workerSupportsKind(
  capabilities: readonly WorkerCapabilityLabel[],
  kind: SchedulerWorkKind,
): boolean {
  if (capabilities.includes("ALL")) {
    return true;
  }
  return capabilities.includes(workKindToCapability(kind));
}
