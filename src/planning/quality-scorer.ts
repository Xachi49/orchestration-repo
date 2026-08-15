import type { PlanProposal } from "./proposal.js";
import type { PlanningContext } from "./context.js";
import { PlanningError } from "./errors.js";

export interface PlanQualityScore {
  overallScore: number;
  dimensionScores: Readonly<Record<string, number>>;
  blockingDeficiencies: readonly string[];
}

export interface PlanQualityScorerConfig {
  minimumOverallScore: number;
}

export const DEFAULT_QUALITY_CONFIG: PlanQualityScorerConfig = {
  minimumOverallScore: 0.7,
};

/**
 * Structural quality signal only — does not prove plan correctness.
 */
export class PlanQualityScorer {
  score(
    proposal: PlanProposal,
    context: PlanningContext,
    config: PlanQualityScorerConfig = DEFAULT_QUALITY_CONFIG,
  ): PlanQualityScore {
    const blocking: string[] = [];
    const criteria = context.objective.acceptanceCriteria;
    const covered = proposal.gapAnalysis.acceptanceCriteriaCoverage.filter(
      (item) => item.covered,
    ).length;
    const acceptanceCriteriaCoverage =
      criteria.length === 0 ? 1 : covered / criteria.length;
    if (acceptanceCriteriaCoverage < 0.5) {
      blocking.push("Insufficient acceptance criteria coverage");
    }

    const allRefs = new Set(
      proposal.steps.flatMap((step) => step.evidenceRefs),
    );
    const evidenceCoverage =
      context.contextMetadata.selectedEvidenceIds.length === 0
        ? 1
        : Math.min(
            1,
            allRefs.size /
              Math.max(1, context.contextMetadata.selectedEvidenceIds.length),
          );

    const dependencyCompleteness = proposal.steps.every((step) =>
      step.dependsOn.every((dep) =>
        proposal.steps.some((other) => other.stepId === dep),
      ),
    )
      ? 1
      : 0;

    const verificationCompleteness = proposal.steps.every(
      (step) => step.validationChecks.length > 0,
    )
      ? 1
      : 0;
    if (verificationCompleteness < 1) {
      blocking.push("Missing verification checks on one or more steps");
    }

    const rollbackCompleteness = proposal.steps.every(
      (step) =>
        step.rollbackStrategy === "NONE" ||
        (step.rollbackInstructions?.length ?? 0) > 0 ||
        step.rollbackStrategy === "MANUAL",
    )
      ? proposal.proposedRollbackApproach.length > 0
        ? 1
        : 0.5
      : 0;
    if (rollbackCompleteness < 0.5) {
      blocking.push("Missing rollback/containment approach");
    }

    const resourceEstimateCompleteness = proposal.steps.every(
      (step) =>
        step.resourceEstimate.durationMs !== undefined ||
        step.resourceEstimate.tokenEstimate !== undefined ||
        step.resourceEstimate.costEstimateUsd !== undefined,
    )
      ? 1
      : 0.4;

    const unknownDisclosure =
      proposal.unknowns.length > 0 || proposal.assumptions.length > 0 ? 1 : 0.6;

    const capabilityValidity = 1;

    const dimensionScores = {
      acceptanceCriteriaCoverage,
      evidenceCoverage,
      dependencyCompleteness,
      verificationCompleteness,
      rollbackCompleteness,
      resourceEstimateCompleteness,
      unknownDisclosure,
      capabilityValidity,
    };

    const values = Object.values(dimensionScores);
    const overallScore =
      values.reduce((sum, value) => sum + value, 0) / values.length;

    if (blocking.length > 0 || overallScore < config.minimumOverallScore) {
      throw new PlanningError(
        "PLAN_QUALITY_BELOW_THRESHOLD",
        "Plan structural quality is below threshold",
        {
          overallScore,
          minimumOverallScore: config.minimumOverallScore,
          blockingDeficiencies: blocking,
        },
      );
    }

    return {
      overallScore,
      dimensionScores,
      blockingDeficiencies: blocking,
    };
  }
}
