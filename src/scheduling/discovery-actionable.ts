import type { RunState } from "../domain/run/run-state.js";
import type { SchedulerWorkKind } from "./work-kind.js";
import { DISCOVERABLE_RUN_STATES } from "./discovery-map.js";

/**
 * Work kinds whose durable presence means rediscovery of a Run cannot
 * materialize *new* logical work for that phase — retry/reconciliation is the
 * work item's responsibility.
 *
 * Artifact gates still apply inside discoverForRun; this set is the SQL
 * exclusion key for "already represented" runs so they do not monopolize a
 * bounded discovery page.
 */
export function discoveryMaterializationKinds(
  state: RunState,
): readonly SchedulerWorkKind[] {
  switch (state) {
    case "ADMITTED":
      return ["INGEST_REPOSITORY"];
    case "INGESTING":
      return ["PLAN_RUN"];
    case "VALIDATING":
      return ["VALIDATE_PLAN", "ROUTE_AUTHORIZATION"];
    case "REVISING":
      return ["PLAN_RUN", "VALIDATE_PLAN"];
    case "APPROVED":
      return ["EXECUTE_PLAN"];
    case "EXECUTING":
      return ["VERIFY_OUTCOME"];
    case "COMPLETED":
      return ["LEARN_FROM_RUN", "BUILD_OBSERVABILITY"];
    default:
      return [];
  }
}

export function isDiscoverableRunState(state: string): boolean {
  return (DISCOVERABLE_RUN_STATES as readonly string[]).includes(state);
}
