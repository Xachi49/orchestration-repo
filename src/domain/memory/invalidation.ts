import { z } from "zod";

export const PrecedentInvalidationReasonSchema = z.enum([
  "SOURCE_EVIDENCE_CORRUPT",
  "SOURCE_OUTCOME_RETRACTED",
  "PROVENANCE_TAMPERED",
  "AUTHORITY_MISMATCH",
  "MANUAL_RETIREMENT",
]);
export type PrecedentInvalidationReason = z.infer<
  typeof PrecedentInvalidationReasonSchema
>;

/**
 * Invalidation does not rewrite source history.
 * Precedents are RETIRED (or superseded) with an explicit record.
 */
export const PrecedentInvalidationRecordSchema = z
  .object({
    invalidationId: z.string().min(1),
    precedentId: z.string().min(1),
    precedentVersion: z.number().int().positive(),
    reason: PrecedentInvalidationReasonSchema,
    details: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type PrecedentInvalidationRecord = z.infer<
  typeof PrecedentInvalidationRecordSchema
>;

export function parsePrecedentInvalidationRecord(
  input: unknown,
): PrecedentInvalidationRecord {
  return PrecedentInvalidationRecordSchema.parse(input);
}
