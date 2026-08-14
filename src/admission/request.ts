import { z } from "zod";
import {
  ObjectivePrioritySchema,
  ObjectiveVersionSchema,
} from "../domain/objective/objective.js";

export const AdmissionRequestSchema = z
  .object({
    projectId: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string()),
    constraints: z.array(z.string()),
    priority: ObjectivePrioritySchema,
    requesterId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    deadline: z.string().datetime().optional(),
    submittedAt: z.string().datetime(),
  })
  .strict();

export type AdmissionRequest = z.infer<typeof AdmissionRequestSchema>;

export function parseAdmissionRequest(input: unknown): AdmissionRequest {
  return AdmissionRequestSchema.parse(input);
}

export function safeParseAdmissionRequest(input: unknown) {
  return AdmissionRequestSchema.safeParse(input);
}
