/**
 * Deficit round-robin fairness across projects.
 * Weight influences capacity share. Weight != business authority.
 *
 * Durable fairness state lives in PostgreSQL. Process memory is never the
 * authority for multi-scheduler coordination.
 */

import { z } from "zod";

export const ProjectFairnessStateSchema = z
  .object({
    projectId: z.string().min(1),
    deficit: z.number().int().nonnegative(),
    lastServedAt: z.string().datetime().optional(),
    serviceSequence: z.number().int().nonnegative(),
    recordRevision: z.number().int().positive(),
  })
  .strict();

export type ProjectFairnessState = z.infer<typeof ProjectFairnessStateSchema>;

export function parseProjectFairnessState(input: unknown): ProjectFairnessState {
  return ProjectFairnessStateSchema.parse(input);
}

/** In-memory view used while scoring candidates within one selection. */
export interface FairnessState {
  /** projectId → accumulated deficit */
  deficits: Map<string, number>;
}

export function createFairnessState(
  rows: readonly ProjectFairnessState[] = [],
): FairnessState {
  const deficits = new Map<string, number>();
  for (const row of rows) {
    deficits.set(row.projectId, row.deficit);
  }
  return { deficits };
}

export function projectWeightClamp(weight: number): number {
  if (!Number.isFinite(weight)) {
    return 1;
  }
  return Math.min(10, Math.max(1, Math.floor(weight)));
}

/**
 * After a project successfully claims scheduler work, advance deficit
 * round-robin entitlement.
 *
 * Equation (deterministic DRR):
 * 1. Every contender receives credit: deficit += weight * 10
 * 2. Selected project pays the service quantum: deficit = max(0, deficit - 10)
 *
 * Higher weight therefore accrues entitlement faster and is selected more
 * often. Service consumes entitlement; it does not increase future preference
 * for the served project beyond residual credit.
 *
 * Score uses deficit as a non-negative boost (see computeSchedulingScore).
 */
export function applyFairnessCharge(
  state: FairnessState,
  selectedProjectId: string,
  weights: ReadonlyMap<string, number>,
): void {
  const quantum = 10;
  for (const [projectId, rawWeight] of weights) {
    const weight = projectWeightClamp(rawWeight);
    const current = state.deficits.get(projectId) ?? 0;
    state.deficits.set(projectId, current + weight * quantum);
  }
  const selected = state.deficits.get(selectedProjectId) ?? 0;
  state.deficits.set(selectedProjectId, Math.max(0, selected - quantum));
}

/**
 * Pure next-state computation for durable persistence after a successful claim.
 */
export function nextFairnessRowsAfterService(input: {
  existing: readonly ProjectFairnessState[];
  selectedProjectId: string;
  weights: ReadonlyMap<string, number>;
  servedAt: string;
}): ProjectFairnessState[] {
  const byId = new Map(
    input.existing.map((row) => [row.projectId, row] as const),
  );
  const projectIds = new Set<string>([
    ...byId.keys(),
    ...input.weights.keys(),
    input.selectedProjectId,
  ]);
  const view = createFairnessState(input.existing);
  for (const projectId of projectIds) {
    if (!view.deficits.has(projectId)) {
      view.deficits.set(projectId, 0);
    }
  }
  applyFairnessCharge(view, input.selectedProjectId, input.weights);

  const next: ProjectFairnessState[] = [];
  for (const projectId of projectIds) {
    const prior = byId.get(projectId);
    const served = projectId === input.selectedProjectId;
    next.push(
      parseProjectFairnessState({
        projectId,
        deficit: view.deficits.get(projectId) ?? 0,
        ...(served
          ? { lastServedAt: input.servedAt }
          : prior?.lastServedAt
            ? { lastServedAt: prior.lastServedAt }
            : {}),
        serviceSequence: (prior?.serviceSequence ?? 0) + (served ? 1 : 0),
        recordRevision: (prior?.recordRevision ?? 0) + 1,
      }),
    );
  }
  return next.sort((a, b) => a.projectId.localeCompare(b.projectId));
}

export function getProjectDeficit(
  state: FairnessState,
  projectId: string,
): number {
  return state.deficits.get(projectId) ?? 0;
}

export function fairnessSnapshot(
  state: FairnessState,
): Record<string, number> {
  return Object.fromEntries(
    [...state.deficits.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
}
