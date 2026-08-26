import type { Portfolio } from "./portfolio.js";
import type { PortfolioPlan, PortfolioProgramProposal } from "./plan.js";
import {
  canReserve,
  exceedsCeiling,
  sumAllocations,
} from "./budget.js";
import { validatePortfolioGoals } from "./goals.js";
import { PortfolioError } from "./errors.js";
import { computePortfolioPlanHash } from "./plan.js";
import { evaluateConcentration } from "./compiler.js";

export const PORTFOLIO_VALIDATION_STEPS = [
  "SCHEMA",
  "VERSION_HASH",
  "GOALS",
  "DEPENDENCY_DAG",
  "PROJECT_SCOPE",
  "REPOSITORY_SCOPE",
  "ENVIRONMENT_SCOPE",
  "CAPABILITIES",
  "POLICY",
  "BUDGET",
  "PROGRAM_COUNT",
  "CONCURRENCY",
  "PER_PROGRAM_ALLOCATION",
  "CONCENTRATION",
  "CROSS_PROJECT",
  "RISK",
  "GOAL_CONTRIBUTION",
  "DEADLINE",
  "SECURITY",
  "AUTHORITY_FINGERPRINT",
] as const;

export type PortfolioValidationStep =
  (typeof PORTFOLIO_VALIDATION_STEPS)[number];

export type PortfolioValidationOutcome =
  | "PASS"
  | "BLOCK"
  | "HUMAN_APPROVAL_REQUIRED"
  | "REVISE";

export interface PortfolioValidationFinding {
  step: PortfolioValidationStep;
  severity: "BLOCK" | "WARN";
  code: string;
  message: string;
}

export interface PortfolioValidationResult {
  outcome: PortfolioValidationOutcome;
  findings: readonly PortfolioValidationFinding[];
}

/**
 * Deterministic Portfolio plan validation ladder.
 * Model must never determine the authoritative result.
 */
export function validatePortfolioPlan(
  portfolio: Portfolio,
  plan: Omit<PortfolioPlan, "portfolioPlanHash"> & {
    portfolioPlanHash?: string;
  },
): PortfolioValidationResult {
  const findings: PortfolioValidationFinding[] = [];
  const envelope = portfolio.authorizationEnvelope;

  if (
    plan.portfolioId !== portfolio.portfolioId ||
    plan.portfolioVersion !== portfolio.portfolioVersion
  ) {
    findings.push({
      step: "VERSION_HASH",
      severity: "BLOCK",
      code: "PORTFOLIO_VERSION_MISMATCH",
      message: "Plan portfolio identity/version does not match aggregate",
    });
  }

  if (plan.portfolioPlanHash) {
    const { portfolioPlanHash: _ignored, ...rest } = plan as PortfolioPlan;
    void _ignored;
    const recomputed = computePortfolioPlanHash(rest);
    if (plan.portfolioPlanHash !== recomputed) {
      findings.push({
        step: "VERSION_HASH",
        severity: "BLOCK",
        code: "PORTFOLIO_PLAN_HASH_MISMATCH",
        message: "portfolioPlanHash does not match canonical payload",
      });
    }
  }

  try {
    validatePortfolioGoals(portfolio.goals);
  } catch (err) {
    findings.push({
      step: "GOALS",
      severity: "BLOCK",
      code: err instanceof PortfolioError ? err.code : "PORTFOLIO_GOAL_INVALID",
      message: err instanceof Error ? err.message : "Invalid goals",
    });
  }

  const proposalIds = new Set(plan.programProposals.map((p) => p.proposalId));
  if (proposalIds.size !== plan.programProposals.length) {
    findings.push({
      step: "SCHEMA",
      severity: "BLOCK",
      code: "DUPLICATE_PROPOSAL_ID",
      message: "Duplicate program proposal ids",
    });
  }

  if (hasProposalDependencyCycle(plan)) {
    findings.push({
      step: "DEPENDENCY_DAG",
      severity: "BLOCK",
      code: "PORTFOLIO_GRAPH_CYCLE",
      message: "Program proposal dependency graph contains a cycle",
    });
  }

  for (const dep of plan.dependencies) {
    if (
      !proposalIds.has(dep.fromProposalId) ||
      !proposalIds.has(dep.toProposalId)
    ) {
      findings.push({
        step: "DEPENDENCY_DAG",
        severity: "BLOCK",
        code: "UNKNOWN_DEPENDENCY_ENDPOINT",
        message: `Dependency references unknown proposal`,
      });
    }
  }

  let crossProjectCount = 0;
  for (const proposal of plan.programProposals) {
    validateProposalAgainstEnvelope(portfolio, proposal, findings);
    if (proposal.projectId !== portfolio.primaryProjectId) {
      crossProjectCount += 1;
    }
  }

  if (plan.programProposals.length > envelope.maximumProgramCount) {
    findings.push({
      step: "PROGRAM_COUNT",
      severity: "BLOCK",
      code: "PORTFOLIO_PROGRAM_COUNT_EXCEEDED",
      message: `Program count ${plan.programProposals.length} exceeds ceiling ${envelope.maximumProgramCount}`,
    });
  }

  if (crossProjectCount > envelope.maximumCrossProjectPrograms) {
    findings.push({
      step: "CROSS_PROJECT",
      severity: "BLOCK",
      code: "CROSS_PROJECT_DENIED",
      message: `Cross-project program count ${crossProjectCount} exceeds ceiling`,
    });
  }

  if (
    crossProjectCount > 0 &&
    !envelope.crossProjectDelegationAllowed
  ) {
    findings.push({
      step: "CROSS_PROJECT",
      severity: "BLOCK",
      code: "CROSS_PROJECT_DENIED",
      message: "Cross-project programs not allowed by envelope",
    });
  }

  const amounts = plan.proposedAllocations.map((a) => a.amount);
  const total = sumAllocations(amounts);
  if (exceedsCeiling(total, envelope.maximumPortfolioBudget)) {
    findings.push({
      step: "BUDGET",
      severity: "BLOCK",
      code: "PORTFOLIO_BUDGET_OVER_ALLOCATION",
      message: "Sum of proposed allocations exceeds portfolio ceiling",
    });
  }

  for (const alloc of plan.proposedAllocations) {
    if (exceedsCeiling(alloc.amount, envelope.maximumProgramAllocation)) {
      findings.push({
        step: "PER_PROGRAM_ALLOCATION",
        severity: "BLOCK",
        code: "PORTFOLIO_ALLOCATION_CEILING_EXCEEDED",
        message: `Allocation for ${alloc.proposalId} exceeds per-program ceiling`,
      });
    }
  }

  // Concentration: one basis dimension for the whole plan. Recompute from
  // allocations — do not trust model-supplied scores alone.
  if (
    plan.riskAssessment.concentrationBasis !== envelope.concentrationBasis
  ) {
    findings.push({
      step: "CONCENTRATION",
      severity: "BLOCK",
      code: "CONCENTRATION_BASIS_MISMATCH",
      message: `Plan concentrationBasis ${plan.riskAssessment.concentrationBasis} does not match envelope ${envelope.concentrationBasis}`,
    });
  } else {
    const concentration = evaluateConcentration(
      plan.proposedAllocations.map((a) => a.amount),
      envelope.concentrationBasis,
    );
    if (!concentration.ok) {
      findings.push({
        step: "CONCENTRATION",
        severity: "BLOCK",
        code: concentration.reasonCode,
        message: concentration.message,
      });
    } else if (
      concentration.score > envelope.allocationConcentrationCeiling
    ) {
      findings.push({
        step: "CONCENTRATION",
        severity: "BLOCK",
        code: "CONCENTRATION_LIMIT",
        message: `Allocation concentration ${concentration.score} exceeds ceiling ${envelope.allocationConcentrationCeiling} (basis ${envelope.concentrationBasis}; denominator: total proposed ${envelope.concentrationBasis === "ESTIMATED_COST" ? "estimatedCost" : "totalTokens"})`,
      });
    }
  }

  const riskRank = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;
  if (
    riskRank[plan.riskAssessment.overallRisk] >
    riskRank[envelope.riskCeiling]
  ) {
    findings.push({
      step: "RISK",
      severity: "BLOCK",
      code: "RISK_CEILING",
      message: "Plan risk exceeds portfolio risk ceiling",
    });
  }

  const requiredGoals = portfolio.goals.filter(
    (g) => g.classification === "REQUIRED",
  );
  for (const goal of requiredGoals) {
    const bound = plan.goalBindings.some(
      (b) =>
        b.portfolioGoalId === goal.goalId &&
        b.contributionType !== "OPTIONAL",
    );
    if (!bound) {
      findings.push({
        step: "GOAL_CONTRIBUTION",
        severity: "BLOCK",
        code: "GOAL_CONTRIBUTION_INCOMPLETE",
        message: `Required goal ${goal.goalId} lacks contribution binding`,
      });
    }
  }

  if (
    plan.authorizationEnvelopeHash !==
    portfolio.authorityFreeze.authorizationEnvelopeHash
  ) {
    findings.push({
      step: "AUTHORITY_FINGERPRINT",
      severity: "BLOCK",
      code: "AUTHORITY_DRIFT",
      message: "Plan envelope hash does not match frozen portfolio envelope",
    });
  }

  const blocked = findings.some((f) => f.severity === "BLOCK");
  if (blocked) {
    return { outcome: "BLOCK", findings };
  }
  return { outcome: "HUMAN_APPROVAL_REQUIRED", findings };
}

function validateProposalAgainstEnvelope(
  portfolio: Portfolio,
  proposal: PortfolioProgramProposal,
  findings: PortfolioValidationFinding[],
): void {
  const envelope = portfolio.authorizationEnvelope;
  if (!envelope.allowedProjectIds.includes(proposal.projectId)) {
    findings.push({
      step: "PROJECT_SCOPE",
      severity: "BLOCK",
      code: "PROJECT_OUTSIDE_ENVELOPE",
      message: `Proposal ${proposal.proposalId} project outside envelope`,
    });
  }
  if (
    !envelope.allowedEnvironments.includes(proposal.requestedEnvironment)
  ) {
    findings.push({
      step: "ENVIRONMENT_SCOPE",
      severity: "BLOCK",
      code: "ENVIRONMENT_OUTSIDE_ENVELOPE",
      message: `Proposal ${proposal.proposalId} environment outside envelope`,
    });
  }
  for (const repo of proposal.repositoryScope) {
    if (!envelope.allowedRepositoryIdentities.includes(repo)) {
      findings.push({
        step: "REPOSITORY_SCOPE",
        severity: "BLOCK",
        code: "REPOSITORY_OUTSIDE_ENVELOPE",
        message: `Proposal ${proposal.proposalId} repository outside envelope`,
      });
    }
  }
  if (!canReserve(envelope.maximumProgramAllocation, proposal.requestedAllocation)) {
    findings.push({
      step: "PER_PROGRAM_ALLOCATION",
      severity: "BLOCK",
      code: "PORTFOLIO_ALLOCATION_CEILING_EXCEEDED",
      message: `Proposal ${proposal.proposalId} requested allocation exceeds ceiling`,
    });
  }
}

function hasProposalDependencyCycle(plan: {
  programProposals: readonly { proposalId: string }[];
  dependencies: readonly {
    fromProposalId: string;
    toProposalId: string;
  }[];
}): boolean {
  const ids = plan.programProposals.map((p) => p.proposalId);
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const d of plan.dependencies) {
    adj.get(d.fromProposalId)?.push(d.toProposalId);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): boolean {
    if (visited.has(id)) return false;
    if (visiting.has(id)) return true;
    visiting.add(id);
    for (const next of adj.get(id) ?? []) {
      if (visit(next)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  }
  return ids.some((id) => visit(id));
}

export function assertValidPortfolioPlan(
  portfolio: Portfolio,
  plan: PortfolioPlan,
): void {
  const result = validatePortfolioPlan(portfolio, plan);
  if (result.outcome === "BLOCK") {
    throw new PortfolioError(
      "PORTFOLIO_PLAN_INVALID",
      result.findings.map((f) => f.message).join("; "),
      { findings: result.findings },
    );
  }
}
