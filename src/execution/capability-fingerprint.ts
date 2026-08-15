import { createHash } from "node:crypto";
import { canonicalizeValue } from "../domain/plan/plan-hasher.js";

/**
 * Execution-authority fields covered by the capability set fingerprint.
 * Excludes descriptions, timestamps, display labels, and other non-authority metadata.
 */
export type CapabilityAuthorityFields = {
  capabilityId: string;
  version: string;
  enabled: boolean;
  allowedActions: readonly string[];
  forbiddenActions: readonly string[];
  allowedEnvironments: readonly string[];
  approvalRequirement: string;
  maximumRuntimeSeconds: number;
};

/**
 * Deterministic fingerprint of capabilities relevant to an approved plan.
 *
 * Any material change to execution capability authority between the expected
 * authorized state and live preflight/rollback must yield
 * EXECUTION_CAPABILITY_CHANGED — including runtime ceiling increases or decreases.
 * Fail closed; do not judge whether a change is "safe enough."
 */
export function capabilitySetFingerprint(
  capabilities: readonly CapabilityAuthorityFields[],
): string {
  const normalized = [...capabilities]
    .map((cap) => ({
      capabilityId: cap.capabilityId,
      version: cap.version,
      enabled: cap.enabled,
      allowedActions: [...cap.allowedActions].sort(),
      forbiddenActions: [...cap.forbiddenActions].sort(),
      allowedEnvironments: [...cap.allowedEnvironments].sort(),
      approvalRequirement: cap.approvalRequirement,
      maximumRuntimeSeconds: cap.maximumRuntimeSeconds,
    }))
    .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  const canonical = JSON.stringify(canonicalizeValue(normalized));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Unique capabilities from a live control context that permit plan step actions.
 */
export function uniqueCapabilitiesForPlanActions(input: {
  stepActionTypes: readonly string[];
  availableCapabilities: readonly CapabilityAuthorityFields[];
}): CapabilityAuthorityFields[] {
  const relevant: CapabilityAuthorityFields[] = [];
  for (const action of input.stepActionTypes) {
    for (const cap of input.availableCapabilities) {
      if (cap.allowedActions.includes(action)) {
        relevant.push(cap);
      }
    }
  }
  return [
    ...new Map(relevant.map((c) => [c.capabilityId, c])).values(),
  ];
}
