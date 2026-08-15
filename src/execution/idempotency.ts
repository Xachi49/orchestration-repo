import { createHash } from "node:crypto";
import { canonicalizeValue } from "../domain/plan/plan-hasher.js";

/**
 * Deterministic step idempotency key from plan + step identity + fingerprints.
 * No random values. Material argument/target changes must change the key.
 */
export function stepIdempotencyKey(input: {
  planHash: string;
  stepId: string;
  capabilityId: string;
  targetFingerprint: string;
  argumentFingerprint: string;
}): string {
  const payload = JSON.stringify(
    canonicalizeValue({
      planHash: input.planHash,
      stepId: input.stepId,
      capabilityId: input.capabilityId,
      targetFingerprint: input.targetFingerprint,
      argumentFingerprint: input.argumentFingerprint,
    }),
  );
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

/**
 * Deterministic idempotency key for an authorized automatic rollback actuation.
 * Distinct from the source step key so rollback cannot collide with the
 * failed primary step reservation.
 */
export function rollbackIdempotencyKey(input: {
  planHash: string;
  sourceStepId: string;
  rollbackPlanId: string;
  compensatingStepId: string;
  capabilityId: string;
  targetFingerprint: string;
  argumentFingerprint: string;
}): string {
  const payload = JSON.stringify(
    canonicalizeValue({
      kind: "AUTOMATIC_ROLLBACK",
      planHash: input.planHash,
      sourceStepId: input.sourceStepId,
      rollbackPlanId: input.rollbackPlanId,
      compensatingStepId: input.compensatingStepId,
      capabilityId: input.capabilityId,
      targetFingerprint: input.targetFingerprint,
      argumentFingerprint: input.argumentFingerprint,
    }),
  );
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function fingerprintValue(value: unknown): string {
  const canonical = JSON.stringify(canonicalizeValue(value));
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
