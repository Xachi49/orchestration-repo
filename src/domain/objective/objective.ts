import { z } from "zod";

export const ObjectivePrioritySchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
]);

export type ObjectivePriority = z.infer<typeof ObjectivePrioritySchema>;

export const ObjectiveSchema = z
  .object({
    objectiveId: z.string().min(1),
    objectiveVersion: z.string().min(1),
    projectId: z.string().min(1),
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string()),
    constraints: z.array(z.string()),
    priority: ObjectivePrioritySchema,
    requesterId: z.string().min(1),
    deadline: z.string().datetime().optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type Objective = z.infer<typeof ObjectiveSchema>;

export function parseObjective(input: unknown): Objective {
  return ObjectiveSchema.parse(input);
}

export function safeParseObjective(input: unknown) {
  return ObjectiveSchema.safeParse(input);
}
