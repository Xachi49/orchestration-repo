import type { PlanningContext } from "../planning/context.js";
import { PlanningError } from "../planning/errors.js";
import type { ExperimentPlan } from "./plan.js";
import type { GovernedExperiment } from "./experiment.js";
import type { ExperimentExecutionLineage } from "./evidence.js";
import type {
  ExperimentExecutionLineageRepository,
  ExperimentPlanRepository,
  ExperimentRepository,
} from "./repositories.js";
import { parseExperimentObjectiveConstraints } from "./planning-proposal.js";

export interface ExperimentPlanningProvenanceDeps {
  lineage: Pick<ExperimentExecutionLineageRepository, "getByCompiledRunId">;
  plans: Pick<ExperimentPlanRepository, "getByHash">;
  experiments: Pick<ExperimentRepository, "getById">;
}

export interface VerifiedExperimentPlanningOrigin {
  lineage: ExperimentExecutionLineage;
  plan: ExperimentPlan;
  experiment: GovernedExperiment;
}

export function planningContextIdentity(context: PlanningContext): {
  runId: string;
  projectId: string;
  objectiveId: string;
  objectiveVersion: number;
  constraints: readonly string[];
} {
  return {
    runId: context.run.runId,
    projectId: context.run.projectId,
    objectiveId: context.run.objectiveId,
    objectiveVersion: context.run.objectiveVersion,
    constraints: context.objective.constraints,
  };
}

/**
 * Resolves a verified Phase 17 experiment planning origin from durable lineage.
 * Returns null when no lineage exists (delegate path). Throws on provenance mismatch.
 */
export async function resolveVerifiedExperimentPlanningOrigin(
  deps: ExperimentPlanningProvenanceDeps,
  input: {
    runId: string;
    projectId: string;
    objectiveId: string;
    objectiveVersion: number;
    constraints: readonly string[];
  },
): Promise<VerifiedExperimentPlanningOrigin | null> {
  const lineage = await deps.lineage.getByCompiledRunId(input.runId);
  if (!lineage?.compiledRunId) {
    return null;
  }

  if (lineage.compiledRunId !== input.runId) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Experiment execution lineage run identity does not match planning context",
      {
        contextRunId: input.runId,
        lineageRunId: lineage.compiledRunId,
        lineageId: lineage.lineageId,
      },
    );
  }

  if (
    lineage.compiledObjectiveId !== undefined &&
    lineage.compiledObjectiveId !== input.objectiveId
  ) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Experiment execution lineage objective identity does not match planning context",
      {
        contextObjectiveId: input.objectiveId,
        lineageObjectiveId: lineage.compiledObjectiveId,
        lineageId: lineage.lineageId,
      },
    );
  }

  if (
    lineage.compiledObjectiveVersion !== undefined &&
    lineage.compiledObjectiveVersion !== input.objectiveVersion
  ) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Experiment execution lineage objective version does not match planning context",
      {
        contextObjectiveVersion: input.objectiveVersion,
        lineageObjectiveVersion: lineage.compiledObjectiveVersion,
        lineageId: lineage.lineageId,
      },
    );
  }

  const constraintHints = parseExperimentObjectiveConstraints(input.constraints);
  if (constraintHints) {
    if (constraintHints.experimentId !== lineage.experimentId) {
      throw new PlanningError(
        "PLANNING_CONTEXT_MISMATCH",
        "Objective experiment constraint does not match durable experiment lineage",
        {
          constraintExperimentId: constraintHints.experimentId,
          lineageExperimentId: lineage.experimentId,
          lineageId: lineage.lineageId,
        },
      );
    }
    if (constraintHints.experimentPlanHash !== lineage.experimentPlanHash) {
      throw new PlanningError(
        "PLANNING_CONTEXT_MISMATCH",
        "Objective experiment plan hash constraint does not match durable experiment lineage",
        {
          constraintExperimentPlanHash: constraintHints.experimentPlanHash,
          lineageExperimentPlanHash: lineage.experimentPlanHash,
          lineageId: lineage.lineageId,
        },
      );
    }
  }

  const experiment = await deps.experiments.getById(lineage.experimentId);
  if (!experiment) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Experiment execution lineage references missing experiment",
      {
        experimentId: lineage.experimentId,
        lineageId: lineage.lineageId,
      },
    );
  }

  if (experiment.projectId !== input.projectId) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Experiment project does not match admitted run project",
      {
        runProjectId: input.projectId,
        experimentProjectId: experiment.projectId,
        experimentId: experiment.experimentId,
        lineageId: lineage.lineageId,
      },
    );
  }

  if (experiment.experimentVersion !== lineage.experimentVersion) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Experiment version does not match durable execution lineage",
      {
        experimentVersion: experiment.experimentVersion,
        lineageExperimentVersion: lineage.experimentVersion,
        lineageId: lineage.lineageId,
      },
    );
  }

  const plan = await deps.plans.getByHash(
    lineage.experimentId,
    lineage.experimentPlanHash,
  );
  if (!plan) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Authoritative experiment plan missing for durable execution lineage",
      {
        experimentId: lineage.experimentId,
        experimentPlanHash: lineage.experimentPlanHash,
        lineageId: lineage.lineageId,
      },
    );
  }

  if (plan.experimentPlanHash !== lineage.experimentPlanHash) {
    throw new PlanningError(
      "PLANNING_CONTEXT_MISMATCH",
      "Authoritative experiment plan hash diverges from durable execution lineage",
      {
        lineageExperimentPlanHash: lineage.experimentPlanHash,
        planExperimentPlanHash: plan.experimentPlanHash,
        lineageId: lineage.lineageId,
      },
    );
  }

  return { lineage, plan, experiment };
}
