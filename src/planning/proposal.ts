import { z } from "zod";
import {
  RiskLevelSchema,
  ResourceEstimateSchema,
} from "../domain/plan/execution-plan.js";

/**
 * Probabilistic model proposal — NOT the authoritative ExecutionPlan.
 * Model must not assign planHash, planId, planVersion, or approval/policy decisions.
 */
export const ProposedStepSchema = z
  .object({
    stepId: z.string().min(1),
    actionType: z.string().min(1),
    description: z.string().min(1),
    targetIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    dependsOn: z.array(z.string()),
    preconditions: z.array(z.string()),
    expectedPostconditions: z.array(z.string()),
    resourceEstimate: ResourceEstimateSchema,
    risk: z
      .object({
        level: RiskLevelSchema,
        categories: z.array(z.string()),
        notes: z.array(z.string()).optional(),
      })
      .strict(),
    validationChecks: z.array(z.string().min(1)).min(1),
    rollbackStrategy: z.enum(["NONE", "COMPENSATING_ACTION", "MANUAL"]),
    rollbackInstructions: z.array(z.string()).optional(),
  })
  .strict();
export type ProposedStep = z.infer<typeof ProposedStepSchema>;

export const ProposedWorkstreamSchema = z
  .object({
    workstreamId: z.string().min(1),
    name: z.string().min(1),
    stepIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export const GapAnalysisSchema = z
  .object({
    existingCapabilities: z.array(z.string()),
    missingCapabilities: z.array(z.string()),
    brokenOrInsufficientCapabilities: z.array(z.string()),
    requiredDependencies: z.array(z.string()),
    constraints: z.array(z.string()),
    unknowns: z.array(z.string()),
    assumptions: z.array(z.string()),
    contradictions: z.array(z.string()),
    blockedPrerequisites: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    acceptanceCriteriaCoverage: z.array(
      z
        .object({
          criterion: z.string().min(1),
          covered: z.boolean(),
          notes: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type GapAnalysis = z.infer<typeof GapAnalysisSchema>;

export const PlanProposalSchema = z
  .object({
    gapAnalysis: GapAnalysisSchema,
    workstreams: z.array(ProposedWorkstreamSchema).min(1),
    steps: z.array(ProposedStepSchema).min(1),
    successDefinition: z.array(z.string().min(1)).min(1),
    assumptions: z.array(z.string()),
    unknowns: z.array(z.string()),
    proposedRisks: z.array(z.string()),
    proposedVerificationChecks: z.array(z.string()),
    proposedRollbackApproach: z.string().min(1),
    proposedResourceTotals: z
      .object({
        estimatedDurationMinutes: z.number().nonnegative(),
        estimatedLlmTokens: z.number().nonnegative(),
        estimatedApiCalls: z.number().nonnegative(),
        estimatedHumanMinutes: z.number().nonnegative(),
        estimatedCost: z.number().nonnegative(),
        maximumParallelWorkstreams: z.number().int().positive(),
        estimatedLlmCalls: z.number().nonnegative().optional(),
      })
      .strict(),
    conciseRationale: z.string().min(1),
  })
  .strict();
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export function parsePlanProposal(input: unknown): PlanProposal {
  return PlanProposalSchema.parse(input);
}
