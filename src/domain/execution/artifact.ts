import { z } from "zod";

export const ExecutionArtifactTypeSchema = z.enum([
  "PATCH",
  "TEST_RESULT",
  "TASK",
  "PR_PREPARATION",
  "ROLLBACK",
  "OTHER",
]);
export type ExecutionArtifactType = z.infer<typeof ExecutionArtifactTypeSchema>;

/**
 * Local run-scoped artifact metadata. Paths must stay under safe artifact root.
 */
export const ExecutionArtifactSchema = z
  .object({
    artifactId: z.string().min(1),
    runId: z.string().min(1),
    executionAttemptId: z.string().min(1),
    stepId: z.string().min(1),
    artifactType: ExecutionArtifactTypeSchema,
    relativePath: z.string().min(1),
    contentHash: z.string().min(1),
    size: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ExecutionArtifact = z.infer<typeof ExecutionArtifactSchema>;

export function parseExecutionArtifact(input: unknown): ExecutionArtifact {
  return ExecutionArtifactSchema.parse(input);
}
