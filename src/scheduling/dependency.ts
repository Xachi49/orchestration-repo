import { z } from "zod";

export const DEPENDENCY_MILESTONES = [
  "REPOSITORY_VERIFIED",
  "PLAN_VALIDATED",
  "APPROVED",
  "COMPLETED",
] as const;

export type DependencyMilestone = (typeof DEPENDENCY_MILESTONES)[number];

export const CrossRunDependencySchema = z
  .object({
    dependencyId: z.string().min(1),
    projectId: z.string().min(1),
    dependentRunId: z.string().min(1),
    prerequisiteRunId: z.string().min(1),
    requiredMilestone: z.enum(DEPENDENCY_MILESTONES),
    createdAt: z.string().datetime(),
    dependencyHash: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dependentRunId === value.prerequisiteRunId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Run cannot depend on itself",
      });
    }
  });

export type CrossRunDependency = z.infer<typeof CrossRunDependencySchema>;

export function parseCrossRunDependency(input: unknown): CrossRunDependency {
  return CrossRunDependencySchema.parse(input);
}

/**
 * Reject cycles in the directed dependency graph (dependent → prerequisite).
 * Edges mean: dependent waits for prerequisite.
 */
export function detectDependencyCycle(
  edges: readonly {
    dependentRunId: string;
    prerequisiteRunId: string;
  }[],
): { cyclic: false } | { cyclic: true; path: string[] } {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const list = adjacency.get(edge.dependentRunId) ?? [];
    list.push(edge.prerequisiteRunId);
    adjacency.set(edge.dependentRunId, list);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    if (visiting.has(node)) {
      const start = stack.indexOf(node);
      return [...stack.slice(start), node];
    }
    if (visited.has(node)) {
      return null;
    }
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = dfs(next);
      if (cycle) {
        return cycle;
      }
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  }

  for (const node of adjacency.keys()) {
    const cycle = dfs(node);
    if (cycle) {
      return { cyclic: true, path: cycle };
    }
  }
  return { cyclic: false };
}
