import { createHash } from "node:crypto";
import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentPlan } from "./plan.js";
import type { ExperimentAuthorizationRecord } from "./authorization.js";
import {
  mintExecutionLineageId,
  type ExperimentExecutionLineage,
} from "./evidence.js";
import { ExperimentError } from "./errors.js";
import { assertExperimentAuthorizationDoesNotExecute } from "./authorization.js";
import { mintExperimentObjectiveIdentity } from "./objective-admission-port.js";

/**
 * Compiles an authorized experiment into a bounded Objective admission request.
 * Does NOT create Phase 6 authorization or execution attempts.
 * Phase 2 admission is performed by ExperimentOrchestrationService via
 * ExperimentObjectiveAdmissionPort — not by this pure compiler.
 */
export interface CompiledExperimentObjective {
  projectId: string;
  requestedEnvironment: string;
  requestedOutcome: string;
  correlationId: string;
  contentFingerprint: string;
  objectiveId: string;
  objectiveVersion: number;
  /** Explicit: still requires Phase 2 admit + Phase 6 authorize. */
  requiresPhase6Authorization: true;
  requiresPhase2Admission: true;
}

export function compileExperimentToObjective(input: {
  experiment: GovernedExperiment;
  plan: ExperimentPlan;
  authorization: ExperimentAuthorizationRecord;
  compiledAt: string;
}): {
  compiled: CompiledExperimentObjective;
  lineageDraft: ExperimentExecutionLineage;
} {
  assertExperimentAuthorizationDoesNotExecute();

  if (input.authorization.decision !== "APPROVE_EXPERIMENT") {
    throw new ExperimentError(
      "EXPERIMENT_AUTHORIZATION_REQUIRED",
      "Execution compilation requires APPROVE_EXPERIMENT",
    );
  }

  const requestedOutcome = [
    `Governed experiment ${input.experiment.experimentId}:`,
    input.experiment.objective,
    `Plan ${input.plan.experimentPlanHash.slice(0, 12)}`,
  ].join(" ");

  const contentFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        experimentId: input.experiment.experimentId,
        experimentPlanHash: input.plan.experimentPlanHash,
        authorizationRecordId: input.authorization.authorizationRecordId,
      }),
      "utf8",
    )
    .digest("hex");

  const identity = mintExperimentObjectiveIdentity({
    experimentId: input.experiment.experimentId,
    experimentPlanHash: input.plan.experimentPlanHash,
    authorizationRecordId: input.authorization.authorizationRecordId,
  });

  const compiled: CompiledExperimentObjective = {
    projectId: input.experiment.projectId,
    requestedEnvironment: input.experiment.requestedEnvironment,
    requestedOutcome: requestedOutcome.slice(0, 2000),
    correlationId: input.experiment.correlationId,
    contentFingerprint,
    objectiveId: identity.objectiveId,
    objectiveVersion: identity.objectiveVersion,
    requiresPhase6Authorization: true,
    requiresPhase2Admission: true,
  };

  const now = input.compiledAt;
  const lineageDraft: ExperimentExecutionLineage = {
    lineageId: mintExecutionLineageId({
      experimentId: input.experiment.experimentId,
      experimentPlanHash: input.plan.experimentPlanHash,
    }),
    experimentId: input.experiment.experimentId,
    experimentVersion: input.experiment.experimentVersion,
    experimentPlanHash: input.plan.experimentPlanHash,
    experimentAuthorizationRecordId: input.authorization.authorizationRecordId,
    compiledObjectiveId: identity.objectiveId,
    compiledObjectiveVersion: identity.objectiveVersion,
    createdAt: now,
    updatedAt: now,
    recordRevision: 1,
  };

  return { compiled, lineageDraft };
}
