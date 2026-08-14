import { z } from "zod";

export const ProjectStatusSchema = z.enum(["ACTIVE", "SUSPENDED", "ARCHIVED"]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const SensitivityClassificationSchema = z.enum([
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
]);
export type SensitivityClassification = z.infer<
  typeof SensitivityClassificationSchema
>;

/**
 * Configuration of how a project may eventually be executed.
 * This is configuration authority, not execution authority.
 *
 * PLAN_ONLY: planning and validation only; no side effects.
 * SUPERVISED: future external execution may occur only through explicit
 *   authorization and bounded executors.
 * PATCH_ONLY: future execution authority is limited to generating local
 *   patches/artifacts and running specifically permitted verification
 *   operations. It does not imply arbitrary filesystem mutation, deployment,
 *   permission changes, or pushes to protected branches.
 */
export const ExecutionModeSchema = z.enum([
  "PLAN_ONLY",
  "SUPERVISED",
  "PATCH_ONLY",
]);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const ProjectSchema = z
  .object({
    projectId: z.string().min(1),
    projectName: z.string().min(1),
    repositoryUrl: z.string().min(1),
    defaultBranch: z.string().min(1),
    workspaceRoot: z.string().min(1),
    allowedEnvironments: z.array(z.string().min(1)).min(1),
    executionMode: ExecutionModeSchema,
    activePolicyBundleId: z.string().min(1),
    resourceBudgetProfileId: z.string().min(1),
    authorizedApproverIds: z.array(z.string().min(1)),
    sensitivityClassification: SensitivityClassificationSchema,
    status: ProjectStatusSchema,
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type Project = z.infer<typeof ProjectSchema>;

export function parseProject(input: unknown): Project {
  return ProjectSchema.parse(input);
}
