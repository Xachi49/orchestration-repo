import { z } from "zod";
import { ObjectivePrioritySchema } from "../domain/objective/objective.js";
import { ProgramAuthorityFreezeSchema } from "./authority.js";
import { DelegationEnvelopeSchema } from "./delegation-envelope.js";
import { ProgramStateSchema } from "./program-state.js";

export const INITIAL_PROGRAM_VERSION = 1;

export const ProgramRootIntentSchema = z
  .object({
    requestedOutcome: z.string().min(1),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    nonGoals: z.array(z.string()),
    constraints: z.array(z.string()),
    priority: ObjectivePrioritySchema,
    deadline: z.string().datetime().optional(),
  })
  .strict();

export type ProgramRootIntent = z.infer<typeof ProgramRootIntentSchema>;

export const ProgramSchema = z
  .object({
    programId: z.string().min(1),
    programVersion: z.number().int().positive(),
    projectId: z.string().min(1),
    requesterId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    rootIntent: ProgramRootIntentSchema,
    status: ProgramStateSchema,
    delegationEnvelope: DelegationEnvelopeSchema,
    authorityFreeze: ProgramAuthorityFreezeSchema,
    programPlanVersion: z.number().int().positive().optional(),
    programPlanHash: z.string().min(1).optional(),
    decompositionRevisionCount: z.number().int().nonnegative().default(0),
    maximumDecompositionRevisions: z.number().int().nonnegative().default(2),
    paused: z.boolean().default(false),
    failureReasonCode: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    recordRevision: z.number().int().min(1).default(1),
    correlationId: z.string().min(1),
    traceId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    contentFingerprint: z.string().min(1),
  })
  .strict();

export type Program = z.infer<typeof ProgramSchema>;

export function parseProgram(input: unknown): Program {
  return ProgramSchema.parse(input);
}
