import { z } from "zod";
import { hashCanonical } from "../../ingestion/hashing.js";
import { HistoricalOutcomeSchema } from "./historical-run.js";

const ClaimCandidateTypeSchema = z.enum([
  "SUCCESS_PATTERN",
  "FAILURE_PATTERN",
  "CONTAINMENT_PATTERN",
  "RESOURCE_PATTERN",
  "DEPENDENCY_PATTERN",
  "PROCESS_PATTERN",
  "SECURITY_PATTERN",
  "VERIFICATION_PATTERN",
  "EVIDENCE_GAP_PATTERN",
]);

/**
 * Immutable origin of a LearningCandidate.
 * Never inferred later from metadata. Participates in candidateHash.
 */
export const CandidateOriginSchema = z.enum([
  "DETERMINISTIC_EXTRACTION",
  "MODEL_SUGGESTION",
]);
export type CandidateOrigin = z.infer<typeof CandidateOriginSchema>;

export const ClaimGroundingVerdictSchema = z.enum([
  "DETERMINISTICALLY_GROUNDED",
  "PARTIALLY_GROUNDED",
  "UNGROUNDED",
  "REQUIRES_HUMAN_REVIEW",
]);
export type ClaimGroundingVerdict = z.infer<typeof ClaimGroundingVerdictSchema>;

export const ClaimPolaritySchema = z.enum([
  "POSITIVE",
  "NEGATIVE",
  "UNCERTAIN",
  "PROCESS",
]);
export type ClaimPolarity = z.infer<typeof ClaimPolaritySchema>;

export const ClaimGroundingResultSchema = z
  .object({
    verdict: ClaimGroundingVerdictSchema,
    reasons: z.array(z.string()),
    matchedFactKeys: z.array(z.string()).default([]),
  })
  .strict();
export type ClaimGroundingResult = z.infer<typeof ClaimGroundingResultSchema>;

/**
 * Bounded semantic facts for a candidate type the extractor can prove.
 * Promotion evaluates this claim — not free-form prose.
 * PROVENANCE != CLAIM GROUNDING
 */
export const LearningClaimSchema = z
  .object({
    candidateType: ClaimCandidateTypeSchema,
    observedOutcome: HistoricalOutcomeSchema,
    polarity: ClaimPolaritySchema,
    planHash: z.string().min(1).optional(),
    actionTypes: z.array(z.string()).default([]),
    capabilityIds: z.array(z.string()).default([]),
    verificationMethods: z.array(z.string()).default([]),
    criterionIds: z.array(z.string()).default([]),
    criterionVerdicts: z.array(z.string()).default([]),
    findingIds: z.array(z.string()).default([]),
    evidenceRefs: z.array(z.string()).default([]),
    containmentReason: z.string().min(1).optional(),
    resourceObservation: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();
export type LearningClaim = z.infer<typeof LearningClaimSchema>;

export function parseLearningClaim(input: unknown): LearningClaim {
  return LearningClaimSchema.parse(input);
}

export function parseClaimGroundingResult(
  input: unknown,
): ClaimGroundingResult {
  return ClaimGroundingResultSchema.parse(input);
}

/**
 * Canonical identity for contradiction matching.
 * Wording differences in `statement` do not change this key.
 */
export function claimIdentityKey(claim: LearningClaim): string {
  return hashCanonical({
    candidateType: claim.candidateType,
    observedOutcome: claim.observedOutcome,
    polarity: claim.polarity,
    planHash: claim.planHash ?? null,
    actionTypes: [...claim.actionTypes].sort(),
    capabilityIds: [...claim.capabilityIds].sort(),
    verificationMethods: [...claim.verificationMethods].sort(),
    criterionIds: [...claim.criterionIds].sort(),
    criterionVerdicts: [...claim.criterionVerdicts].sort(),
    findingIds: [...claim.findingIds].sort(),
    containmentReason: claim.containmentReason ?? null,
    resourceObservation: claim.resourceObservation ?? null,
  });
}

export function polarityForCandidateType(
  candidateType: z.infer<typeof ClaimCandidateTypeSchema>,
  criterionVerdicts: readonly string[] = [],
): ClaimPolarity {
  switch (candidateType) {
    case "SUCCESS_PATTERN":
      return "POSITIVE";
    case "FAILURE_PATTERN":
    case "CONTAINMENT_PATTERN":
    case "EVIDENCE_GAP_PATTERN":
    case "SECURITY_PATTERN":
      return "NEGATIVE";
    case "PROCESS_PATTERN":
      return "PROCESS";
    case "RESOURCE_PATTERN":
      return "POSITIVE";
    case "DEPENDENCY_PATTERN":
      return "PROCESS";
    case "VERIFICATION_PATTERN":
      if (criterionVerdicts.some((v) => v === "UNSATISFIED")) {
        return "NEGATIVE";
      }
      if (criterionVerdicts.some((v) => v === "INCONCLUSIVE")) {
        return "UNCERTAIN";
      }
      if (criterionVerdicts.every((v) => v === "SATISFIED") && criterionVerdicts.length > 0) {
        return "POSITIVE";
      }
      return "UNCERTAIN";
    default:
      return "UNCERTAIN";
  }
}

/**
 * Human-readable statement derived from structured claim.
 * Display material — not the sole authoritative representation.
 */
export function renderClaimStatement(claim: LearningClaim): string {
  const actions =
    claim.actionTypes.length > 0
      ? ` actions=${claim.actionTypes.join(",")}`
      : "";
  switch (claim.candidateType) {
    case "SUCCESS_PATTERN":
      return `Deterministic success claim: planHash=${claim.planHash ?? "unknown"} observed ${claim.observedOutcome}.${actions}`;
    case "FAILURE_PATTERN": {
      const criteria =
        claim.criterionIds.length > 0
          ? ` criteria=${claim.criterionIds.join(",")}`
          : "";
      const findings =
        claim.findingIds.length > 0
          ? ` findings=${claim.findingIds.join(",")}`
          : "";
      return `Deterministic failure claim: outcome=${claim.observedOutcome}.${criteria}${findings}`;
    }
    case "CONTAINMENT_PATTERN":
      return `Deterministic containment claim: reason=${claim.containmentReason ?? claim.observedOutcome}.`;
    case "RESOURCE_PATTERN": {
      const obs = claim.resourceObservation
        ? JSON.stringify(claim.resourceObservation)
        : "{}";
      return `Deterministic resource claim: ${obs}`;
    }
    case "VERIFICATION_PATTERN": {
      const methods =
        claim.verificationMethods.length > 0
          ? claim.verificationMethods.join(",")
          : "unspecified";
      const criteria =
        claim.criterionIds.length > 0
          ? ` criteria=${claim.criterionIds.join(",")}`
          : "";
      return `Deterministic verification claim: methods=${methods}${criteria} outcome=${claim.observedOutcome}.`;
    }
    case "EVIDENCE_GAP_PATTERN": {
      const criteria =
        claim.criterionIds.length > 0
          ? claim.criterionIds.join(",")
          : "unspecified";
      return `Deterministic evidence-gap claim: criteria=${criteria} outcome=${claim.observedOutcome}.`;
    }
    case "PROCESS_PATTERN":
      return `Deterministic process claim: governance terminal ${claim.observedOutcome}.`;
    case "DEPENDENCY_PATTERN":
      return `Deterministic dependency claim: outcome=${claim.observedOutcome}.${actions}`;
    case "SECURITY_PATTERN":
      return `Deterministic security claim: outcome=${claim.observedOutcome}.`;
    default:
      return `Deterministic claim: type=${claim.candidateType} outcome=${claim.observedOutcome}.`;
  }
}
