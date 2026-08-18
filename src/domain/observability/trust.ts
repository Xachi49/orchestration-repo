import { z } from "zod";

/**
 * Telemetry trust classification.
 *
 * AUTHORITATIVE_DERIVED requires sufficiently strong source quality
 * (EXACT or complete RECONSTRUCTED). Deterministic calculation over
 * incomplete/proxy inputs is BEST_EFFORT_DERIVED, not authoritative.
 *
 * Only AUTHORITATIVE_DERIVED may drive SLO evaluation and hard anomaly rules.
 */
export const TelemetryTrustClassSchema = z.enum([
  "AUTHORITATIVE_DERIVED",
  "BEST_EFFORT_DERIVED",
  "MODEL_INTERPRETED",
]);
export type TelemetryTrustClass = z.infer<typeof TelemetryTrustClassSchema>;
