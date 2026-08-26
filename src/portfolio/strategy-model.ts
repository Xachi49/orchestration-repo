import { z } from "zod";
import {
  PortfolioProgramDispositionSchema,
  type PortfolioProgramProposal,
} from "./plan.js";
import type { PortfolioAnalysisContext } from "./analysis-context.js";
import type { Portfolio } from "./portfolio.js";
import type { PortfolioProgramReference } from "./plan.js";
import { emptyBudgetEstimate } from "./budget.js";

export const StrategyRecommendationSchema = z
  .object({
    disposition: PortfolioProgramDispositionSchema,
    proposalId: z.string().min(1).optional(),
    programId: z.string().min(1).optional(),
    rationale: z.string().default(""),
  })
  .strict();

export type StrategyRecommendation = z.infer<typeof StrategyRecommendationSchema>;

export const PortfolioStrategyProposalSchema = z
  .object({
    recommendations: z.array(StrategyRecommendationSchema),
    programProposals: z.array(z.unknown()).default([]),
    riskNotes: z.array(z.string()).default([]),
    modelId: z.string().min(1),
    modelVersion: z.string().min(1),
  })
  .strict();

export type PortfolioStrategyProposal = z.infer<
  typeof PortfolioStrategyProposalSchema
>;

export interface PortfolioStrategyModel {
  readonly modelId: string;
  readonly modelVersion: string;
  propose(input: {
    portfolio: Portfolio;
    analysis: PortfolioAnalysisContext;
    existingPrograms: readonly PortfolioProgramReference[];
  }): Promise<PortfolioStrategyProposal>;
}

/**
 * Deterministic Fake strategy model for tests.
 * Produces CREATE_PROGRAM proposals from portfolio goals — recommendations only.
 */
export class FakePortfolioStrategyModel implements PortfolioStrategyModel {
  readonly modelId = "fake-portfolio-strategy";
  readonly modelVersion = "1.0.0";

  constructor(
    private readonly proposalFactory?: (input: {
      portfolio: Portfolio;
      existingPrograms: readonly PortfolioProgramReference[];
    }) => PortfolioProgramProposal[],
  ) {}

  async propose(input: {
    portfolio: Portfolio;
    analysis: PortfolioAnalysisContext;
    existingPrograms: readonly PortfolioProgramReference[];
  }): Promise<PortfolioStrategyProposal> {
    void input.analysis;
    const proposals =
      this.proposalFactory?.({
        portfolio: input.portfolio,
        existingPrograms: input.existingPrograms,
      }) ?? defaultProposals(input.portfolio);

    return {
      modelId: this.modelId,
      modelVersion: this.modelVersion,
      recommendations: proposals.map((p) => ({
        disposition: "CREATE_PROGRAM" as const,
        proposalId: p.proposalId,
        rationale: "fake strategy recommendation",
      })),
      programProposals: proposals,
      riskNotes: ["Fake model: recommendations are non-authoritative"],
    };
  }
}

function defaultProposals(portfolio: Portfolio): PortfolioProgramProposal[] {
  const env =
    portfolio.authorizationEnvelope.allowedEnvironments[0] ??
    portfolio.intent.requestedEnvironmentScopes[0]!;
  const projectId = portfolio.primaryProjectId;
  return portfolio.goals
    .filter((g) => g.classification === "REQUIRED")
    .map((goal, index) => ({
      proposalId: `prop_${goal.goalId}`,
      title: `Program for ${goal.goalId}`,
      requestedOutcome: goal.description,
      projectId,
      requestedEnvironment: env,
      repositoryScope: [
        ...portfolio.authorizationEnvelope.allowedRepositoryIdentities,
      ],
      proposedProgramRootIntent: {
        requestedOutcome: goal.description,
        acceptanceCriteria: [...goal.successCriteria],
        nonGoals: [...portfolio.intent.nonGoals],
        constraints: [...portfolio.intent.constraints],
        priority: "HIGH" as const,
      },
      requestedAllocation: {
        ...emptyBudgetEstimate(),
        llmCalls: 10,
        totalTokens: 50_000,
        apiCalls: 20,
        executionMinutes: 30,
        estimatedCost: 10,
        humanReviewMinutes: 15,
        planSteps: 10,
        parallelWorkstreams: 2,
        revisionAttempts: 2,
      },
      goalContributionBindings: [
        {
          bindingId: `bind_${goal.goalId}`,
          portfolioGoalId: goal.goalId,
          programProposalId: `prop_${goal.goalId}`,
          programCriterionId: goal.successCriteria[0]!,
          requiredEvidenceClass: "PROGRAM_COMPLETION_AUTHORITY" as const,
          contributionType: "PRIMARY" as const,
          contributionScore: 1,
        },
      ],
      programDependencies: [],
      priorityRecommendation: 50 + index,
      riskClassification: "MEDIUM" as const,
      disposition: "CREATE_PROGRAM" as const,
    }));
}
