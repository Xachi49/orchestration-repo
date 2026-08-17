import { z } from "zod";
import { HistoricalOutcomeSchema } from "./historical-run.js";

/**
 * Exact source authority for a learning candidate / promoted precedent.
 * No promotion without valid provenance.
 */
export const PrecedentProvenanceSchema = z
  .object({
    sourceHistoricalRunRecordId: z.string().min(1),
    runId: z.string().min(1),
    planHash: z.string().min(1).optional(),
    outcomeVerificationId: z.string().min(1).optional(),
    outcome: HistoricalOutcomeSchema,
    repositoryFingerprint: z.string().min(1).optional(),
    policyBundleHash: z.string().min(1).optional(),
    capabilitySetFingerprint: z.string().min(1).optional(),
    supportingEvidenceRefs: z.array(z.string()).default([]),
    supportingFindingRefs: z.array(z.string()).default([]),
    provenanceHash: z.string().min(1),
  })
  .strict();

export type PrecedentProvenance = z.infer<typeof PrecedentProvenanceSchema>;

export function parsePrecedentProvenance(input: unknown): PrecedentProvenance {
  return PrecedentProvenanceSchema.parse(input);
}
