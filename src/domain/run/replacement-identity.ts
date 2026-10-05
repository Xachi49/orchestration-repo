import { createHash } from "node:crypto";
import type { ObjectiveVersion } from "../objective/objective.js";

/**
 * Idempotency identity that authorizes creation of a governed replacement run.
 *
 * Distinct from objectiveIdempotencyKey(). Ordinary admission keeps using the
 * objective key. runs_idempotency_key_uq stays unique, so a replacement cannot
 * reuse the predecessor's admission key.
 *
 * RunRecord.idempotencyKey means "the idempotency identity that authorized
 * creation of this run", not "always the ordinary objective admission key".
 */
export interface RunReplacementIdempotencyIdentity {
  projectId: string;
  objectiveId: string;
  objectiveVersion: ObjectiveVersion;
  requestedEnvironment: string;
  predecessorRunId: string;
  replacementReason: "SYSTEM_DEFECT_RETRY";
}

export function runReplacementIdempotencyKey(
  identity: RunReplacementIdempotencyIdentity,
): string {
  const payload = {
    kind: "RUN_REPLACEMENT",
    objectiveId: identity.objectiveId,
    objectiveVersion: identity.objectiveVersion,
    predecessorRunId: identity.predecessorRunId,
    projectId: identity.projectId,
    replacementReason: identity.replacementReason,
    requestedEnvironment: identity.requestedEnvironment,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/**
 * Material fingerprint stored on the replacement idempotency row.
 * Same identity with different objective content conflicts instead of forking.
 */
export function runReplacementMaterialFingerprint(input: {
  objectiveFingerprint: string;
  predecessorRunId: string;
  replacementReason: "SYSTEM_DEFECT_RETRY";
  objectiveId: string;
  objectiveVersion: ObjectiveVersion;
  requestedEnvironment: string;
  projectId: string;
}): string {
  const payload = {
    kind: "RUN_REPLACEMENT_MATERIAL",
    objectiveFingerprint: input.objectiveFingerprint,
    objectiveId: input.objectiveId,
    objectiveVersion: input.objectiveVersion,
    predecessorRunId: input.predecessorRunId,
    projectId: input.projectId,
    replacementReason: input.replacementReason,
    requestedEnvironment: input.requestedEnvironment,
  };
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
