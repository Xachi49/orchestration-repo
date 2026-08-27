import { createHash } from "node:crypto";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { AdmissionRequest } from "../admission/request.js";
import type { CompiledExperimentObjective } from "./execution-compiler.js";
import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentPlan } from "./plan.js";
import type { ExperimentAuthorizationRecord } from "./authorization.js";
import { compileExperimentAcceptanceCriteria } from "./planning-proposal.js";

/**
 * Narrow Phase 2 handoff for experiment execution compilation.
 * Must never authorize Phase 6 execution or create ExecutionAttempts.
 */
export type ExperimentObjectiveAdmissionOutcome =
  | {
      outcome: "ADMITTED";
      runId: string;
      objectiveId: string;
      objectiveVersion: number;
    }
  | {
      outcome: "DUPLICATE_REUSED";
      runId: string;
      objectiveId: string;
      objectiveVersion: number;
    }
  | { outcome: "REJECTED"; reason: string }
  | { outcome: "UNAVAILABLE"; reason: string };

export interface ExperimentObjectiveAdmissionRequest {
  experiment: GovernedExperiment;
  plan: ExperimentPlan;
  authorization: ExperimentAuthorizationRecord;
  compiled: CompiledExperimentObjective;
  objectiveId: string;
  objectiveVersion: number;
  requesterId: string;
  submittedAt: string;
}

export interface ExperimentObjectiveAdmissionPort {
  admitCompiledObjective(
    request: ExperimentObjectiveAdmissionRequest,
  ): Promise<ExperimentObjectiveAdmissionOutcome>;
}

export function mintExperimentObjectiveIdentity(input: {
  experimentId: string;
  experimentPlanHash: string;
  authorizationRecordId: string;
}): { objectiveId: string; objectiveVersion: number } {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        experimentId: input.experimentId,
        experimentPlanHash: input.experimentPlanHash,
        authorizationRecordId: input.authorizationRecordId,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return {
    objectiveId: `obj_exp_${digest}`,
    objectiveVersion: 1,
  };
}

function toAdmissionRequest(
  request: ExperimentObjectiveAdmissionRequest,
): AdmissionRequest {
  return {
    projectId: request.compiled.projectId,
    objectiveId: request.objectiveId,
    objectiveVersion: request.objectiveVersion,
    requestedOutcome: request.compiled.requestedOutcome,
    acceptanceCriteria: [...compileExperimentAcceptanceCriteria(request.plan)],
    nonGoals: [
      "Phase 6 self-authorization",
      "AssumptionSet mutation",
      ...request.experiment.nonGoals,
    ],
    constraints: [
      `experimentId=${request.experiment.experimentId}`,
      `experimentPlanHash=${request.plan.experimentPlanHash}`,
      ...request.experiment.constraints,
    ],
    priority: "MEDIUM",
    requesterId: request.requesterId,
    requestedEnvironment: request.compiled.requestedEnvironment,
    submittedAt: request.submittedAt,
  };
}

/**
 * Production adapter: delegates to Phase 2 ObjectiveAdmissionService.
 */
export class Phase2ExperimentObjectiveAdmissionPort
  implements ExperimentObjectiveAdmissionPort
{
  constructor(private readonly admission: ObjectiveAdmissionService) {}

  async admitCompiledObjective(
    request: ExperimentObjectiveAdmissionRequest,
  ): Promise<ExperimentObjectiveAdmissionOutcome> {
    try {
      const result = await this.admission.admit(toAdmissionRequest(request));
      if (result.outcome === "ADMITTED") {
        return {
          outcome: "ADMITTED",
          runId: result.runId,
          objectiveId: request.objectiveId,
          objectiveVersion: request.objectiveVersion,
        };
      }
      if (
        result.outcome === "ACTIVE_DUPLICATE" ||
        result.outcome === "COMPLETED_DUPLICATE"
      ) {
        return {
          outcome: "DUPLICATE_REUSED",
          runId: result.runId,
          objectiveId: request.objectiveId,
          objectiveVersion: request.objectiveVersion,
        };
      }
      return {
        outcome: "REJECTED",
        reason:
          result.outcome === "REJECTED" || result.outcome === "CONFLICT"
            ? `${result.reasonCode}: ${result.message}`
            : String(result.outcome),
      };
    } catch (err) {
      return {
        outcome: "REJECTED",
        reason:
          err instanceof Error ? err.message : "Objective admission failed",
      };
    }
  }
}

/**
 * Deterministic fake for unit tests. Models ADMITTED / DUPLICATE_REUSED /
 * REJECTED / UNAVAILABLE without inventing Phase 6 authority.
 */
export class FakeExperimentObjectiveAdmissionPort
  implements ExperimentObjectiveAdmissionPort
{
  admitCallCount = 0;
  mode: "ADMITTED" | "DUPLICATE_REUSED" | "REJECTED" | "UNAVAILABLE" =
    "ADMITTED";
  /** Crash after recording an admit (simulates post-admit, pre-lineage failure). */
  crashAfterAdmit = false;
  private readonly byFingerprint = new Map<
    string,
    { runId: string; objectiveId: string; objectiveVersion: number }
  >();
  private runSeq = 0;

  deterministicRunId(objectiveId: string): string {
    const digest = createHash("sha256")
      .update(objectiveId, "utf8")
      .digest("hex")
      .slice(0, 16);
    return `run_exp_fake_${digest}`;
  }

  async admitCompiledObjective(
    request: ExperimentObjectiveAdmissionRequest,
  ): Promise<ExperimentObjectiveAdmissionOutcome> {
    if (this.mode === "UNAVAILABLE") {
      return {
        outcome: "UNAVAILABLE",
        reason: "Fake experiment objective admission port unavailable",
      };
    }
    if (this.mode === "REJECTED") {
      return {
        outcome: "REJECTED",
        reason: "Fake experiment objective admission rejected",
      };
    }

    const key = request.compiled.contentFingerprint;
    const existing = this.byFingerprint.get(key);
    this.admitCallCount += 1;

    if (existing) {
      if (this.crashAfterAdmit) {
        throw new Error(
          "simulated crash after experiment objective admission (duplicate path)",
        );
      }
      return {
        outcome: "DUPLICATE_REUSED",
        runId: existing.runId,
        objectiveId: existing.objectiveId,
        objectiveVersion: existing.objectiveVersion,
      };
    }

    this.runSeq += 1;
    const runId =
      this.mode === "DUPLICATE_REUSED"
        ? this.deterministicRunId(request.objectiveId)
        : this.deterministicRunId(`${request.objectiveId}:${this.runSeq}`);
    const admitted = {
      runId,
      objectiveId: request.objectiveId,
      objectiveVersion: request.objectiveVersion,
    };
    this.byFingerprint.set(key, admitted);

    if (this.crashAfterAdmit) {
      throw new Error("simulated crash after experiment objective admission");
    }

    if (this.mode === "DUPLICATE_REUSED") {
      return { outcome: "DUPLICATE_REUSED", ...admitted };
    }
    return { outcome: "ADMITTED", ...admitted };
  }
}
