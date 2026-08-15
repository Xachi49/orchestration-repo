import { z } from "zod";
import type { RunRepository } from "../admission/run-repository.js";
import type { ObjectiveRepository } from "../admission/objective-repository.js";
import type { ControlPlaneService } from "../control-plane/service.js";
import type {
  LockedRepositoryStore,
  VerifiedRepositoryContextStore,
} from "../ingestion/index.js";
import { isVerifiedReadyForPlanning } from "../ingestion/context.js";
import { PlanningError } from "./errors.js";

export const PlanningReadinessCodeSchema = z.enum([
  "READY",
  "RUN_NOT_INGESTING",
  "CONTEXT_NOT_VERIFIED",
  "REPOSITORY_STATE_NOT_VERIFIED",
  "REPOSITORY_DRIFTED",
  "CONTROL_CONTEXT_UNAVAILABLE",
  "OBJECTIVE_MISMATCH",
  "CONTEXT_MISMATCH",
]);
export type PlanningReadinessCode = z.infer<typeof PlanningReadinessCodeSchema>;

export type PlanningReadinessResult =
  | { ready: true; code: "READY" }
  | {
      ready: false;
      code: Exclude<PlanningReadinessCode, "READY">;
      message: string;
    };

export interface PlanningReadinessServiceDeps {
  runs: RunRepository;
  contexts: VerifiedRepositoryContextStore;
  locks: LockedRepositoryStore;
  objectives: ObjectiveRepository;
  controlPlane: ControlPlaneService;
}

/**
 * Deterministic gate. Never invokes a planning model.
 * Queries LIVE locked repository state — cached VERIFIED context is insufficient
 * if the lock has become STALE or INVALID.
 *
 * Eligible run states: INGESTING (first plan) or PLANNING (bounded retry).
 */
export class PlanningReadinessService {
  constructor(private readonly deps: PlanningReadinessServiceDeps) {}

  async assess(runId: string): Promise<PlanningReadinessResult> {
    const run = await this.deps.runs.getById(runId);
    if (!run) {
      return {
        ready: false,
        code: "RUN_NOT_INGESTING",
        message: `Run not found: ${runId}`,
      };
    }
    if (run.state !== "INGESTING" && run.state !== "PLANNING") {
      return {
        ready: false,
        code: "RUN_NOT_INGESTING",
        message: `Run ${runId} is in ${run.state}, expected INGESTING`,
      };
    }

    const context = await this.deps.contexts.getByRunId(runId);
    if (!context || context.status !== "VERIFIED") {
      return {
        ready: false,
        code: "CONTEXT_NOT_VERIFIED",
        message: `No VERIFIED repository context for run ${runId}`,
      };
    }
    if (
      context.runId !== run.runId ||
      context.projectId !== run.projectId ||
      context.environment !== run.requestedEnvironment
    ) {
      return {
        ready: false,
        code: "CONTEXT_MISMATCH",
        message: "Verified repository context does not match the run",
      };
    }

    const liveLock = await this.deps.locks.getByRunId(runId);
    if (!liveLock) {
      return {
        ready: false,
        code: "REPOSITORY_STATE_NOT_VERIFIED",
        message: "No locked repository state for run",
      };
    }
    if (liveLock.status === "STALE") {
      return {
        ready: false,
        code: "REPOSITORY_DRIFTED",
        message: "Live locked repository state is STALE",
      };
    }
    if (liveLock.status === "INVALID") {
      return {
        ready: false,
        code: "REPOSITORY_STATE_NOT_VERIFIED",
        message: "Live locked repository state is INVALID",
      };
    }
    if (liveLock.status !== "VERIFIED") {
      return {
        ready: false,
        code: "REPOSITORY_STATE_NOT_VERIFIED",
        message: `Live locked repository state is ${liveLock.status}`,
      };
    }
    if (
      !isVerifiedReadyForPlanning({
        context,
        liveLockedState: liveLock,
      })
    ) {
      return {
        ready: false,
        code: "REPOSITORY_DRIFTED",
        message: "Verified context is not ready for planning against live lock",
      };
    }

    const objective = await this.deps.objectives.getByRunBinding(runId);
    if (!objective) {
      return {
        ready: false,
        code: "OBJECTIVE_MISMATCH",
        message: `No objective bound to run ${runId}`,
      };
    }
    if (
      objective.objectiveId !== run.objectiveId ||
      objective.objectiveVersion !== run.objectiveVersion ||
      objective.projectId !== run.projectId
    ) {
      return {
        ready: false,
        code: "OBJECTIVE_MISMATCH",
        message: "Bound objective does not match run identity",
      };
    }

    try {
      await this.deps.controlPlane.resolve(
        run.projectId,
        run.requestedEnvironment,
      );
    } catch (error) {
      return {
        ready: false,
        code: "CONTROL_CONTEXT_UNAVAILABLE",
        message:
          error instanceof Error
            ? error.message
            : "Control plane resolution failed",
      };
    }

    return { ready: true, code: "READY" };
  }

  async assertReady(runId: string): Promise<void> {
    const result = await this.assess(runId);
    if (!result.ready) {
      const code =
        result.code === "REPOSITORY_DRIFTED"
          ? "REPOSITORY_CONTEXT_STALE"
          : "PLANNING_NOT_READY";
      throw new PlanningError(code, result.message, {
        readinessCode: result.code,
        runId,
      });
    }
  }
}
