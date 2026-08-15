import { PlanningError } from "./errors.js";
import type { ProposedStep } from "./proposal.js";

export interface DependencyGraphResult {
  criticalPath: string[];
  parallelGroups: string[][];
}

/**
 * Deterministic dependency graph validation. Does not rewrite cycles.
 */
export class DependencyGraphService {
  validate(steps: readonly ProposedStep[]): DependencyGraphResult {
    const byId = new Map(steps.map((step) => [step.stepId, step]));
    if (byId.size !== steps.length) {
      throw new PlanningError(
        "PLAN_DEPENDENCY_MISSING",
        "Duplicate step IDs in proposal",
      );
    }

    for (const step of steps) {
      for (const dep of step.dependsOn) {
        if (dep === step.stepId) {
          throw new PlanningError(
            "PLAN_DEPENDENCY_CYCLE",
            `Step ${step.stepId} depends on itself`,
            { stepId: step.stepId },
          );
        }
        if (!byId.has(dep)) {
          throw new PlanningError(
            "PLAN_DEPENDENCY_MISSING",
            `Step ${step.stepId} depends on missing step ${dep}`,
            { stepId: step.stepId, missingDependency: dep },
          );
        }
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (id: string): void => {
      if (visited.has(id)) {
        return;
      }
      if (visiting.has(id)) {
        throw new PlanningError(
          "PLAN_DEPENDENCY_CYCLE",
          `Dependency cycle detected at ${id}`,
          { stepId: id },
        );
      }
      visiting.add(id);
      const step = byId.get(id);
      if (step) {
        for (const dep of step.dependsOn) {
          visit(dep);
        }
      }
      visiting.delete(id);
      visited.add(id);
    };
    for (const step of steps) {
      visit(step.stepId);
    }

    const longest = new Map<string, number>();
    const memo = (id: string): number => {
      const cached = longest.get(id);
      if (cached !== undefined) {
        return cached;
      }
      const step = byId.get(id)!;
      const value =
        step.dependsOn.length === 0
          ? 1
          : 1 + Math.max(...step.dependsOn.map((dep) => memo(dep)));
      longest.set(id, value);
      return value;
    };
    for (const step of steps) {
      memo(step.stepId);
    }

    const maxDepth = Math.max(...[...longest.values()], 0);
    const criticalEnd = [...longest.entries()]
      .filter(([, depth]) => depth === maxDepth)
      .map(([id]) => id)
      .sort((a, b) => a.localeCompare(b))[0];

    const criticalPath: string[] = [];
    if (criticalEnd) {
      let current: string | undefined = criticalEnd;
      while (current) {
        criticalPath.unshift(current);
        const step: ProposedStep | undefined = byId.get(current);
        if (!step || step.dependsOn.length === 0) {
          break;
        }
        const next = [...step.dependsOn].sort((a, b) => {
          const depthDiff = (longest.get(b) ?? 0) - (longest.get(a) ?? 0);
          return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
        })[0];
        current = next;
      }
    }

    const groups = new Map<number, string[]>();
    for (const [id, depth] of longest) {
      const list = groups.get(depth) ?? [];
      list.push(id);
      groups.set(depth, list);
    }
    const parallelGroups = [...groups.keys()]
      .sort((a, b) => a - b)
      .map((depth) => (groups.get(depth) ?? []).sort((a, b) => a.localeCompare(b)));

    return { criticalPath, parallelGroups };
  }
}
