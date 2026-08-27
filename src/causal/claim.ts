import { createHash } from "node:crypto";
import { z } from "zod";
import { QuantityUnitSchema } from "./variables.js";
import { UncertaintyRepresentationSchema } from "./estimator.js";
import { IdentificationStatusSchema } from "./identification.js";

export const CAUSAL_CLAIM_TYPES = [
  "POSITIVE_EFFECT",
  "NEGATIVE_EFFECT",
  "NO_MATERIAL_EFFECT_DETECTED",
  "PARTIALLY_IDENTIFIED",
  "INCONCLUSIVE",
] as const;

export const CausalClaimTypeSchema = z.enum(CAUSAL_CLAIM_TYPES);
export type CausalClaimType = z.infer<typeof CausalClaimTypeSchema>;

export const StatisticalEvidenceAssessmentSchema = z
  .object({
    clarity: z.enum(["CLEAR", "UNCERTAIN", "UNKNOWN"]),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export const BusinessMaterialityAssessmentSchema = z
  .object({
    materiality: z.enum(["MATERIAL", "IMMATERIAL", "UNKNOWN"]),
    threshold: z.number().finite(),
    absoluteEffect: z.number().finite().optional(),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export const GENERALIZABILITY_STATUSES = [
  "DIRECTLY_SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "EXTRAPOLATED",
  "NOT_SUPPORTED",
  "UNKNOWN",
] as const;

export const GeneralizabilityStatusSchema = z.enum(GENERALIZABILITY_STATUSES);
export type GeneralizabilityStatus = z.infer<
  typeof GeneralizabilityStatusSchema
>;

export const GeneralizabilityAssessmentSchema = z
  .object({
    status: GeneralizabilityStatusSchema,
    evidencePopulation: z.string().min(1),
    evidenceEnvironment: z.string().min(1),
    targetPopulation: z.string().min(1),
    targetEnvironment: z.string().min(1),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export type GeneralizabilityAssessment = z.infer<
  typeof GeneralizabilityAssessmentSchema
>;

export const CausalClaimCandidateSchema = z
  .object({
    claimId: z.string().min(1),
    claimVersion: z.number().int().positive(),
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    interventionVariableId: z.string().min(1),
    outcomeVariableId: z.string().min(1),
    claimType: CausalClaimTypeSchema,
    effectEstimate: z.number().finite().optional(),
    unit: QuantityUnitSchema.optional(),
    uncertainty: UncertaintyRepresentationSchema.optional(),
    identificationStatus: IdentificationStatusSchema,
    identificationStrategy: z.string().min(1),
    graphId: z.string().min(1),
    graphVersion: z.number().int().positive(),
    graphHash: z.string().min(1),
    identificationAnalysisId: z.string().min(1),
    evidenceSynthesisId: z.string().min(1).optional(),
    assumptionIds: z.array(z.string().min(1)).default([]),
    evidenceRefs: z.array(z.string().min(1)).default([]),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    timeScope: z.string().min(1),
    statisticalEvidenceAssessment: StatisticalEvidenceAssessmentSchema,
    businessMaterialityAssessment: BusinessMaterialityAssessmentSchema,
    generalizability: GeneralizabilityAssessmentSchema,
    limitations: z.array(z.string()).default([]),
    contradictoryEvidenceRefs: z.array(z.string().min(1)).default([]),
    claimHash: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalClaimCandidate = z.infer<typeof CausalClaimCandidateSchema>;

export function computeClaimHash(
  claim: Omit<CausalClaimCandidate, "claimHash">,
): string {
  const { claimId: _id, createdAt: _c, ...rest } = claim;
  return createHash("sha256")
    .update(JSON.stringify(rest), "utf8")
    .digest("hex");
}

export function withClaimHash(
  claim: Omit<CausalClaimCandidate, "claimHash">,
): CausalClaimCandidate {
  const claimHash = computeClaimHash(claim);
  return CausalClaimCandidateSchema.parse({ ...claim, claimHash });
}

export function mintClaimId(input: {
  causalQuestionId: string;
  claimVersion: number;
}): string {
  return `cc_${input.causalQuestionId}_v${input.claimVersion}`;
}

export function classifyClaimType(input: {
  identificationStatus: string;
  effectEstimate?: number;
  materialityThreshold: number;
  /** MIXED/CONTRADICTORY synthesis forbids directional claim types. */
  synthesisStatus?: string;
}): CausalClaimType {
  if (
    input.synthesisStatus === "MIXED" ||
    input.synthesisStatus === "CONTRADICTORY"
  ) {
    if (input.identificationStatus === "PARTIALLY_IDENTIFIED") {
      return "PARTIALLY_IDENTIFIED";
    }
    return "INCONCLUSIVE";
  }
  if (
    input.identificationStatus === "NOT_IDENTIFIED" ||
    input.identificationStatus === "INCONCLUSIVE"
  ) {
    return "INCONCLUSIVE";
  }
  if (input.identificationStatus === "PARTIALLY_IDENTIFIED") {
    return "PARTIALLY_IDENTIFIED";
  }
  if (input.effectEstimate === undefined) {
    return "INCONCLUSIVE";
  }
  const abs = Math.abs(input.effectEstimate);
  if (abs < input.materialityThreshold) {
    return "NO_MATERIAL_EFFECT_DETECTED";
  }
  return input.effectEstimate >= 0 ? "POSITIVE_EFFECT" : "NEGATIVE_EFFECT";
}

export function assessGeneralizability(input: {
  evidencePopulation: string;
  evidenceEnvironment: string;
  targetPopulation: string;
  targetEnvironment: string;
}): GeneralizabilityAssessment {
  const popMatch = input.evidencePopulation === input.targetPopulation;
  const envMatch = input.evidenceEnvironment === input.targetEnvironment;
  if (popMatch && envMatch) {
    return {
      status: "DIRECTLY_SUPPORTED",
      ...input,
      notes: ["Evidence scope matches question target"],
    };
  }
  if (popMatch || envMatch) {
    return {
      status: "PARTIALLY_SUPPORTED",
      ...input,
      notes: ["Partial scope overlap; not fully transportable"],
    };
  }
  return {
    status: "NOT_SUPPORTED",
    ...input,
    notes: [
      "Out-of-scope without transport evidence — fail conservative",
      "EXTRAPOLATED would require explicit transport assumptions",
    ],
  };
}

export function assessMateriality(input: {
  effectEstimate: number | undefined;
  threshold: number;
  se?: number;
}): {
  statistical: z.infer<typeof StatisticalEvidenceAssessmentSchema>;
  business: z.infer<typeof BusinessMaterialityAssessmentSchema>;
} {
  const statistical =
    input.effectEstimate === undefined
      ? {
          clarity: "UNKNOWN" as const,
          notes: ["No point estimate"],
        }
      : input.se !== undefined && input.se > Math.abs(input.effectEstimate)
        ? {
            clarity: "UNCERTAIN" as const,
            notes: ["SE exceeds absolute effect"],
          }
        : {
            clarity: "CLEAR" as const,
            notes: ["Point estimate available under estimator assumptions"],
          };
  const business =
    input.effectEstimate === undefined
      ? {
          materiality: "UNKNOWN" as const,
          threshold: input.threshold,
          notes: [],
        }
      : {
          materiality:
            Math.abs(input.effectEstimate) >= input.threshold
              ? ("MATERIAL" as const)
              : ("IMMATERIAL" as const),
          threshold: input.threshold,
          absoluteEffect: Math.abs(input.effectEstimate),
          notes: [
            "Materiality from CausalQuestion threshold — not model-chosen",
          ],
        };
  return { statistical, business };
}
