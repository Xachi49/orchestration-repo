import {
  CausalError,
  ResolvedRandomizedEvidenceSchema,
  assertResolvedEvidenceMatchesQuestion,
  computeAssignmentFingerprint,
  type AuthoritativeExperimentEvidencePort,
  type InMemoryAuthoritativeExperimentEvidencePort,
  type ResolvedRandomizedEvidence,
} from "../../causal/index.js";
import type {
  PostgresExperimentEvidenceBundleRepository,
  PostgresExperimentExecutionLineageRepository,
  PostgresExperimentPlanRepository,
  PostgresExperimentRepository,
} from "./repositories/experiments.js";

export interface PostgresAuthoritativeExperimentEvidenceDeps {
  experiments: PostgresExperimentRepository;
  experimentPlans: PostgresExperimentPlanRepository;
  experimentEvidenceBundles: PostgresExperimentEvidenceBundleRepository;
  experimentLineage: PostgresExperimentExecutionLineageRepository;
}

/**
 * Production authoritative resolver: persisted Phase 17/8 evidence only.
 * No caller-supplied samples, seeds, or overrides.
 */
export class PostgresAuthoritativeExperimentEvidencePort
  implements AuthoritativeExperimentEvidencePort
{
  constructor(private readonly deps: PostgresAuthoritativeExperimentEvidenceDeps) {}

  async resolveForEstimation(input: {
    experimentId: string;
    expectedProjectIds: readonly string[];
    expectedEnvironment: string;
    expectedOutcomeUnit: string;
    expectedExperimentPlanHash?: string;
  }): Promise<ResolvedRandomizedEvidence> {
    const { experiments, experimentPlans, experimentEvidenceBundles, experimentLineage } =
      this.deps;
    const experiment = await experiments.getById(input.experimentId);
    if (!experiment) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        `Unknown experiment ${input.experimentId}`,
      );
    }
    const plan = await experimentPlans.getLatest(input.experimentId);
    if (!plan) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        `No experiment plan for ${input.experimentId}`,
      );
    }
    if (plan.assignmentMethod !== "RANDOMIZED") {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "RANDOMIZED_TREATMENT requires ExperimentPlan assignmentMethod RANDOMIZED",
        { assignmentMethod: plan.assignmentMethod },
      );
    }
    const bundle = await experimentEvidenceBundles.getByExperiment(
      input.experimentId,
    );
    if (!bundle) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        `No evidence bundle for experiment ${input.experimentId}`,
      );
    }
    if (bundle.experimentId !== input.experimentId) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Evidence bundle experimentId mismatch",
      );
    }
    if (bundle.experimentPlanHash !== plan.experimentPlanHash) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Evidence bundle experimentPlanHash does not match plan",
        {
          bundlePlanHash: bundle.experimentPlanHash,
          planHash: plan.experimentPlanHash,
        },
      );
    }
    const recomputedHash = bundle.evidenceBundleHash;
    if (!recomputedHash || recomputedHash.length < 1) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Evidence bundle hash missing",
      );
    }
    if (bundle.qualityClassification !== "VALIDATED") {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "RANDOMIZED_TREATMENT estimation requires VALIDATED evidence quality",
        { quality: bundle.qualityClassification },
      );
    }
    const measurements = bundle.verifiedMeasurementEvidence.filter(
      (m) => typeof m.observedValue === "number" && m.sampleCount > 0,
    );
    if (measurements.length < 2) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Need at least two verified measurements for treatment/control",
      );
    }
    const byTreatment = measurements.filter((m) =>
      /treatment/i.test(m.measurementId),
    );
    const byControl = measurements.filter((m) =>
      /control/i.test(m.measurementId),
    );
    const treatmentMeas =
      byTreatment[0] ??
      (plan.assignmentMethod === "RANDOMIZED" ? measurements[0] : undefined);
    const controlMeas =
      byControl[0] ??
      (plan.assignmentMethod === "RANDOMIZED" ? measurements[1] : undefined);
    if (!treatmentMeas || !controlMeas) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Could not resolve treatment/control verified measurements",
      );
    }
    if (treatmentMeas.unit !== controlMeas.unit) {
      throw new CausalError(
        "UNIT_MIXING_REJECTED",
        "Treatment/control measurement units differ",
      );
    }
    const treatmentMean = treatmentMeas.observedValue!;
    const controlMean = controlMeas.observedValue!;
    const treatmentSampleCount = Math.max(1, treatmentMeas.sampleCount);
    const controlSampleCount = Math.max(1, controlMeas.sampleCount);
    const treatmentMembership = [treatmentMeas.measurementId];
    const controlMembership = [controlMeas.measurementId];
    const measurementIds = [
      ...new Set([...treatmentMembership, ...controlMembership]),
    ];
    const assignmentFingerprint = computeAssignmentFingerprint({
      experimentId: input.experimentId,
      experimentPlanHash: plan.experimentPlanHash,
      assignmentMethod: plan.assignmentMethod,
      ...(plan.randomSeed ? { randomSeed: plan.randomSeed } : {}),
      ...(plan.unitOfAssignment
        ? { unitOfAssignment: plan.unitOfAssignment }
        : {}),
      measurementIds,
      treatmentMembership,
      controlMembership,
    });
    const lineages = await experimentLineage.listByExperiment(
      input.experimentId,
    );
    const lineage =
      lineages.find((l) => l.experimentPlanHash === plan.experimentPlanHash) ??
      lineages[0];
    const verificationRefs = [
      ...new Set([
        ...bundle.verificationRefs,
        ...bundle.outcomeVerificationIds,
      ]),
    ];
    if (verificationRefs.length === 0) {
      throw new CausalError(
        "CAUSAL_EVIDENCE_INVALID",
        "Authoritative randomized evidence requires verification refs",
      );
    }
    const resolved = ResolvedRandomizedEvidenceSchema.parse({
      experimentId: input.experimentId,
      experimentVersion: bundle.experimentVersion,
      experimentPlanHash: plan.experimentPlanHash,
      experimentPlanVersion: plan.experimentPlanVersion,
      assignmentMethod: "RANDOMIZED" as const,
      assignmentProvenance: `experiment_plan:${plan.experimentPlanHash}:lineage:${lineage?.lineageId ?? "none"}`,
      assignmentFingerprint,
      evidenceBundleId: bundle.evidenceBundleId,
      evidenceBundleHash: bundle.evidenceBundleHash,
      experimentResultId: bundle.experimentResultId,
      outcomeVerificationIds: [...bundle.outcomeVerificationIds],
      verificationRefs,
      measurementIds,
      projectId: experiment.projectId,
      populationScope: experiment.projectId,
      environmentScope: experiment.requestedEnvironment,
      outcomeUnit: treatmentMeas.unit,
      quality: bundle.qualityClassification,
      treatmentMean,
      controlMean,
      treatmentSampleCount,
      controlSampleCount,
      treatmentMeasurements: Array.from(
        { length: treatmentSampleCount },
        () => treatmentMean,
      ),
      controlMeasurements: Array.from(
        { length: controlSampleCount },
        () => controlMean,
      ),
      ...(lineage?.compiledRunId
        ? { compiledRunId: lineage.compiledRunId }
        : {}),
      ...(lineage?.lineageId ? { lineageId: lineage.lineageId } : {}),
    });
    assertResolvedEvidenceMatchesQuestion(resolved, input);
    return resolved;
  }
}

/**
 * TEST-ONLY: prepend in-memory seeds before falling back to production resolver.
 * Must not be wired from bootstrap, API, env, or runtime config.
 */
export function composeTestAuthoritativeExperimentEvidencePort(
  production: AuthoritativeExperimentEvidencePort,
  testSeeds: InMemoryAuthoritativeExperimentEvidencePort,
): AuthoritativeExperimentEvidencePort {
  return {
    async resolveForEstimation(input) {
      try {
        return await testSeeds.resolveForEstimation(input);
      } catch (seedError) {
        if (
          !(seedError instanceof CausalError) ||
          seedError.code !== "CAUSAL_EVIDENCE_INVALID"
        ) {
          throw seedError;
        }
      }
      return production.resolveForEstimation(input);
    },
  };
}
