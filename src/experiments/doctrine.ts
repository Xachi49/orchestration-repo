import { z } from "zod";

/**
 * Experiments produce evidence; they do not produce authority.
 */
export const EXPERIMENT_DOCTRINE = {
  uncertaintyNotPermission: "Uncertainty != Permission",
  proposalNotAuthorization: "ExperimentProposal != ExperimentAuthorization",
  authorizationNotExecution:
    "ExperimentAuthorization != ExecutionAuthorization",
  observedNotVerified: "ObservedResult != VerifiedEvidence",
  verifiedNotPolicy: "VerifiedEvidence != Policy",
  informationGainNotDecision: "InformationGain != StrategicDecision",
  learningNotSelfModification: "Learning != AutonomousSelfModification",
  experimentsProduceEvidenceNotAuthority:
    "Experiments produce evidence. They do not produce authority.",
} as const;

export const EXPERIMENT_EVIDENCE_QUALITY = [
  "VALIDATED",
  "PARTIAL",
  "DEGRADED",
  "UNKNOWN",
] as const;

export const ExperimentEvidenceQualitySchema = z.enum(
  EXPERIMENT_EVIDENCE_QUALITY,
);
export type ExperimentEvidenceQuality = z.infer<
  typeof ExperimentEvidenceQualitySchema
>;

export const HYPOTHESIS_OUTCOMES = [
  "SUPPORTED",
  "NOT_SUPPORTED",
  "INCONCLUSIVE",
] as const;

export const HypothesisOutcomeSchema = z.enum(HYPOTHESIS_OUTCOMES);
export type HypothesisOutcome = z.infer<typeof HypothesisOutcomeSchema>;

export const EXPERIMENT_FAILURE_REASONS = [
  "EXECUTION_FAILED",
  "MEASUREMENT_FAILED",
  "INSUFFICIENT_SAMPLE",
  "LOW_EVIDENCE_QUALITY",
  "AUTHORITY_DRIFT",
  "SAFETY_STOP",
  "BUDGET_EXHAUSTED",
  "HYPOTHESIS_NOT_SUPPORTED",
  "INCONCLUSIVE",
  "MULTIPLE_TESTING_UNADJUSTED",
] as const;

export const ExperimentFailureReasonSchema = z.enum(EXPERIMENT_FAILURE_REASONS);
export type ExperimentFailureReason = z.infer<
  typeof ExperimentFailureReasonSchema
>;
