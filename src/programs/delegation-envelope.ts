import { createHash } from "node:crypto";
import { z } from "zod";
import { BudgetResourceEstimateSchema } from "../control-plane/budgets/budget.js";

/**
 * Subtractive authority bound at Program admission.
 * DELEGATION != BUDGET CREATION. ChildAuthority ⊆ Envelope ⊆ Parent.
 */
export const DelegationEnvelopeSchema = z
  .object({
    allowedProjectIds: z.array(z.string().min(1)).min(1),
    allowedEnvironments: z.array(z.string().min(1)).min(1),
    allowedRepositoryIdentities: z.array(z.string().min(1)),
    allowedCapabilityIds: z.array(z.string().min(1)),
    /** Program-level ceiling (units of BudgetResourceEstimate). */
    maximumProgramBudget: BudgetResourceEstimateSchema,
    /** Per-child ceiling; must be ≤ program ceiling per dimension. */
    maximumChildBudget: BudgetResourceEstimateSchema,
    maximumChildren: z.number().int().positive().max(100),
    maximumDepth: z.number().int().positive().max(10),
    maximumFanOut: z.number().int().positive().max(50),
    maximumConcurrentChildren: z.number().int().positive().max(50),
    maximumModelCalls: z.number().int().nonnegative(),
    maximumTotalTokens: z.number().int().nonnegative(),
    deadline: z.string().datetime().optional(),
    crossProjectDelegationAllowed: z.boolean(),
    materializationApprovalRequired: z.boolean(),
  })
  .strict();

export type DelegationEnvelope = z.infer<typeof DelegationEnvelopeSchema>;

export function parseDelegationEnvelope(input: unknown): DelegationEnvelope {
  return DelegationEnvelopeSchema.parse(input);
}

export function delegationEnvelopeHash(envelope: DelegationEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalDelegationEnvelope(envelope)), "utf8")
    .digest("hex");
}

function canonicalDelegationEnvelope(
  envelope: DelegationEnvelope,
): Record<string, unknown> {
  return {
    allowedCapabilityIds: [...envelope.allowedCapabilityIds].sort(),
    allowedEnvironments: [...envelope.allowedEnvironments].sort(),
    allowedProjectIds: [...envelope.allowedProjectIds].sort(),
    allowedRepositoryIdentities: [
      ...envelope.allowedRepositoryIdentities,
    ].sort(),
    crossProjectDelegationAllowed: envelope.crossProjectDelegationAllowed,
    deadline: envelope.deadline ?? null,
    materializationApprovalRequired: envelope.materializationApprovalRequired,
    maximumChildBudget: envelope.maximumChildBudget,
    maximumChildren: envelope.maximumChildren,
    maximumConcurrentChildren: envelope.maximumConcurrentChildren,
    maximumDepth: envelope.maximumDepth,
    maximumFanOut: envelope.maximumFanOut,
    maximumModelCalls: envelope.maximumModelCalls,
    maximumProgramBudget: envelope.maximumProgramBudget,
    maximumTotalTokens: envelope.maximumTotalTokens,
  };
}

/** Default conservative envelope for same-project programs. */
export function defaultDelegationEnvelope(input: {
  projectId: string;
  environment: string;
  capabilityIds?: readonly string[];
  repositoryIdentities?: readonly string[];
}): DelegationEnvelope {
  const zero = {
    llmCalls: 0,
    totalTokens: 0,
    apiCalls: 0,
    executionMinutes: 0,
    estimatedCost: 0,
    humanReviewMinutes: 0,
    planSteps: 0,
    parallelWorkstreams: 0,
    revisionAttempts: 0,
  };
  return parseDelegationEnvelope({
    allowedProjectIds: [input.projectId],
    allowedEnvironments: [input.environment],
    allowedRepositoryIdentities: [...(input.repositoryIdentities ?? [])],
    allowedCapabilityIds: [...(input.capabilityIds ?? [])],
    maximumProgramBudget: {
      ...zero,
      llmCalls: 20,
      totalTokens: 200_000,
      apiCalls: 100,
      executionMinutes: 120,
      estimatedCost: 50,
      humanReviewMinutes: 60,
      planSteps: 40,
      parallelWorkstreams: 4,
      revisionAttempts: 4,
    },
    maximumChildBudget: {
      ...zero,
      llmCalls: 10,
      totalTokens: 100_000,
      apiCalls: 50,
      executionMinutes: 60,
      estimatedCost: 25,
      humanReviewMinutes: 30,
      planSteps: 20,
      parallelWorkstreams: 2,
      revisionAttempts: 2,
    },
    maximumChildren: 12,
    maximumDepth: 3,
    maximumFanOut: 6,
    maximumConcurrentChildren: 4,
    maximumModelCalls: 8,
    maximumTotalTokens: 200_000,
    crossProjectDelegationAllowed: false,
    materializationApprovalRequired: true,
  });
}
