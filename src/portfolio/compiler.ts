import type { BudgetResourceEstimate } from "../control-plane/budgets/budget.js";
import type { Portfolio } from "./portfolio.js";
import type { PortfolioStrategyProposal } from "./strategy-model.js";
import {
  INITIAL_PORTFOLIO_PLAN_VERSION,
  PortfolioProgramProposalSchema,
  type PortfolioPlan,
  type PortfolioProgramProposal,
  withPortfolioPlanHash,
} from "./plan.js";
import { portfolioAllocationFingerprint } from "./budget.js";
import type { ConcentrationBasis } from "./authorization-envelope.js";

/**
 * Compiles untrusted strategy proposals into a deterministic PortfolioPlan body.
 * Does not validate authority — validator owns that.
 *
 * Concentration uses exactly one envelope-configured basis dimension for the
 * entire plan (never mixed units, never per-proposal fallback).
 */
export function compilePortfolioPlan(input: {
  portfolio: Portfolio;
  proposal: PortfolioStrategyProposal;
  portfolioPlanVersion: number;
  createdAt: string;
}): PortfolioPlan {
  const { portfolio, proposal } = input;
  const programProposals = proposal.programProposals.map((raw) =>
    PortfolioProgramProposalSchema.parse(raw),
  );

  const proposedAllocations = programProposals.map((p) => ({
    proposalId: p.proposalId,
    amount: p.requestedAllocation,
  }));

  const goalBindings = programProposals.flatMap((p) =>
    p.goalContributionBindings.map((b) => ({ ...b })),
  );

  const dependencies = programProposals.flatMap((p) =>
    p.programDependencies.map((depId) => ({
      fromProposalId: depId,
      toProposalId: p.proposalId,
      semantics: "BLOCKS_UNTIL_COMPLETED" as const,
    })),
  );

  const existingProgramDispositions = proposal.recommendations
    .filter(
      (r) =>
        r.programId !== undefined && r.disposition !== "CREATE_PROGRAM",
    )
    .map((r) => ({
      programId: r.programId!,
      disposition: r.disposition,
      rationale: r.rationale,
    }));

  const basis = portfolio.authorizationEnvelope.concentrationBasis;
  const allocationAmounts = proposedAllocations.map((a) => a.amount);
  const concentration = evaluateConcentration(allocationAmounts, basis);
  const concentrationScore = concentration.ok ? concentration.score : 1;
  const overallRisk = maxRiskClassification(programProposals);

  const freeze = portfolio.authorityFreeze;
  const allocationPlanHash =
    portfolioAllocationFingerprint(proposedAllocations);

  const body = {
    portfolioId: portfolio.portfolioId,
    portfolioVersion: portfolio.portfolioVersion,
    portfolioPlanVersion: Math.max(
      input.portfolioPlanVersion,
      INITIAL_PORTFOLIO_PLAN_VERSION,
    ),
    createdAt: input.createdAt,
    goalBindings,
    programProposals,
    existingProgramDispositions,
    proposedAllocations,
    dependencies,
    riskAssessment: {
      overallRisk,
      concentrationScore,
      concentrationBasis: basis,
      notes: [
        ...proposal.riskNotes,
        ...(concentration.ok
          ? []
          : [`concentration_basis_incomplete:${concentration.reasonCode}`]),
      ],
    },
    expectedGoalContributions: portfolio.goals
      .filter((g) => g.classification === "REQUIRED")
      .map((g) => g.goalId),
    requiredHumanDecisions: ["PORTFOLIO_ALLOCATOR_APPROVAL"],
    policyBundleFingerprint: freeze.policyBundleHash,
    capabilitySetFingerprint: freeze.capabilitySetFingerprint,
    budgetConfigurationFingerprint: freeze.budgetConfigurationFingerprint,
    projectConfigurationFingerprint: freeze.projectConfigurationFingerprint,
    repositoryAllowlistFingerprint: freeze.repositoryAllowlistFingerprint,
    environmentScopeFingerprint: freeze.environmentScopeFingerprint,
    authorizationEnvelopeHash: freeze.authorizationEnvelopeHash,
    allocationPlanHash,
    strategyModelId: proposal.modelId,
    strategyModelVersion: proposal.modelVersion,
  };

  return withPortfolioPlanHash(body);
}

export type ConcentrationEvaluation =
  | {
      ok: true;
      score: number;
      basis: ConcentrationBasis;
      total: number;
    }
  | {
      ok: false;
      reasonCode:
        | "INSUFFICIENT_CONCENTRATION_BASIS"
        | "ZERO_CONCENTRATION_DENOMINATOR";
      message: string;
      basis: ConcentrationBasis;
    };

/**
 * Concentration over a single basis dimension D for the whole plan:
 *   total = Σ allocation[D]
 *   programConcentration(P) = allocation[P][D] / total
 *   score = max(programConcentration)
 *
 * Denominator is total proposed allocation on D — never the Portfolio ceiling.
 * Never mixes ESTIMATED_COST and TOTAL_TOKENS. Never falls back per proposal.
 * Values on D must be strictly positive for every participating allocation.
 */
export function evaluateConcentration(
  allocations: readonly BudgetResourceEstimate[],
  basis: ConcentrationBasis,
): ConcentrationEvaluation {
  if (allocations.length === 0) {
    return { ok: true, score: 0, basis, total: 0 };
  }

  const dim = basis === "ESTIMATED_COST" ? "estimatedCost" : "totalTokens";
  const values: number[] = [];
  for (let i = 0; i < allocations.length; i++) {
    const raw = allocations[i]![dim];
    if (!Number.isFinite(raw) || raw <= 0) {
      return {
        ok: false,
        reasonCode: "INSUFFICIENT_CONCENTRATION_BASIS",
        message: `Allocation[${i}] missing positive ${dim} for concentration basis ${basis}`,
        basis,
      };
    }
    values.push(raw);
  }

  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) {
    return {
      ok: false,
      reasonCode: "ZERO_CONCENTRATION_DENOMINATOR",
      message: `Concentration denominator is zero for basis ${basis}`,
      basis,
    };
  }

  let maxShare = 0;
  for (const v of values) {
    maxShare = Math.max(maxShare, v / total);
  }
  return { ok: true, score: maxShare, basis, total };
}

/** Convenience for tests: throws when basis is incomplete. */
export function computeConcentrationScore(
  allocations: readonly BudgetResourceEstimate[],
  basis: ConcentrationBasis = "ESTIMATED_COST",
): number {
  const result = evaluateConcentration(allocations, basis);
  if (!result.ok) {
    throw new Error(`${result.reasonCode}: ${result.message}`);
  }
  return result.score;
}

function maxRiskClassification(
  proposals: readonly PortfolioProgramProposal[],
): "LOW" | "MEDIUM" | "HIGH" {
  const rank = { LOW: 1, MEDIUM: 2, HIGH: 3 } as const;
  let max: "LOW" | "MEDIUM" | "HIGH" = "LOW";
  for (const p of proposals) {
    if (rank[p.riskClassification] > rank[max]) {
      max = p.riskClassification;
    }
  }
  return max;
}
