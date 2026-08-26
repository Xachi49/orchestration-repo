import { z } from "zod";

/**
 * Evidence authority classes for Portfolio analysis.
 * Model input must never be confused with Control Plane or completion truth.
 */
export const PORTFOLIO_EVIDENCE_AUTHORITY_CLASSES = [
  "CURRENT_CONTROL_PLANE_TRUTH",
  "PROGRAM_VERIFIED_OUTCOME",
  "PROGRAM_COMPLETION_AUTHORITY",
  "OBSERVATIONAL_METRIC",
  "GOVERNED_PRECEDENT",
  "UNTRUSTED_MODEL_INPUT",
] as const;

export const PortfolioEvidenceAuthorityClassSchema = z.enum(
  PORTFOLIO_EVIDENCE_AUTHORITY_CLASSES,
);
export type PortfolioEvidenceAuthorityClass = z.infer<
  typeof PortfolioEvidenceAuthorityClassSchema
>;

export const LabeledEvidenceSchema = z
  .object({
    authorityClass: PortfolioEvidenceAuthorityClassSchema,
    label: z.string().min(1),
    payload: z.unknown(),
  })
  .strict();

export type LabeledEvidence = z.infer<typeof LabeledEvidenceSchema>;

export const PortfolioAnalysisContextSchema = z
  .object({
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    evidence: z.array(LabeledEvidenceSchema),
    builtAt: z.string().datetime(),
  })
  .strict();

export type PortfolioAnalysisContext = z.infer<
  typeof PortfolioAnalysisContextSchema
>;

export function labelEvidence(
  authorityClass: PortfolioEvidenceAuthorityClass,
  label: string,
  payload: unknown,
): LabeledEvidence {
  return { authorityClass, label, payload };
}
