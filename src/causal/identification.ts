import { createHash } from "node:crypto";
import { z } from "zod";

export const IDENTIFICATION_STATUSES = [
  "IDENTIFIED",
  "PARTIALLY_IDENTIFIED",
  "NOT_IDENTIFIED",
  "INCONCLUSIVE",
] as const;

export const IdentificationStatusSchema = z.enum(IDENTIFICATION_STATUSES);
export type IdentificationStatus = z.infer<typeof IdentificationStatusSchema>;

export const IDENTIFICATION_STRATEGIES = [
  "RANDOMIZED_TREATMENT",
  "BACKDOOR_ADJUSTMENT",
  "UNIDENTIFIED",
] as const;

export const IdentificationStrategySchema = z.enum(IDENTIFICATION_STRATEGIES);
export type IdentificationStrategy = z.infer<
  typeof IdentificationStrategySchema
>;

export const ASSUMPTION_STATUSES = [
  "SUPPORTED",
  "PLAUSIBLE",
  "UNVERIFIED",
  "VIOLATED",
  "UNKNOWN",
] as const;

export const IdentificationAssumptionStatusSchema = z.enum(ASSUMPTION_STATUSES);
export type IdentificationAssumptionStatus = z.infer<
  typeof IdentificationAssumptionStatusSchema
>;

export const IdentificationAssumptionSchema = z
  .object({
    assumptionId: z.string().min(1),
    statement: z.string().min(1).max(4000),
    status: IdentificationAssumptionStatusSchema,
    evidenceRefs: z.array(z.string().min(1)).default([]),
    riskIfViolated: z.enum(["LOW", "MEDIUM", "HIGH"]),
    testability: z.enum(["TESTABLE", "PARTIALLY_TESTABLE", "UNTESTABLE"]),
    materiality: z.enum(["LOW", "MEDIUM", "HIGH"]),
  })
  .strict();

export type IdentificationAssumption = z.infer<
  typeof IdentificationAssumptionSchema
>;

export const CausalIdentificationAnalysisSchema = z
  .object({
    identificationAnalysisId: z.string().min(1),
    causalQuestionId: z.string().min(1),
    causalQuestionVersion: z.number().int().positive(),
    causalGraphId: z.string().min(1),
    causalGraphVersion: z.number().int().positive(),
    graphHash: z.string().min(1),
    strategy: IdentificationStrategySchema,
    status: IdentificationStatusSchema,
    adjustmentSet: z.array(z.string().min(1)).default([]),
    adjustmentJustification: z.string().max(4000).optional(),
    assumptions: z.array(IdentificationAssumptionSchema).default([]),
    evidenceRefIds: z.array(z.string().min(1)).default([]),
    estimatorVersion: z.string().min(1).default("difference_in_means_v1"),
    populationScope: z.string().min(1),
    environmentScope: z.string().min(1),
    identificationFingerprint: z.string().min(1),
    limitations: z.array(z.string()).default([]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type CausalIdentificationAnalysis = z.infer<
  typeof CausalIdentificationAnalysisSchema
>;

export function computeIdentificationFingerprint(input: {
  causalQuestionId: string;
  causalQuestionVersion: number;
  graphHash: string;
  intervention: string;
  outcome: string;
  adjustmentSet: readonly string[];
  strategy: string;
  assumptions: readonly IdentificationAssumption[];
  evidenceIdentities: readonly string[];
  population: string;
  environment: string;
  estimatorVersion: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        causalQuestionId: input.causalQuestionId,
        causalQuestionVersion: input.causalQuestionVersion,
        graphHash: input.graphHash,
        intervention: input.intervention,
        outcome: input.outcome,
        adjustmentSet: [...input.adjustmentSet].sort(),
        strategy: input.strategy,
        assumptions: input.assumptions.map((a) => ({
          assumptionId: a.assumptionId,
          status: a.status,
          statement: a.statement,
        })),
        evidenceIdentities: [...input.evidenceIdentities].sort(),
        population: input.population,
        environment: input.environment,
        estimatorVersion: input.estimatorVersion,
      }),
      "utf8",
    )
    .digest("hex");
}

export function mintIdentificationAnalysisId(input: {
  causalQuestionId: string;
  fingerprint: string;
}): string {
  return `cia_${input.causalQuestionId}_${input.fingerprint.slice(0, 12)}`;
}

/** PLAUSIBLE must never be translated into TRUE. */
export function assumptionIsAuthoritativelySupported(
  status: IdentificationAssumptionStatus,
): boolean {
  return status === "SUPPORTED";
}
