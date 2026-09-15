import { z } from "zod";

/** Phase 7 executable action types — core + registered product extensions. */
export const PHASE7_ACTION_TYPES = [
  "CREATE_LOCAL_PATCH",
  "RUN_TESTS",
  "CREATE_TASK",
  "PREPARE_PULL_REQUEST",
  "SEND_RECOVERY_SMS",
  "SEND_RECOVERY_EMAIL",
  "CREATE_CALLBACK_TASK",
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

/**
 * Recovery outreach args — recipient is NEVER trusted from the plan.
 * Actuator resolves phone/email from the canonical lead at actuation time.
 */
export const SendRecoverySmsArgsSchema = z
  .object({
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
  })
  .strict();
export type SendRecoverySmsArgs = z.infer<typeof SendRecoverySmsArgsSchema>;

export const SendRecoveryEmailArgsSchema = z
  .object({
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
  })
  .strict();
export type SendRecoveryEmailArgs = z.infer<typeof SendRecoveryEmailArgsSchema>;

export const CreateCallbackTaskArgsSchema = z
  .object({
    recoveryCaseId: z.string().min(1),
    leadId: z.string().min(1),
    note: z.string().max(500).optional(),
  })
  .strict();
export type CreateCallbackTaskArgs = z.infer<
  typeof CreateCallbackTaskArgsSchema
>;

export const CapabilityExecutionSchemaMap = {
  CREATE_LOCAL_PATCH: CreateLocalPatchArgsSchema,
  RUN_TESTS: RunTestsArgsSchema,
  CREATE_TASK: CreateTaskArgsSchema,
  PREPARE_PULL_REQUEST: PreparePullRequestArgsSchema,
  SEND_RECOVERY_SMS: SendRecoverySmsArgsSchema,
  SEND_RECOVERY_EMAIL: SendRecoveryEmailArgsSchema,
  CREATE_CALLBACK_TASK: CreateCallbackTaskArgsSchema,
} as const;

export type CapabilityExecutionSchema =
  (typeof CapabilityExecutionSchemaMap)[Phase7ActionType];

export function isPhase7ActionType(value: string): value is Phase7ActionType {
  return PHASE7_ACTION_TYPE_SET.has(value);
}

export function isRecoveryPhase7ActionType(
  value: string,
): value is
  | "SEND_RECOVERY_SMS"
  | "SEND_RECOVERY_EMAIL"
  | "CREATE_CALLBACK_TASK" {
  return (
    value === "SEND_RECOVERY_SMS" ||
    value === "SEND_RECOVERY_EMAIL" ||
    value === "CREATE_CALLBACK_TASK"
  );
}
