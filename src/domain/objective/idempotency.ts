import { createHash } from "node:crypto";
import type { ObjectiveVersion } from "../objective/objective.js";

/**
 * Logical admission identity.
 * requesterId is intentionally excluded so a second requester cannot fork a run.
 */
export interface ObjectiveIdempotencyIdentity {
  projectId: string;
  objectiveId: string;
  objectiveVersion: ObjectiveVersion;
  requestedEnvironment: string;
}

function canonicalizeIdentity(
  identity: ObjectiveIdempotencyIdentity,
): string {
  const payload = {
    objectiveId: identity.objectiveId,
    objectiveVersion: identity.objectiveVersion,
    projectId: identity.projectId,
    requestedEnvironment: identity.requestedEnvironment,
  };
  return JSON.stringify(payload);
}

/**
 * Deterministic idempotency key for an objective identity.
 * Retries of the same objective version and environment resolve to the same key.
 */
export function objectiveIdempotencyKey(
  identity: ObjectiveIdempotencyIdentity,
): string {
  const canonical = canonicalizeIdentity(identity);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
