import { z } from "zod";

export const MemoryQualityFindingCategorySchema = z.enum([
  "WEAK_PROVENANCE",
  "OVERGENERALIZED_SCOPE",
  "INSUFFICIENT_CORROBORATION",
  "CONTRADICTED",
  "STALE_CONTEXT",
  "EVIDENCE_GAP",
  "AUTHORITY_LIKE_LANGUAGE",
  "DUPLICATE_PRECEDENT",
]);
export type MemoryQualityFindingCategory = z.infer<
  typeof MemoryQualityFindingCategorySchema
>;

export const MemoryQualityFindingSeveritySchema = z.enum([
  "INFO",
  "WARNING",
  "BLOCKING",
]);
export type MemoryQualityFindingSeverity = z.infer<
  typeof MemoryQualityFindingSeveritySchema
>;

export const MemoryQualityFindingSchema = z
  .object({
    findingId: z.string().min(1),
    category: MemoryQualityFindingCategorySchema,
    severity: MemoryQualityFindingSeveritySchema,
    message: z.string().min(1),
    relatedCandidateId: z.string().min(1).optional(),
    relatedPrecedentId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type MemoryQualityFinding = z.infer<typeof MemoryQualityFindingSchema>;

export function parseMemoryQualityFinding(
  input: unknown,
): MemoryQualityFinding {
  return MemoryQualityFindingSchema.parse(input);
}
