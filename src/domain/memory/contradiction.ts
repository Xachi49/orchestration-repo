import { z } from "zod";

export const ContradictionClassificationSchema = z.enum([
  "NO_CONTRADICTION",
  "POTENTIAL_CONTRADICTION",
  "HARD_CONTRADICTION",
]);
export type ContradictionClassification = z.infer<
  typeof ContradictionClassificationSchema
>;

export const ContradictionResolutionStatusSchema = z.enum([
  "OPEN",
  "RESOLVED_BY_SUPERSESSION",
  "RESOLVED_BY_SCOPE_NARROWING",
  "ACCEPTED_CONTEXTUAL_DIFFERENCE",
]);
export type ContradictionResolutionStatus = z.infer<
  typeof ContradictionResolutionStatusSchema
>;

export const PrecedentContradictionRecordSchema = z
  .object({
    contradictionId: z.string().min(1),
    /** Precedents involved (may be one when contradicted by a candidate). */
    precedentIds: z.array(z.string().min(1)).default([]),
    candidateIds: z.array(z.string()).default([]),
    applicabilityOverlap: z.array(z.string()).default([]),
    classification: ContradictionClassificationSchema,
    supportingEvidenceRefs: z.array(z.string()).default([]),
    detectedAt: z.string().datetime(),
    resolutionStatus: ContradictionResolutionStatusSchema.default("OPEN"),
    note: z.string().optional(),
  })
  .strict()
  .refine(
    (r) => r.precedentIds.length + r.candidateIds.length >= 2,
    {
      message: "Contradiction requires at least two involved identities",
    },
  );

export type PrecedentContradictionRecord = z.infer<
  typeof PrecedentContradictionRecordSchema
>;

export function parsePrecedentContradictionRecord(
  input: unknown,
): PrecedentContradictionRecord {
  return PrecedentContradictionRecordSchema.parse(input);
}
