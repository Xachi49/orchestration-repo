import { z } from "zod";
import { ObjectiveVersionSchema } from "../objective/objective.js";

export const ResourceEstimateSchema = z
  .object({
    cpuUnits: z.number().nonnegative().optional(),
    memoryMb: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokenEstimate: z.number().nonnegative().optional(),
    costEstimateUsd: z.number().nonnegative().optional(),
  })
  .strict();

export type ResourceEstimate = z.infer<typeof ResourceEstimateSchema>;

export const RiskLevelSchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const StepRiskSchema = z
  .object({
    level: RiskLevelSchema,
    categories: z.array(z.string()),
    notes: z.array(z.string()).optional(),
  })
  .strict();

export type StepRisk = z.infer<typeof StepRiskSchema>;

export const StepValidationSpecSchema = z
  .object({
    checks: z.array(z.string().min(1)),
    requiredEvidenceRefs: z.array(z.string()).optional(),
  })
  .strict();

export type StepValidationSpec = z.infer<typeof StepValidationSpecSchema>;

export const StepRollbackSpecSchema = z
  .object({
    strategy: z.enum(["NONE", "COMPENSATING_ACTION", "MANUAL"]),
    compensatingStepIds: z.array(z.string()).optional(),
    instructions: z.array(z.string()).optional(),
  })
  .strict();

export type StepRollbackSpec = z.infer<typeof StepRollbackSpecSchema>;

export const ExecutionStepSchema = z
  .object({
    stepId: z.string().min(1),
    actionType: z.string().min(1),
    description: z.string().min(1),
    targetIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    dependsOn: z.array(z.string()),
    preconditions: z.array(z.string()),
    expectedPostconditions: z.array(z.string()),
    resourceEstimate: ResourceEstimateSchema,
    risk: StepRiskSchema,
    validation: StepValidationSpecSchema,
    rollback: StepRollbackSpecSchema,
    idempotencyKey: z.string().min(1),
  })
  .strict();

export type ExecutionStep = z.infer<typeof ExecutionStepSchema>;

export const WorkstreamSchema = z
  .object({
    workstreamId: z.string().min(1),
    name: z.string().min(1),
    stepIds: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type Workstream = z.infer<typeof WorkstreamSchema>;

export const ApprovalRequirementSchema = z
  .object({
    requirementId: z.string().min(1),
    kind: z.enum(["HUMAN", "POLICY", "BUDGET", "SECURITY"]),
    description: z.string().min(1),
    requiredRoleIds: z.array(z.string()).optional(),
  })
  .strict();

export type ApprovalRequirement = z.infer<typeof ApprovalRequirementSchema>;

export const FailurePolicySchema = z
  .object({
    onStepFailure: z.enum([
      "FAIL_RUN",
      "BLOCK",
      "ESCALATE",
      "ROLLBACK_REQUIRED",
      "CONTAIN",
    ]),
    maxRetries: z.number().int().nonnegative(),
    escalateAfterFailures: z.number().int().positive().optional(),
  })
  .strict();

export type FailurePolicy = z.infer<typeof FailurePolicySchema>;

export const ResourceTotalsSchema = z
  .object({
    cpuUnits: z.number().nonnegative().optional(),
    memoryMb: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokenEstimate: z.number().nonnegative().optional(),
    costEstimateUsd: z.number().nonnegative().optional(),
  })
  .strict();

export type ResourceTotals = z.infer<typeof ResourceTotalsSchema>;

/**
 * Top-level execution plan contract.
 * `planHash` is computed over the canonical form excluding itself.
 */
export const ExecutionPlanSchema = z
  .object({
    planId: z.string().min(1),
    planVersion: z.string().min(1),
    objectiveId: z.string().min(1),
    objectiveVersion: ObjectiveVersionSchema,
    repositoryCommitSha: z.string().min(1),
    repositoryFingerprint: z.string().min(1),
    policyBundleId: z.string().min(1),
    policyBundleHash: z.string().min(1),
    schemaVersion: z.string().min(1),
    assumptions: z.array(z.string()),
    unknowns: z.array(z.string()),
    successDefinition: z.array(z.string().min(1)).min(1),
    resourceTotals: ResourceTotalsSchema,
    criticalPath: z.array(z.string()),
    workstreams: z.array(WorkstreamSchema),
    steps: z.array(ExecutionStepSchema),
    approvalRequirements: z.array(ApprovalRequirementSchema),
    failurePolicy: FailurePolicySchema,
    planHash: z.string().min(1),
  })
  .strict();

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

/** Plan payload used for hashing — identical to ExecutionPlan without planHash. */
export const ExecutionPlanForHashSchema = ExecutionPlanSchema.omit({
  planHash: true,
});

export type ExecutionPlanForHash = z.infer<typeof ExecutionPlanForHashSchema>;

export function parseExecutionPlan(input: unknown): ExecutionPlan {
  return ExecutionPlanSchema.parse(input);
}

export function parseExecutionStep(input: unknown): ExecutionStep {
  return ExecutionStepSchema.parse(input);
}
