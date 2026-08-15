import { z } from "zod";
import { ObjectiveVersionSchema } from "../objective/objective.js";
import { PlanVersionSchema } from "../plan/execution-plan.js";
/**
 * Compressed human-review representation. No hidden reasoning.
 * Display-only formatting is not part of the hashed payload.
 */
export const ApprovalDecisionCardSchema = z
  .object({
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    objectiveOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    planId: z.string().min(1),
    planVersion: PlanVersionSchema,
    planHash: z.string().min(1),
    validationDecisionId: z.string().min(1),
    validationDecision: z.enum(["PASS", "BLOCK", "HUMAN_APPROVAL_REQUIRED"]),
    whyApprovalRequired: z.string().min(1),
    proposedActions: z.array(
      z
        .object({
          stepId: z.string().min(1),
          actionType: z.string().min(1),
          description: z.string().min(1),
          targetIds: z.array(z.string()),
        })
        .strict(),
    ),
    targetsAffected: z.array(z.string()),
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleId: z.string().min(1),
    policyBundleHash: z.string().min(1),
    blastRadius: z
      .object({
        stepCount: z.number().int().nonnegative(),
        actionTypes: z.array(z.string()),
        riskLevels: z.array(z.string()),
      })
      .strict(),
    estimatedResourceUsage: z
      .object({
        cpuUnits: z.number().nonnegative().optional(),
        memoryMb: z.number().nonnegative().optional(),
        durationMs: z.number().nonnegative().optional(),
        tokenEstimate: z.number().nonnegative().optional(),
        costEstimateUsd: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    verificationStrategy: z.array(z.string()),
    rollbackContainmentStrategy: z.array(z.string()),
    unresolvedAssumptions: z.array(z.string()),
    planningExceptionSummary: z
      .object({
        exceptionId: z.string().min(1),
        exceptionType: z.string().min(1),
        message: z.string().min(1),
        reasonCodes: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
    approvalEligibleFindingSummaries: z.array(z.string()),
    /**
     * System-derived fingerprint of Control Plane capability authority for
     * plan-referenced actions. Bound into decisionCardHash. Not caller-supplied.
     */
    capabilitySetFingerprint: z.string().min(1),
    /**
     * Human-readable capability/action scope authorized by this card.
     * Authority material — included in decisionCardHash.
     */
    capabilityAuthorityScope: z.array(
      z
        .object({
          capabilityId: z.string().min(1),
          allowedActions: z.array(z.string().min(1)),
          maximumRuntimeSeconds: z.number().int().nonnegative(),
          enabled: z.boolean(),
          allowedEnvironments: z.array(z.string().min(1)),
        })
        .strict(),
    ),
    /**
     * Human-readable verification coverage: WHAT / HOW / WHICH for each criterion.
     * Authoritative — participates in decisionCardHash.
     * THE HUMAN AUTHORIZES BOTH THE ACTION AND THE DEFINITION OF PROOF.
     */
    verificationCoverageSummary: z.array(
      z
        .object({
          criterionId: z.string().min(1),
          criterionText: z.string().min(1),
          verificationMethod: z.string().min(1),
          howVerified: z.string().min(1),
          stepIds: z.array(z.string().min(1)),
          evidenceExpectation: z.string().min(1),
        })
        .strict(),
    ),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();

export type ApprovalDecisionCard = z.infer<typeof ApprovalDecisionCardSchema>;

export function parseApprovalDecisionCard(
  input: unknown,
): ApprovalDecisionCard {
  return ApprovalDecisionCardSchema.parse(input);
}
