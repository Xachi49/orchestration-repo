/**
 * Deterministic work kinds. SCHEDULING != AUTHORITY.
 * HUMAN_APPROVAL is intentionally absent — never autonomous.
 * ROUTE_AUTHORIZATION / ROUTE_PROGRAM_MATERIALIZATION / ROUTE_PORTFOLIO_AUTHORIZATION
 * open human gates only.
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
  "DECOMPOSE_PROGRAM",
  "VALIDATE_PROGRAM",
  "ROUTE_PROGRAM_MATERIALIZATION",
  "MATERIALIZE_PROGRAM",
  "RECONCILE_PROGRAM",
  "VERIFY_PROGRAM",
  "ANALYZE_PORTFOLIO",
  "PLAN_PORTFOLIO",
  "VALIDATE_PORTFOLIO",
  "ROUTE_PORTFOLIO_AUTHORIZATION",
  "MATERIALIZE_PORTFOLIO_PROGRAMS",
  "RECONCILE_PORTFOLIO",
  "VERIFY_PORTFOLIO",
  "REBALANCE_PORTFOLIO",
] as const;

export type SchedulerWorkKind = (typeof SCHEDULER_WORK_KINDS)[number];

export const PROGRAM_SCHEDULER_WORK_KINDS = [
  "DECOMPOSE_PROGRAM",
  "VALIDATE_PROGRAM",
  "ROUTE_PROGRAM_MATERIALIZATION",
  "MATERIALIZE_PROGRAM",
  "RECONCILE_PROGRAM",
  "VERIFY_PROGRAM",
] as const satisfies readonly SchedulerWorkKind[];

export type ProgramSchedulerWorkKind =
  (typeof PROGRAM_SCHEDULER_WORK_KINDS)[number];

export function isProgramSchedulerWorkKind(
  kind: SchedulerWorkKind,
): kind is ProgramSchedulerWorkKind {
  return (PROGRAM_SCHEDULER_WORK_KINDS as readonly string[]).includes(kind);
}

export const PORTFOLIO_SCHEDULER_WORK_KINDS = [
  "ANALYZE_PORTFOLIO",
  "PLAN_PORTFOLIO",
  "VALIDATE_PORTFOLIO",
  "ROUTE_PORTFOLIO_AUTHORIZATION",
  "MATERIALIZE_PORTFOLIO_PROGRAMS",
  "RECONCILE_PORTFOLIO",
  "VERIFY_PORTFOLIO",
  "REBALANCE_PORTFOLIO",
] as const satisfies readonly SchedulerWorkKind[];

export type PortfolioSchedulerWorkKind =
  (typeof PORTFOLIO_SCHEDULER_WORK_KINDS)[number];

export function isPortfolioSchedulerWorkKind(
  kind: SchedulerWorkKind,
): kind is PortfolioSchedulerWorkKind {
  return (PORTFOLIO_SCHEDULER_WORK_KINDS as readonly string[]).includes(kind);
}

export const WORKER_CAPABILITY_LABELS = [
  "INGESTION",
  "PLANNING",
  "VALIDATION",
  "AUTHORIZATION_ROUTING",
  "EXECUTION",
  "VERIFICATION",
  "LEARNING",
  "OBSERVABILITY",
  "PROGRAM_ORCHESTRATION",
  "PORTFOLIO_ORCHESTRATION",
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
    case "DECOMPOSE_PROGRAM":
    case "VALIDATE_PROGRAM":
    case "ROUTE_PROGRAM_MATERIALIZATION":
    case "MATERIALIZE_PROGRAM":
    case "RECONCILE_PROGRAM":
    case "VERIFY_PROGRAM":
      return "PROGRAM_ORCHESTRATION";
    case "ANALYZE_PORTFOLIO":
    case "PLAN_PORTFOLIO":
    case "VALIDATE_PORTFOLIO":
    case "ROUTE_PORTFOLIO_AUTHORIZATION":
    case "MATERIALIZE_PORTFOLIO_PROGRAMS":
    case "RECONCILE_PORTFOLIO":
    case "VERIFY_PORTFOLIO":
    case "REBALANCE_PORTFOLIO":
      return "PORTFOLIO_ORCHESTRATION";
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
