import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetResourceEstimateSchema } from "../control-plane/budgets/budget.js";
import { PortfolioGoalContributionBindingSchema } from "./plan.js";

export const PortfolioProgramLineageSchema = z
  .object({
    lineageId: z.string().min(1),
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    portfolioPlanVersion: z.number().int().positive(),
    portfolioPlanHash: z.string().min(1),
    proposalId: z.string().min(1),
    programId: z.string().min(1),
    programVersion: z.number().int().positive(),
    allocationId: z.string().min(1),
    goalBindings: z.array(PortfolioGoalContributionBindingSchema).default([]),
    materializationStatus: z.enum([
      "PENDING",
      "ADMITTED",
      "DUPLICATE",
      "FAILED",
    ]),
    failureReasonCode: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type PortfolioProgramLineage = z.infer<
  typeof PortfolioProgramLineageSchema
>;

export function portfolioLineageIdFor(input: {
  portfolioId: string;
  portfolioPlanVersion: number;
  proposalId: string;
}): string {
  return `pfl_${input.portfolioId}_${input.portfolioPlanVersion}_${input.proposalId}`.slice(
    0,
    120,
  );
}

export const PortfolioAuthorizationRequestSchema = z
  .object({
    authorizationId: z.string().min(1),
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    portfolioPlanVersion: z.number().int().positive(),
    portfolioPlanHash: z.string().min(1),
    authorizationEnvelopeHash: z.string().min(1),
    policyBundleFingerprint: z.string().min(1),
    capabilityFingerprint: z.string().min(1),
    budgetFingerprint: z.string().min(1),
    projectScopeFingerprint: z.string().min(1),
    repositoryAllowlistFingerprint: z.string().min(1),
    environmentScopeFingerprint: z.string().min(1),
    allocationPlanHash: z.string().min(1),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    status: z.enum(["PENDING", "APPROVED", "REJECTED", "EXPIRED"]),
    allocatorId: z.string().min(1).optional(),
    decidedAt: z.string().datetime().optional(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
    recordRevision: z.number().int().min(1),
  })
  .strict();

export type PortfolioAuthorizationRequest = z.infer<
  typeof PortfolioAuthorizationRequestSchema
>;

export const PortfolioAuthorizationDecisionSchema = z
  .object({
    authorizationId: z.string().min(1),
    portfolioId: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT"]),
    allocatorId: z.string().min(1),
    decisionNonce: z.string().min(1),
    decidedAt: z.string().datetime(),
  })
  .strict();

export type PortfolioAuthorizationDecision = z.infer<
  typeof PortfolioAuthorizationDecisionSchema
>;

export const PortfolioAuthorizationRecordSchema = z
  .object({
    authorizationRecordId: z.string().min(1),
    authorizationId: z.string().min(1),
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    portfolioPlanVersion: z.number().int().positive(),
    portfolioPlanHash: z.string().min(1),
    authorizationEnvelopeHash: z.string().min(1),
    allocationPlanHash: z.string().min(1),
    allocatorId: z.string().min(1),
    decision: z.literal("APPROVE"),
    subjectHash: z.string().min(1),
    decisionNonceHash: z.string().min(1),
    decidedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type PortfolioAuthorizationRecord = z.infer<
  typeof PortfolioAuthorizationRecordSchema
>;

export const PORTFOLIO_OUTCOME_CLASSES = [
  "VERIFIED_SUCCESS",
  "PARTIAL_SUCCESS",
  "PORTFOLIO_FAILED",
  "INCONCLUSIVE",
  "REBALANCE_REQUIRED",
] as const;

export const PortfolioOutcomeClassSchema = z.enum(PORTFOLIO_OUTCOME_CLASSES);
export type PortfolioOutcomeClass = z.infer<typeof PortfolioOutcomeClassSchema>;

export const PortfolioCompletionRecordSchema = z
  .object({
    portfolioCompletionRecordId: z.string().min(1),
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    portfolioPlanVersion: z.number().int().positive(),
    portfolioPlanHash: z.string().min(1),
    outcome: z.literal("VERIFIED_SUCCESS"),
    goalResults: z.array(
      z
        .object({
          goalId: z.string().min(1),
          satisfied: z.literal(true),
          evidenceRefs: z.array(z.string().min(1)).min(1),
        })
        .strict(),
    ),
    createdAt: z.string().datetime(),
  })
  .strict();

export type PortfolioCompletionRecord = z.infer<
  typeof PortfolioCompletionRecordSchema
>;

export const PortfolioRebalanceProposalSchema = z
  .object({
    rebalanceId: z.string().min(1),
    portfolioId: z.string().min(1),
    portfolioVersion: z.number().int().positive(),
    trigger: z.enum([
      "VERIFIED_PROGRAM_FAILURE",
      "PROGRAM_COMPLETION",
      "DEADLINE_DRIFT",
      "BUDGET_EXHAUSTION",
      "AUTHORITY_DRIFT",
      "GOAL_COVERAGE_GAP",
      "PERFORMANCE_DEVIATION",
    ]),
    rationale: z.string().min(1),
    proposedDispositions: z.array(z.string()).default([]),
    requiresNewAuthorization: z.literal(true),
    createdAt: z.string().datetime(),
    status: z.enum(["PROPOSED", "SUPERSEDED", "APPLIED_VIA_REPLAN"]),
  })
  .strict();

export type PortfolioRebalanceProposal = z.infer<
  typeof PortfolioRebalanceProposalSchema
>;

export function computeAuthorizationSubjectHash(input: {
  portfolioId: string;
  portfolioVersion: number;
  portfolioPlanVersion: number;
  portfolioPlanHash: string;
  authorizationEnvelopeHash: string;
  policyFingerprint: string;
  capabilityFingerprint: string;
  budgetFingerprint: string;
  allocationPlanHash: string;
  expiresAt: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input), "utf8")
    .digest("hex");
}

export const PortfolioProgressSchema = z
  .object({
    portfolioId: z.string().min(1),
    programCountsByState: z.record(z.string(), z.number().int().nonnegative()),
    allocatedBudget: BudgetResourceEstimateSchema.optional(),
    reservedBudget: BudgetResourceEstimateSchema.optional(),
    goalCoverage: z.array(
      z
        .object({
          goalId: z.string().min(1),
          status: z.string().min(1),
        })
        .strict(),
    ),
    stalledPrograms: z.array(z.string()).default([]),
    rebalanceRequired: z.boolean(),
    /** NON-AUTHORITATIVE observational percentage. */
    observationalProgressPercent: z.number().min(0).max(100).optional(),
    computedAt: z.string().datetime(),
  })
  .strict();

export type PortfolioProgress = z.infer<typeof PortfolioProgressSchema>;
