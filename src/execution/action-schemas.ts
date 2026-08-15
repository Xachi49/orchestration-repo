import { z } from "zod";

/** Phase 7 executable action types only. */
export const PHASE7_ACTION_TYPES = [
  "CREATE_LOCAL_PATCH",
  "RUN_TESTS",
  "CREATE_TASK",
  "PREPARE_PULL_REQUEST",
] as const;

export type Phase7ActionType = (typeof PHASE7_ACTION_TYPES)[number];

export const PHASE7_ACTION_TYPE_SET = new Set<string>(PHASE7_ACTION_TYPES);

export const CreateLocalPatchArgsSchema = z
  .object({
    targetPaths: z.array(z.string().min(1)).min(1),
    patchContent: z.string().max(256_000),
    patchSummary: z.string().max(4000).optional(),
  })
  .strict();
export type CreateLocalPatchArgs = z.infer<typeof CreateLocalPatchArgsSchema>;

export const RunTestsArgsSchema = z
  .object({
    testProfileId: z.enum(["TYPECHECK", "UNIT_TESTS", "BUILD"]),
  })
  .strict();
export type RunTestsArgs = z.infer<typeof RunTestsArgsSchema>;

export const CreateTaskArgsSchema = z
  .object({
    title: z.string().min(1).max(500),
    description: z.string().max(8000),
    tags: z.array(z.string().max(100)).max(20).optional(),
  })
  .strict();
export type CreateTaskArgs = z.infer<typeof CreateTaskArgsSchema>;

export const PreparePullRequestArgsSchema = z
  .object({
    title: z.string().min(1).max(500),
    body: z.string().max(20_000),
    baseBranch: z.string().min(1).max(200),
    proposedHeadBranchName: z.string().min(1).max(200),
    associatedPatchReferences: z.array(z.string()).max(50).optional(),
  })
  .strict();
export type PreparePullRequestArgs = z.infer<
  typeof PreparePullRequestArgsSchema
>;

export const CapabilityExecutionSchemaMap = {
  CREATE_LOCAL_PATCH: CreateLocalPatchArgsSchema,
  RUN_TESTS: RunTestsArgsSchema,
  CREATE_TASK: CreateTaskArgsSchema,
  PREPARE_PULL_REQUEST: PreparePullRequestArgsSchema,
} as const;

export type CapabilityExecutionSchema =
  (typeof CapabilityExecutionSchemaMap)[Phase7ActionType];

export function isPhase7ActionType(value: string): value is Phase7ActionType {
  return PHASE7_ACTION_TYPE_SET.has(value);
}
