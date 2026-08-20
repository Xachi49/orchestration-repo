/**
 * Operational retry classification. Not a generic retry engine.
 * DATABASE RETRY != MODEL RETRY
 * DATABASE RETRY != SIDE-EFFECT RETRY
 */
export const RETRY_CLASSES = [
  "SAFE_READ_RETRY",
  "IDEMPOTENT_DELIVERY_RETRY",
  "COORDINATION_RETRY",
  "UNSAFE_SIDE_EFFECT_RETRY",
  "AMBIGUOUS_MODEL_DISPATCH",
  "NO_RETRY",
] as const;
export type RetryClass = (typeof RETRY_CLASSES)[number];

export function describeRetryClass(kind: RetryClass): string {
  switch (kind) {
    case "SAFE_READ_RETRY":
      return "May retry idempotent reads (health, schema status).";
    case "IDEMPOTENT_DELIVERY_RETRY":
      return "At-least-once outbox delivery with idempotent consumers only.";
    case "COORDINATION_RETRY":
      return "May retry lease/CAS coordination conflicts; never fabricates success.";
    case "UNSAFE_SIDE_EFFECT_RETRY":
      return "Must not blindly retry. Contain or reconcile under Phase 11 fencing.";
    case "AMBIGUOUS_MODEL_DISPATCH":
      return "Do not redispatch. Charge conservatively and require review.";
    case "NO_RETRY":
      return "Terminal operational failure; fail closed.";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}
