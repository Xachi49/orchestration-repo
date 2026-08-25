import { createHash } from "node:crypto";
import type { ProgramRootIntent } from "./program.js";

export interface ProgramIdempotencyIdentity {
  projectId: string;
  programId: string;
  programVersion: number;
  requestedEnvironment: string;
}

export function programIdempotencyKey(
  identity: ProgramIdempotencyIdentity,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        programId: identity.programId,
        programVersion: identity.programVersion,
        projectId: identity.projectId,
        requestedEnvironment: identity.requestedEnvironment,
      }),
      "utf8",
    )
    .digest("hex");
}

export function programContentFingerprint(input: {
  rootIntent: ProgramRootIntent;
  requesterId: string;
  delegationEnvelopeHash: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        acceptanceCriteria: input.rootIntent.acceptanceCriteria,
        constraints: input.rootIntent.constraints,
        deadline: input.rootIntent.deadline ?? null,
        delegationEnvelopeHash: input.delegationEnvelopeHash,
        nonGoals: input.rootIntent.nonGoals,
        priority: input.rootIntent.priority,
        requestedOutcome: input.rootIntent.requestedOutcome,
        requesterId: input.requesterId,
      }),
      "utf8",
    )
    .digest("hex");
}

/** Child objective identity derived from program lineage. */
export function childObjectiveIdentity(input: {
  programId: string;
  programPlanVersion: number;
  nodeId: string;
}): { objectiveId: string; objectiveVersion: number } {
  const objectiveId = `obj_prog_${createHash("sha256")
    .update(
      JSON.stringify({
        nodeId: input.nodeId,
        planVersion: input.programPlanVersion,
        programId: input.programId,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 28)}`;
  return { objectiveId, objectiveVersion: input.programPlanVersion };
}
