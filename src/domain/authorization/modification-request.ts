import { z } from "zod";
import { PlanVersionSchema } from "../plan/execution-plan.js";

/**
 * Structured hand-off when a human requests modification.
 * Does not mutate the candidate plan. Does not enter Phase 5 revision.
 */
export const ModificationRequestSchema = z
  .object({
    modificationRequestId: z.string().min(1),
    runId: z.string().min(1),
    approvalRequestId: z.string().min(1),
    sourcePlanId: z.string().min(1),
    sourcePlanVersion: PlanVersionSchema,
    requestedBy: z.string().min(1),
    requestedAt: z.string().datetime(),
    modificationNote: z.string().min(1).max(4000),
  })
  .strict();

export type ModificationRequest = z.infer<typeof ModificationRequestSchema>;

export function parseModificationRequest(input: unknown): ModificationRequest {
  return ModificationRequestSchema.parse(input);
}
