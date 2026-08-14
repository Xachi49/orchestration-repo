import { createHash } from "node:crypto";
import type { Objective } from "../objective/objective.js";

/**
 * Identity fields used for objective idempotency.
 * Intentionally excludes requestedOutcome text so wording tweaks
 * on the same objective version do not fork identity.
 */
export type ObjectiveIdempotencyIdentity = Pick<
  Objective,
  "projectId" | "objectiveId" | "objectiveVersion" | "requesterId"
>;

function canonicalizeIdentity(
  identity: ObjectiveIdempotencyIdentity,
): string {
  const payload = {
    objectiveId: identity.objectiveId,
    objectiveVersion: identity.objectiveVersion,
    projectId: identity.projectId,
    requesterId: identity.requesterId,
  };
  return JSON.stringify(payload);
}

/**
 * Deterministic idempotency key for an objective identity.
 * Retries of the same objective version resolve to the same key.
 */
export function objectiveIdempotencyKey(
  identity: ObjectiveIdempotencyIdentity,
): string {
  const canonical = canonicalizeIdentity(identity);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
