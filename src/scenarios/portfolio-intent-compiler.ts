import type { PortfolioIntent } from "../portfolio/intent.js";
import { portfolioIntentHash } from "../portfolio/intent.js";
import type { DecisionProblem } from "./decision-problem.js";
import type { ScenarioDefinition } from "./scenario.js";

/**
 * Derive default portfolio intent from decision problem fields.
 */
export function defaultPortfolioIntentFromDecisionProblem(
  problem: DecisionProblem,
): PortfolioIntent {
  return {
    portfolioName: problem.question.slice(0, 200),
    strategicOutcome: problem.strategicObjective,
    strategicGoals: problem.decisionCriteria.map((c) => c.name),
    constraints: [...problem.constraints],
    nonGoals: [...problem.nonGoals],
    priorityPrinciples: [],
    timeHorizon: problem.timeHorizon,
    requestedEnvironmentScopes: [...problem.allowedEnvironments],
    allowedProjectScopes: [...problem.allowedProjectIds],
    riskToleranceProfile: problem.riskTolerance,
    capitalAllocationPrinciples: [],
    successCriteria: problem.decisionCriteria.map((c) => c.name),
  };
}

function mergePartialIntent(
  base: PortfolioIntent,
  delta: Partial<PortfolioIntent>,
): PortfolioIntent {
  const merged: PortfolioIntent = { ...base };
  if (delta.portfolioName !== undefined) merged.portfolioName = delta.portfolioName;
  if (delta.strategicOutcome !== undefined) {
    merged.strategicOutcome = delta.strategicOutcome;
  }
  if (delta.strategicGoals !== undefined) merged.strategicGoals = delta.strategicGoals;
  if (delta.constraints !== undefined) merged.constraints = delta.constraints;
  if (delta.nonGoals !== undefined) merged.nonGoals = delta.nonGoals;
  if (delta.priorityPrinciples !== undefined) {
    merged.priorityPrinciples = delta.priorityPrinciples;
  }
  if (delta.timeHorizon !== undefined) merged.timeHorizon = delta.timeHorizon;
  if (delta.requestedEnvironmentScopes !== undefined) {
    merged.requestedEnvironmentScopes = delta.requestedEnvironmentScopes;
  }
  if (delta.allowedProjectScopes !== undefined) {
    merged.allowedProjectScopes = delta.allowedProjectScopes;
  }
  if (delta.riskToleranceProfile !== undefined) {
    merged.riskToleranceProfile = delta.riskToleranceProfile;
  }
  if (delta.capitalAllocationPrinciples !== undefined) {
    merged.capitalAllocationPrinciples = delta.capitalAllocationPrinciples;
  }
  if (delta.successCriteria !== undefined) {
    merged.successCriteria = delta.successCriteria;
  }
  return merged;
}

/**
 * Deterministic merge of scenario portfolioIntentDelta over decision problem defaults.
 */
export function compileProposedPortfolioIntent(
  selectedScenario: ScenarioDefinition,
  decisionProblem: DecisionProblem,
): PortfolioIntent {
  const defaults = defaultPortfolioIntentFromDecisionProblem(decisionProblem);
  const rawDelta = selectedScenario.portfolioIntentDelta;
  if (!rawDelta) {
    return defaults;
  }
  const delta = Object.fromEntries(
    Object.entries(rawDelta).filter(([, value]) => value !== undefined),
  ) as Partial<PortfolioIntent>;
  return mergePartialIntent(defaults, delta);
}

export function compiledPortfolioIntentHash(
  selectedScenario: ScenarioDefinition,
  decisionProblem: DecisionProblem,
): string {
  return portfolioIntentHash(
    compileProposedPortfolioIntent(selectedScenario, decisionProblem),
  );
}
