import { randomUUID } from "node:crypto";
import { z } from "zod";

export const FINDING_SEVERITIES = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "INFORMATIONAL",
] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const AssuranceFindingSchema = z
  .object({
    findingId: z.string().min(1),
    assuranceRunId: z.string().min(1),
    controlId: z.string().min(1).optional(),
    severity: z.enum(FINDING_SEVERITIES),
    code: z.string().min(1),
    summary: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)).default([]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AssuranceFinding = z.infer<typeof AssuranceFindingSchema>;

export function mintFindingId(): string {
  return `afind_${randomUUID()}`;
}

export function createFinding(
  input: Omit<AssuranceFinding, "findingId"> & { findingId?: string },
): AssuranceFinding {
  return AssuranceFindingSchema.parse({
    ...input,
    findingId: input.findingId ?? mintFindingId(),
    evidenceIds: input.evidenceIds ?? [],
  });
}
