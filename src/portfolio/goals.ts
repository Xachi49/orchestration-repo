import { createHash } from "node:crypto";
import { z } from "zod";
import { PortfolioError } from "./errors.js";

export const PortfolioGoalStatusSchema = z.enum([
  "OPEN",
  "SATISFIED",
  "UNSATISFIED",
  "INCONCLUSIVE",
  "WAIVED",
]);
export type PortfolioGoalStatus = z.infer<typeof PortfolioGoalStatusSchema>;

export const PortfolioGoalSchema = z
  .object({
    goalId: z.string().min(1),
    description: z.string().min(1).max(2000),
    successCriteria: z.array(z.string().min(1)).min(1),
    weight: z.number().min(0).max(1),
    classification: z.enum(["REQUIRED", "OPTIONAL"]),
    deadline: z.string().datetime().optional(),
    dependencies: z.array(z.string().min(1)).default([]),
    evidenceRequirements: z.array(z.string().min(1)).min(1),
    status: PortfolioGoalStatusSchema.default("OPEN"),
  })
  .strict();

export type PortfolioGoal = z.infer<typeof PortfolioGoalSchema>;

export function parsePortfolioGoals(input: unknown): PortfolioGoal[] {
  const goals = z.array(PortfolioGoalSchema).parse(input);
  validatePortfolioGoals(goals);
  return goals;
}

export function validatePortfolioGoals(goals: readonly PortfolioGoal[]): void {
  const ids = new Set<string>();
  for (const goal of goals) {
    if (ids.has(goal.goalId)) {
      throw new PortfolioError(
        "PORTFOLIO_GOAL_INVALID",
        `Duplicate portfolio goal id: ${goal.goalId}`,
      );
    }
    ids.add(goal.goalId);
    if (goal.weight < 0) {
      throw new PortfolioError(
        "PORTFOLIO_GOAL_INVALID",
        `Goal weight must be >= 0: ${goal.goalId}`,
      );
    }
    if (
      goal.classification === "REQUIRED" &&
      goal.successCriteria.length === 0
    ) {
      throw new PortfolioError(
        "PORTFOLIO_GOAL_INVALID",
        `Required goal needs success criteria: ${goal.goalId}`,
      );
    }
  }

  for (const goal of goals) {
    for (const dep of goal.dependencies) {
      if (!ids.has(dep)) {
        throw new PortfolioError(
          "PORTFOLIO_GOAL_INVALID",
          `Unknown goal dependency ${dep} on ${goal.goalId}`,
        );
      }
      if (dep === goal.goalId) {
        throw new PortfolioError(
          "PORTFOLIO_GRAPH_CYCLE",
          `Self-dependency on goal ${goal.goalId}`,
        );
      }
    }
  }

  detectGoalCycles(goals);
}

function detectGoalCycles(goals: readonly PortfolioGoal[]): void {
  const byId = new Map(goals.map((g) => [g.goalId, g] as const));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function visit(id: string): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      throw new PortfolioError(
        "PORTFOLIO_GRAPH_CYCLE",
        `Goal dependency cycle involving ${id}`,
      );
    }
    visiting.add(id);
    const goal = byId.get(id);
    if (goal) {
      for (const dep of goal.dependencies) {
        visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const goal of goals) {
    visit(goal.goalId);
  }
}

export function portfolioGoalsHash(goals: readonly PortfolioGoal[]): string {
  const sorted = [...goals].sort((a, b) => a.goalId.localeCompare(b.goalId));
  return createHash("sha256")
    .update(JSON.stringify(sorted), "utf8")
    .digest("hex");
}

/** Weights are strategic metadata — never authorization. */
export function assertWeightsAreMetadataOnly(): void {
  // Intentional documentation hook for tests / reviews.
}
