import { createHash } from "node:crypto";
import { z } from "zod";

export const CAUSAL_EVIDENCE_DESIGNS = [
  "RANDOMIZED_EXPERIMENT",
  "QUASI_EXPERIMENT",
  "OBSERVATIONAL",
  "TIME_SERIES",
  "PRE_POST",
  "EXTERNAL_REFERENCE",
  "UNKNOWN",
] as const;

export const CausalEvidenceDesignSchema = z.enum(CAUSAL_EVIDENCE_DESIGNS);
export type CausalEvidenceDesign = z.infer<typeof CausalEvidenceDesignSchema>;

export const CAUSAL_EVIDENCE_SOURCE_CLASSES = [
  "EXPERIMENT_EVIDENCE_BUNDLE",
  "OUTCOME_VERIFICATION",
  "SCENARIO_CALIBRATION",
  "OBSERVATIONAL_METRIC",
  "GOVERNED_PRECEDENT",
  "EXTERNAL_REFERENCE",
] as const;

export const CausalEvidenceSourceClassSchema = z.enum(
  CAUSAL_EVIDENCE_SOURCE_CLASSES,
);
export type CausalEvidenceSourceClass = z.infer<
  typeof CausalEvidenceSourceClassSchema
>;

export const CausalEvidenceReferenceSchema = z
  .object({
    evidenceRefId: z.string().min(1),
    sourceClass: CausalEvidenceSourceClassSchema,
    sourceId: z.string().min(1),
    sourceVersion: z.string().min(1).default("1"),
    evidenceHash: z.string().min(1),
    projectId: z.string().min(1),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    timeRange: z.string().min(1).default("UNKNOWN"),
    quality: z.enum(["VALIDATED", "PARTIAL", "DEGRADED", "UNKNOWN"]),
    evidenceDesign: CausalEvidenceDesignSchema,
    verificationRefs: z.array(z.string().min(1)).default([]),
    treatmentMean: z.number().finite().optional(),
    controlMean: z.number().finite().optional(),
    treatmentSampleCount: z.number().int().nonnegative().optional(),
    controlSampleCount: z.number().int().nonnegative().optional(),
    outcomeUnit: z.string().min(1).optional(),
    assignmentMethod: z.string().min(1).optional(),
    assignmentProvenance: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalEvidenceReference = z.infer<
  typeof CausalEvidenceReferenceSchema
>;

export function mintEvidenceRefId(input: {
  sourceClass: string;
  sourceId: string;
  evidenceHash: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `cev_${digest}`;
}
