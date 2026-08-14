import { z } from "zod";

export const ExecutionWindowSchema = z
  .object({
    windowId: z.string().min(1),
    daysOfWeek: z.array(z.number().int().min(0).max(6)),
    startTimeUtc: z.string().regex(/^\d{2}:\d{2}$/),
    endTimeUtc: z.string().regex(/^\d{2}:\d{2}$/),
  })
  .strict();
export type ExecutionWindow = z.infer<typeof ExecutionWindowSchema>;

/**
 * Stored configuration authority; runtime enforcement deferred to the
 * admission/execution phases.
 *
 * Phase 1 stores `allowedExecutionWindows` and validates their schema.
 * It does NOT enforce wall-clock execution windows.
 */
export const ResourceBudgetProfileSchema = z
  .object({
    budgetProfileId: z.string().min(1),
    maximumLlmCalls: z.number().nonnegative(),
    maximumTotalTokens: z.number().nonnegative(),
    maximumApiCalls: z.number().nonnegative(),
    maximumExecutionMinutes: z.number().nonnegative(),
    maximumEstimatedCost: z.number().nonnegative(),
    maximumHumanReviewMinutes: z.number().nonnegative(),
    maximumPlanSteps: z.number().int().nonnegative(),
    maximumParallelWorkstreams: z.number().int().nonnegative(),
    maximumRevisionAttempts: z.number().int().nonnegative(),
    allowedExecutionWindows: z.array(ExecutionWindowSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();
export type ResourceBudgetProfile = z.infer<typeof ResourceBudgetProfileSchema>;

export function parseResourceBudgetProfile(
  input: unknown,
): ResourceBudgetProfile {
  return ResourceBudgetProfileSchema.parse(input);
}

/**
 * Planned consumption against a budget profile.
 * Distinct from plan-step ResourceEstimate (Phase 0).
 */
export const BudgetResourceEstimateSchema = z
  .object({
    llmCalls: z.number().nonnegative(),
    totalTokens: z.number().nonnegative(),
    apiCalls: z.number().nonnegative(),
    executionMinutes: z.number().nonnegative(),
    estimatedCost: z.number().nonnegative(),
    humanReviewMinutes: z.number().nonnegative(),
    planSteps: z.number().int().nonnegative(),
    parallelWorkstreams: z.number().int().nonnegative(),
    revisionAttempts: z.number().int().nonnegative(),
  })
  .strict();
export type BudgetResourceEstimate = z.infer<
  typeof BudgetResourceEstimateSchema
>;

export const BudgetComparisonResultSchema = z.enum([
  "WITHIN_BUDGET",
  "BUDGET_EXCEEDED",
  "UNESTIMATED_RESOURCE",
]);
export type BudgetComparisonResult = z.infer<
  typeof BudgetComparisonResultSchema
>;

export const BUDGET_DIMENSIONS = [
  "llmCalls",
  "totalTokens",
  "apiCalls",
  "executionMinutes",
  "estimatedCost",
  "humanReviewMinutes",
  "planSteps",
  "parallelWorkstreams",
  "revisionAttempts",
] as const;

export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];

export const BUDGET_LIMIT_BY_DIMENSION = {
  llmCalls: "maximumLlmCalls",
  totalTokens: "maximumTotalTokens",
  apiCalls: "maximumApiCalls",
  executionMinutes: "maximumExecutionMinutes",
  estimatedCost: "maximumEstimatedCost",
  humanReviewMinutes: "maximumHumanReviewMinutes",
  planSteps: "maximumPlanSteps",
  parallelWorkstreams: "maximumParallelWorkstreams",
  revisionAttempts: "maximumRevisionAttempts",
} as const satisfies Record<
  BudgetDimension,
  keyof Pick<
    ResourceBudgetProfile,
    | "maximumLlmCalls"
    | "maximumTotalTokens"
    | "maximumApiCalls"
    | "maximumExecutionMinutes"
    | "maximumEstimatedCost"
    | "maximumHumanReviewMinutes"
    | "maximumPlanSteps"
    | "maximumParallelWorkstreams"
    | "maximumRevisionAttempts"
  >
>;
