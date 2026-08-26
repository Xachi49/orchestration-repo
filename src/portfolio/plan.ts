import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetResourceEstimateSchema } from "../control-plane/budgets/budget.js";
import { ProgramRootIntentSchema } from "../programs/program.js";
import { DelegationEnvelopeSchema } from "../programs/delegation-envelope.js";

export const PortfolioProgramDispositionSchema = z.enum([
  "CREATE_PROGRAM",
  "CONTINUE_PROGRAM",
  "PAUSE_PROGRAM",
  "RETIRE_PROGRAM",
  "INCREASE_ALLOCATION",
  "DECREASE_ALLOCATION",
  "NO_CHANGE",
]);
export type PortfolioProgramDisposition = z.infer<
  typeof PortfolioProgramDispositionSchema
>;

export const INITIAL_PORTFOLIO_PLAN_VERSION = 1;
export const PORTFOLIO_PLAN_COMPILER_VERSION = "1.0.0";

export const PortfolioGoalContributionBindingSchema = z
  .object({
    bindingId: z.string().min(1),
    portfolioGoalId: z.string().min(1),
    programProposalId: z.string().min(1).optional(),
    programId: z.string().min(1).optional(),
    programCriterionId: z.string().min(1),
    requiredEvidenceClass: z.enum([
      "PROGRAM_COMPLETION_AUTHORITY",
      "PROGRAM_VERIFIED_OUTCOME",
      "CURRENT_CONTROL_PLANE_TRUTH",
    ]),
    contributionType: z.enum(["PRIMARY", "SUPPORTING", "OPTIONAL"]),
    contributionScore: z.number().min(0).max(1).default(1),
  })
  .strict()
  .refine(
    (v) => v.programProposalId !== undefined || v.programId !== undefined,
    { message: "binding requires programProposalId or programId" },
  );

export type PortfolioGoalContributionBinding = z.infer<
  typeof PortfolioGoalContributionBindingSchema
>;

export const PortfolioProgramProposalSchema = z
  .object({
    proposalId: z.string().min(1),
    title: z.string().min(1).max(200),
    requestedOutcome: z.string().min(1).max(4000),
    projectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    repositoryScope: z.array(z.string().min(1)).default([]),
    proposedProgramRootIntent: ProgramRootIntentSchema,
    proposedDelegationEnvelope: DelegationEnvelopeSchema.optional(),
    requestedAllocation: BudgetResourceEstimateSchema,
    goalContributionBindings: z
      .array(PortfolioGoalContributionBindingSchema)
      .default([]),
    programDependencies: z.array(z.string().min(1)).default([]),
    priorityRecommendation: z.number().int().min(0).max(100).default(50),
    riskClassification: z.enum(["LOW", "MEDIUM", "HIGH"]).default("MEDIUM"),
    disposition: PortfolioProgramDispositionSchema.default("CREATE_PROGRAM"),
  })
  .strict();

export type PortfolioProgramProposal = z.infer<
  typeof PortfolioProgramProposalSchema
>;

export const PortfolioProgramReferenceSchema = z
  .object({
    programId: z.string().min(1).optional(),
    programVersion: z.number().int().positive().optional(),
    programStatus: z.string().min(1).optional(),
    programPlanVersion: z.number().int().positive().optional(),
    programPlanHash: z.string().min(1).optional(),
    allocatedBudget: BudgetResourceEstimateSchema.optional(),
    completionRecordId: z.string().min(1).optional(),
    projectId: z.string().min(1),
    repositoryScope: z.array(z.string()).default([]),
    environmentScope: z.array(z.string()).default([]),
    goalContributionBindings: z
      .array(PortfolioGoalContributionBindingSchema)
      .default([]),
  })
  .strict();

export type PortfolioProgramReference = z.infer<
  typeof PortfolioProgramReferenceSchema
>;

export const PortfolioRiskAssessmentSchema = z
  .object({
    overallRisk: z.enum(["LOW", "MEDIUM", "HIGH"]),
    concentrationScore: z.number().min(0).max(1),
    /** Locked at compile time from the Portfolio envelope. */
    concentrationBasis: z.enum(["ESTIMATED_COST", "TOTAL_TOKENS"]),
    notes: z.array(z.string()).default([]),
  })
  .strict();

export type PortfolioRiskAssessment = z.infer<
  typeof PortfolioRiskAssessmentSchema
>;

export const PortfolioPlanSchema = z
  .object({
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    portfolioPlanVersion: z.number().int().positive(),
    portfolioPlanHash: z.string().min(1),
    createdAt: z.string().datetime(),
    goalBindings: z.array(PortfolioGoalContributionBindingSchema),
    programProposals: z.array(PortfolioProgramProposalSchema),
    existingProgramDispositions: z
      .array(
        z
          .object({
            programId: z.string().min(1),
            disposition: PortfolioProgramDispositionSchema,
            rationale: z.string().default(""),
          })
          .strict(),
      )
      .default([]),
    proposedAllocations: z.array(
      z
        .object({
          proposalId: z.string().min(1),
          amount: BudgetResourceEstimateSchema,
        })
        .strict(),
    ),
    dependencies: z
      .array(
        z
          .object({
            fromProposalId: z.string().min(1),
            toProposalId: z.string().min(1),
            semantics: z.enum([
              "BLOCKS_UNTIL_COMPLETED",
              "REQUIRES_VERIFIED_SUCCESS",
            ]),
          })
          .strict(),
      )
      .default([]),
    riskAssessment: PortfolioRiskAssessmentSchema,
    expectedGoalContributions: z.array(z.string()).default([]),
    requiredHumanDecisions: z.array(z.string()).default([]),
    policyBundleFingerprint: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    budgetConfigurationFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    repositoryAllowlistFingerprint: z.string().min(1),
    environmentScopeFingerprint: z.string().min(1),
    authorizationEnvelopeHash: z.string().min(1),
    allocationPlanHash: z.string().min(1),
    strategyModelId: z.string().min(1),
    strategyModelVersion: z.string().min(1),
  })
  .strict();

export type PortfolioPlan = z.infer<typeof PortfolioPlanSchema>;

export function portfolioPlanCanonicalPayload(
  plan: Omit<PortfolioPlan, "portfolioPlanHash">,
): Record<string, unknown> {
  return {
    allocationPlanHash: plan.allocationPlanHash,
    authorizationEnvelopeHash: plan.authorizationEnvelopeHash,
    budgetConfigurationFingerprint: plan.budgetConfigurationFingerprint,
    capabilitySetFingerprint: plan.capabilitySetFingerprint,
    createdAt: plan.createdAt,
    dependencies: plan.dependencies,
    environmentScopeFingerprint: plan.environmentScopeFingerprint,
    existingProgramDispositions: plan.existingProgramDispositions,
    expectedGoalContributions: plan.expectedGoalContributions,
    goalBindings: plan.goalBindings,
    policyBundleFingerprint: plan.policyBundleFingerprint,
    portfolioId: plan.portfolioId,
    portfolioPlanVersion: plan.portfolioPlanVersion,
    portfolioVersion: plan.portfolioVersion,
    programProposals: plan.programProposals,
    projectConfigurationFingerprint: plan.projectConfigurationFingerprint,
    proposedAllocations: plan.proposedAllocations,
    repositoryAllowlistFingerprint: plan.repositoryAllowlistFingerprint,
    requiredHumanDecisions: plan.requiredHumanDecisions,
    riskAssessment: plan.riskAssessment,
    strategyModelId: plan.strategyModelId,
    strategyModelVersion: plan.strategyModelVersion,
  };
}

export function computePortfolioPlanHash(
  plan: Omit<PortfolioPlan, "portfolioPlanHash">,
): string {
  return createHash("sha256")
    .update(JSON.stringify(portfolioPlanCanonicalPayload(plan)), "utf8")
    .digest("hex");
}

export function withPortfolioPlanHash(
  plan: Omit<PortfolioPlan, "portfolioPlanHash">,
): PortfolioPlan {
  const hash = computePortfolioPlanHash(plan);
  return PortfolioPlanSchema.parse({ ...plan, portfolioPlanHash: hash });
}

export function mintProgramIdFromPortfolioProposal(input: {
  portfolioId: string;
  portfolioVersion: number;
  portfolioPlanVersion: number;
  proposalId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        portfolioId: input.portfolioId,
        portfolioPlanVersion: input.portfolioPlanVersion,
        portfolioVersion: input.portfolioVersion,
        proposalId: input.proposalId,
      }),
      "utf8",
    )
    .digest("hex")
    .slice(0, 24);
  return `prg_pfo_${digest}`;
}
