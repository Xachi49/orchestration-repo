import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetResourceEstimateSchema } from "../control-plane/budgets/budget.js";
import type { BudgetResourceEstimate } from "../control-plane/budgets/budget.js";
import { emptyBudgetEstimate } from "../programs/budget.js";

export const ConcentrationBasisSchema = z.enum([
  "ESTIMATED_COST",
  "TOTAL_TOKENS",
]);
export type ConcentrationBasis = z.infer<typeof ConcentrationBasisSchema>;

/**
 * Subtractive Portfolio authorization envelope.
 * PortfolioAllocatedAuthority ⊆ Envelope ⊆ ControlPlaneAuthority.
 */
export const PortfolioAuthorizationEnvelopeSchema = z
  .object({
    allowedProjectIds: z.array(z.string().min(1)).min(1),
    allowedRepositoryIdentities: z.array(z.string().min(1)),
    allowedEnvironments: z.array(z.string().min(1)).min(1),
    allowedCapabilityIds: z.array(z.string().min(1)),
    maximumPortfolioBudget: BudgetResourceEstimateSchema,
    maximumProgramAllocation: BudgetResourceEstimateSchema,
    maximumProgramCount: z.number().int().positive().max(100),
    maximumConcurrentPrograms: z.number().int().positive().max(50),
    maximumCrossProjectPrograms: z.number().int().nonnegative().max(50),
    maximumModelCalls: z.number().int().nonnegative(),
    maximumTotalTokens: z.number().int().nonnegative(),
    timeHorizonDays: z.number().int().positive().max(3650),
    riskCeiling: z.enum(["LOW", "MEDIUM", "HIGH"]),
    allocationConcentrationCeiling: z.number().min(0).max(1),
    /**
     * Single dimension for Portfolio concentration. Authority-relevant:
     * changing basis changes envelope hash and validation outcome.
     */
    concentrationBasis: ConcentrationBasisSchema,
    crossProjectDelegationAllowed: z.boolean(),
  })
  .strict();

export type PortfolioAuthorizationEnvelope = z.infer<
  typeof PortfolioAuthorizationEnvelopeSchema
>;

export function parsePortfolioAuthorizationEnvelope(
  input: unknown,
): PortfolioAuthorizationEnvelope {
  return PortfolioAuthorizationEnvelopeSchema.parse(input);
}

export function portfolioAuthorizationEnvelopeHash(
  envelope: PortfolioAuthorizationEnvelope,
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalEnvelope(envelope)), "utf8")
    .digest("hex");
}

function canonicalEnvelope(
  envelope: PortfolioAuthorizationEnvelope,
): Record<string, unknown> {
  return {
    allocationConcentrationCeiling: envelope.allocationConcentrationCeiling,
    allowedCapabilityIds: [...envelope.allowedCapabilityIds].sort(),
    allowedEnvironments: [...envelope.allowedEnvironments].sort(),
    allowedProjectIds: [...envelope.allowedProjectIds].sort(),
    allowedRepositoryIdentities: [
      ...envelope.allowedRepositoryIdentities,
    ].sort(),
    concentrationBasis: envelope.concentrationBasis,
    crossProjectDelegationAllowed: envelope.crossProjectDelegationAllowed,
    maximumConcurrentPrograms: envelope.maximumConcurrentPrograms,
    maximumCrossProjectPrograms: envelope.maximumCrossProjectPrograms,
    maximumModelCalls: envelope.maximumModelCalls,
    maximumPortfolioBudget: envelope.maximumPortfolioBudget,
    maximumProgramAllocation: envelope.maximumProgramAllocation,
    maximumProgramCount: envelope.maximumProgramCount,
    maximumTotalTokens: envelope.maximumTotalTokens,
    riskCeiling: envelope.riskCeiling,
    timeHorizonDays: envelope.timeHorizonDays,
  };
}

export function defaultPortfolioEnvelope(input: {
  projectId: string;
  environment: string;
  capabilityIds?: readonly string[];
  repositoryIdentities?: readonly string[];
}): PortfolioAuthorizationEnvelope {
  const zero = emptyBudgetEstimate();
  return parsePortfolioAuthorizationEnvelope({
    allowedProjectIds: [input.projectId],
    allowedRepositoryIdentities: [...(input.repositoryIdentities ?? [])],
    allowedEnvironments: [input.environment],
    allowedCapabilityIds: [...(input.capabilityIds ?? [])],
    maximumPortfolioBudget: {
      ...zero,
      llmCalls: 100,
      totalTokens: 1_000_000,
      apiCalls: 500,
      executionMinutes: 600,
      estimatedCost: 250,
      humanReviewMinutes: 300,
      planSteps: 200,
      parallelWorkstreams: 16,
      revisionAttempts: 20,
    } satisfies BudgetResourceEstimate,
    maximumProgramAllocation: {
      ...zero,
      llmCalls: 40,
      totalTokens: 400_000,
      apiCalls: 200,
      executionMinutes: 240,
      estimatedCost: 100,
      humanReviewMinutes: 120,
      planSteps: 80,
      parallelWorkstreams: 8,
      revisionAttempts: 8,
    } satisfies BudgetResourceEstimate,
    maximumProgramCount: 12,
    maximumConcurrentPrograms: 4,
    maximumCrossProjectPrograms: 0,
    maximumModelCalls: 32,
    maximumTotalTokens: 1_000_000,
    timeHorizonDays: 90,
    riskCeiling: "MEDIUM",
    allocationConcentrationCeiling: 0.6,
    concentrationBasis: "ESTIMATED_COST",
    crossProjectDelegationAllowed: false,
  });
}
