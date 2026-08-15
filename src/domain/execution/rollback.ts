import { z } from "zod";

/**
 * Rollback must be pre-authorized in the approved plan.
 * Phase 7 never invents rollback actions after failure.
 */
export const RollbackPlanSchema = z
  .object({
    rollbackPlanId: z.string().min(1),
    sourceStepId: z.string().min(1),
    compensatingStepIds: z.array(z.string().min(1)).min(1),
    strategy: z.enum(["COMPENSATING_ACTION", "MANUAL"]),
    instructions: z.array(z.string()).optional(),
    authorizedInPlan: z.literal(true),
  })
  .strict();

export type RollbackPlan = z.infer<typeof RollbackPlanSchema>;

export function parseRollbackPlan(input: unknown): RollbackPlan {
  return RollbackPlanSchema.parse(input);
}

/** Architecture invariant: at most one autonomous rollback per execution attempt. */
export const MAX_AUTOMATIC_ROLLBACKS = 1 as const;
