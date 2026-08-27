import { createHash } from "node:crypto";
import type { ExperimentEvidenceQuality } from "./doctrine.js";
import type { ExperimentAssumptionBinding } from "./experiment.js";
import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentPlan } from "./plan.js";
import { ExperimentError } from "./errors.js";
import type {
  AssumptionEvidenceUpdateCandidate,
  ExperimentEvidenceBundle,
  HypothesisResult,
  MeasurementResult,
} from "./evidence.js";

export type AssumptionRevisionKind =
  | "NUMERIC_PROMOTION"
  | "WIDEN_INTERVAL"
  | "RETAIN_PRIOR"
  | "INSUFFICIENT_EVIDENCE";

/**
 * Resolve hypothesis outcomes from measurements + authoritative Phase 8 quality.
 * Caller/model suggested quality never authorizes SUPPORTED / NOT_SUPPORTED.
 */
export function resolveHypothesisOutcomes(input: {
  hypotheses: readonly { hypothesisId: string }[];
  measurementResults: readonly MeasurementResult[];
  authoritativeQuality: ExperimentEvidenceQuality;
  conclusivePhase8: boolean;
}): HypothesisResult[] {
  const quality = input.authoritativeQuality;

  return input.hypotheses.map((h) => {
    if (!input.conclusivePhase8) {
      return {
        hypothesisId: h.hypothesisId,
        outcome: "INCONCLUSIVE" as const,
        rationale:
          "Independent Phase 8 VERIFIED_SUCCESS binding required for SUPPORTED/NOT_SUPPORTED",
        evidenceQuality: quality,
      };
    }
    if (quality === "UNKNOWN" || quality === "DEGRADED") {
      return {
        hypothesisId: h.hypothesisId,
        outcome: "INCONCLUSIVE" as const,
        rationale: `Evidence quality ${quality} — cannot promote to SUPPORTED/NOT_SUPPORTED`,
        evidenceQuality: quality,
      };
    }
    const primary = input.measurementResults[0];
    if (!primary || primary.sampleCount === 0) {
      return {
        hypothesisId: h.hypothesisId,
        outcome: "INCONCLUSIVE" as const,
        rationale: "Insufficient sample",
        evidenceQuality: quality,
      };
    }
    if (primary.observedValue !== undefined && primary.observedValue >= 1.05) {
      return {
        hypothesisId: h.hypothesisId,
        outcome: "SUPPORTED" as const,
        rationale: "Observed effect meets success band with verified quality",
        evidenceQuality: quality,
      };
    }
    if (primary.observedValue !== undefined && primary.observedValue < 0.95) {
      return {
        hypothesisId: h.hypothesisId,
        outcome: "NOT_SUPPORTED" as const,
        rationale: "Observed effect meets failure band with verified quality",
        evidenceQuality: quality,
      };
    }
    return {
      hypothesisId: h.hypothesisId,
      outcome: "INCONCLUSIVE" as const,
      rationale: "Effect within inconclusive band",
      evidenceQuality: quality,
    };
  });
}

export function assertAssumptionBindingMatches(input: {
  binding: ExperimentAssumptionBinding;
  experiment: GovernedExperiment;
  plan: ExperimentPlan;
}): void {
  const { binding, experiment, plan } = input;
  if (binding.experimentId !== experiment.experimentId) {
    throw new ExperimentError(
      "ASSUMPTION_BINDING_INVALID",
      "Assumption binding experimentId mismatch",
      {
        bindingExperimentId: binding.experimentId,
        experimentId: experiment.experimentId,
      },
    );
  }
  if (
    !plan.hypotheses.some((h) => h.hypothesisId === binding.hypothesisId) &&
    !experiment.hypotheses.some((h) => h.hypothesisId === binding.hypothesisId)
  ) {
    throw new ExperimentError(
      "ASSUMPTION_BINDING_INVALID",
      "Assumption binding hypothesisId not present on experiment plan",
      { hypothesisId: binding.hypothesisId },
    );
  }
  if (
    experiment.sourceAssumptionIds.length > 0 &&
    !experiment.sourceAssumptionIds.includes(binding.assumptionId)
  ) {
    throw new ExperimentError(
      "ASSUMPTION_BINDING_INVALID",
      "Assumption binding substitutes an unbound source assumption",
      {
        assumptionId: binding.assumptionId,
        sourceAssumptionIds: experiment.sourceAssumptionIds,
      },
    );
  }
  if (
    experiment.sourceScenarioSetId &&
    binding.scenarioSetId &&
    binding.scenarioSetId !== experiment.sourceScenarioSetId
  ) {
    throw new ExperimentError(
      "ASSUMPTION_BINDING_INVALID",
      "Assumption binding scenario set substitution rejected",
      {
        bindingScenarioSetId: binding.scenarioSetId,
        sourceScenarioSetId: experiment.sourceScenarioSetId,
      },
    );
  }
  if (
    experiment.sourceScenarioSetVersion !== undefined &&
    binding.scenarioSetVersion !== undefined &&
    binding.scenarioSetVersion !== experiment.sourceScenarioSetVersion
  ) {
    throw new ExperimentError(
      "ASSUMPTION_BINDING_INVALID",
      "Assumption binding scenario set version substitution rejected",
    );
  }
  const planBinding = plan.assumptionBindings.find(
    (b) =>
      b.assumptionId === binding.assumptionId &&
      b.hypothesisId === binding.hypothesisId,
  );
  if (!planBinding) {
    throw new ExperimentError(
      "ASSUMPTION_BINDING_INVALID",
      "Assumption binding not present on current experiment plan",
    );
  }
}

export function selectAssumptionRevisionKind(input: {
  evidenceQuality: ExperimentEvidenceQuality;
  hypothesisOutcome: HypothesisResult["outcome"];
  hasObservedValue: boolean;
}): AssumptionRevisionKind {
  if (
    input.evidenceQuality === "UNKNOWN" ||
    input.evidenceQuality === "DEGRADED"
  ) {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (input.evidenceQuality === "PARTIAL") {
    return input.hasObservedValue ? "WIDEN_INTERVAL" : "RETAIN_PRIOR";
  }
  // VALIDATED — only conclusive hypothesis outcomes may promote numerically.
  if (input.hypothesisOutcome === "INCONCLUSIVE") {
    return "INSUFFICIENT_EVIDENCE";
  }
  if (
    (input.hypothesisOutcome === "SUPPORTED" ||
      input.hypothesisOutcome === "NOT_SUPPORTED") &&
    input.hasObservedValue
  ) {
    return "NUMERIC_PROMOTION";
  }
  return "RETAIN_PRIOR";
}

export function buildAssumptionUpdateCandidate(input: {
  experiment: GovernedExperiment;
  plan: ExperimentPlan;
  binding: ExperimentAssumptionBinding;
  evidenceBundle: ExperimentEvidenceBundle;
  hypothesisOutcome: HypothesisResult;
  primaryMeasurement?: MeasurementResult;
  outcomeVerificationIds: readonly string[];
  createdAt: string;
}): AssumptionEvidenceUpdateCandidate {
  assertAssumptionBindingMatches({
    binding: input.binding,
    experiment: input.experiment,
    plan: input.plan,
  });

  const revisionKind = selectAssumptionRevisionKind({
    evidenceQuality: input.evidenceBundle.qualityClassification,
    hypothesisOutcome: input.hypothesisOutcome.outcome,
    hasObservedValue: input.primaryMeasurement?.observedValue !== undefined,
  });

  const allowNumeric =
    revisionKind === "NUMERIC_PROMOTION" &&
    input.primaryMeasurement?.observedValue !== undefined;

  const allowWiden =
    revisionKind === "WIDEN_INTERVAL" &&
    input.primaryMeasurement?.observedValue !== undefined;

  const notesByKind: Record<AssumptionRevisionKind, string> = {
    NUMERIC_PROMOTION:
      "VALIDATED verified evidence — candidate numeric promotion only; Phase 16 re-analysis required; AssumptionSet immutable",
    WIDEN_INTERVAL:
      "PARTIAL verified evidence — widen interval / retain prior; no strong numeric promotion; Phase 16 re-analysis required",
    RETAIN_PRIOR:
      "Retain prior assumption; Phase 16 re-analysis required; AssumptionSet immutable",
    INSUFFICIENT_EVIDENCE:
      "Insufficient or inconclusive verified evidence — no unjustified assumption value update; Phase 16 re-analysis required",
  };

  const base = {
    candidateId: mintCandidateId({
      experimentId: input.experiment.experimentId,
      assumptionId: input.binding.assumptionId,
      evidenceBundleId: input.evidenceBundle.evidenceBundleId,
    }),
    candidateCreationVersion: 1 as const,
    experimentId: input.experiment.experimentId,
    experimentVersion: input.experiment.experimentVersion,
    experimentPlanHash: input.plan.experimentPlanHash,
    hypothesisId: input.binding.hypothesisId,
    sourceAssumptionId: input.binding.assumptionId,
    assumptionId: input.binding.assumptionId,
    ...(input.binding.scenarioSetId
      ? { sourceAssumptionSetId: input.binding.scenarioSetId }
      : input.experiment.sourceScenarioSetId
        ? { sourceAssumptionSetId: input.experiment.sourceScenarioSetId }
        : {}),
    ...(input.binding.scenarioSetVersion !== undefined
      ? { sourceAssumptionSetVersion: input.binding.scenarioSetVersion }
      : input.experiment.sourceScenarioSetVersion !== undefined
        ? {
            sourceAssumptionSetVersion:
              input.experiment.sourceScenarioSetVersion,
          }
        : {}),
    ...(input.experiment.sourceAssumptionSetHash
      ? {
          sourceAssumptionSetHash: input.experiment.sourceAssumptionSetHash,
          priorAssumptionSetHash: input.experiment.sourceAssumptionSetHash,
        }
      : {}),
    evidenceBundleId: input.evidenceBundle.evidenceBundleId,
    evidenceBundleHash: input.evidenceBundle.evidenceBundleHash,
    outcomeVerificationIds: [...input.outcomeVerificationIds],
    evidenceQuality: input.evidenceBundle.qualityClassification,
    revisionKind,
    ...(allowNumeric
      ? {
          proposedValue: input.primaryMeasurement!.observedValue,
          ...(input.primaryMeasurement!.unit
            ? { proposedUnit: input.primaryMeasurement!.unit }
            : {}),
        }
      : {}),
    ...(allowWiden && input.primaryMeasurement?.observedValue !== undefined
      ? {
          proposedLowerBound: input.primaryMeasurement.observedValue * 0.9,
          proposedUpperBound: input.primaryMeasurement.observedValue * 1.1,
          ...(input.primaryMeasurement.unit
            ? { proposedUnit: input.primaryMeasurement.unit }
            : {}),
        }
      : {}),
    requiresPhase16Reanalysis: true as const,
    notes: notesByKind[revisionKind],
    createdAt: input.createdAt,
  };

  return withCandidateHash(base);
}

function mintCandidateId(input: {
  experimentId: string;
  assumptionId: string;
  evidenceBundleId: string;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex")
    .slice(0, 16);
  return `aeuc_${digest}`;
}

export function computeAssumptionUpdateCandidateHash(
  candidate: Omit<AssumptionEvidenceUpdateCandidate, "candidateHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        assumptionId: candidate.assumptionId,
        candidateCreationVersion: candidate.candidateCreationVersion,
        candidateId: candidate.candidateId,
        createdAt: candidate.createdAt,
        evidenceBundleHash: candidate.evidenceBundleHash,
        evidenceBundleId: candidate.evidenceBundleId,
        evidenceQuality: candidate.evidenceQuality,
        experimentId: candidate.experimentId,
        experimentPlanHash: candidate.experimentPlanHash,
        experimentVersion: candidate.experimentVersion,
        hypothesisId: candidate.hypothesisId,
        notes: candidate.notes,
        outcomeVerificationIds: [...candidate.outcomeVerificationIds].sort(),
        priorAssumptionSetHash: candidate.priorAssumptionSetHash,
        proposedLowerBound: candidate.proposedLowerBound,
        proposedUnit: candidate.proposedUnit,
        proposedUpperBound: candidate.proposedUpperBound,
        proposedValue: candidate.proposedValue,
        requiresPhase16Reanalysis: candidate.requiresPhase16Reanalysis,
        revisionKind: candidate.revisionKind,
        sourceAssumptionId: candidate.sourceAssumptionId,
        sourceAssumptionSetHash: candidate.sourceAssumptionSetHash,
        sourceAssumptionSetId: candidate.sourceAssumptionSetId,
        sourceAssumptionSetVersion: candidate.sourceAssumptionSetVersion,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withCandidateHash(
  candidate: Omit<AssumptionEvidenceUpdateCandidate, "candidateHash">,
): AssumptionEvidenceUpdateCandidate {
  return {
    ...candidate,
    candidateHash: computeAssumptionUpdateCandidateHash(candidate),
  };
}
