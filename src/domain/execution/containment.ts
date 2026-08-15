import { z } from "zod";

/**
 * Containment stops further automatic action. It is not rollback and not success.
 */
export const ContainmentResultSchema = z
  .object({
    contained: z.literal(true),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    reasonCode: z.string().min(1),
    reasonMessage: z.string().min(1),
    preservedStepIds: z.array(z.string()),
    preservedArtifactRefs: z.array(z.string()),
    containedAt: z.string().datetime(),
  })
  .strict();

export type ContainmentResult = z.infer<typeof ContainmentResultSchema>;

export function parseContainmentResult(input: unknown): ContainmentResult {
  return ContainmentResultSchema.parse(input);
}
