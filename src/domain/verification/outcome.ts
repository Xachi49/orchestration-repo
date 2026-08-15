import { z } from "zod";

/**
 * Authoritative Phase 8 outcome verdict.
 * EXECUTION_SUCCEEDED ≠ VERIFIED_SUCCESS.
 * Model recommendation alone cannot produce VERIFIED_SUCCESS.
 */
export const OutcomeVerdictSchema = z.enum([
  "VERIFIED_SUCCESS",
  "PARTIAL_SUCCESS",
  "VERIFICATION_FAILED",
  "INCONCLUSIVE",
  "CONTAINED",
]);

export type OutcomeVerdict = z.infer<typeof OutcomeVerdictSchema>;

export function parseOutcomeVerdict(input: unknown): OutcomeVerdict {
  return OutcomeVerdictSchema.parse(input);
}
