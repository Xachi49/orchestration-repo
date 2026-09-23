/**
 * Operator control-plane provisioning manifest.
 *
 * PROVISIONING != EXECUTION AUTHORITY
 * CLI INVOCATION != PHASE 6 AUTHORIZATION
 * CONTROL-PLANE PROVISIONING != OUTREACH AUTHORIZATION
 */
import { z } from "zod";
import {
  ExecutionModeSchema,
  ProjectStatusSchema,
  SensitivityClassificationSchema,
} from "../projects/project.js";
import { PolicyEffectSchema, PolicyStatusSchema } from "../policies/policy.js";
import { CapabilityApprovalRequirementSchema } from "../capabilities/capability.js";
import { ExecutionWindowSchema } from "../budgets/budget.js";

const ManifestPolicyRuleSchema = z
  .object({
    ruleId: z.string().min(1),
    description: z.string().min(1),
    effect: PolicyEffectSchema,
    actionTypes: z.array(z.string().min(1)),
    environments: z.array(z.string().min(1)),
    conditions: z
      .array(
        z
          .object({
            attribute: z.string().min(1),
            operator: z.enum(["EQ", "NEQ", "IN", "NOT_IN"]),
            value: z.union([
              z.string().min(1),
              z.array(z.string().min(1)).min(1),
            ]),
          })
          .strict(),
      )
      .default([]),
    reasonCode: z.string().min(1),
  })
  .strict();

/** Timestamps and policyHash are issued by the provisioning service. */
export const ControlPlaneProvisionManifestSchema = z
  .object({
    project: z
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
      })
      .strict(),
    policyBundle: z
      .object({
        policyBundleId: z.string().min(1),
        semanticVersion: z.string().min(1),
        supersedes: z.string().min(1).nullable().default(null),
        applicableProjectIds: z.array(z.string().min(1)).min(1),
        applicableEnvironments: z.array(z.string().min(1)).min(1),
        approvedBy: z.string().min(1),
        status: PolicyStatusSchema,
        rules: z.array(ManifestPolicyRuleSchema).min(1),
      })
      .strict(),
    budgetProfile: z
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
      })
      .strict(),
    capabilities: z
      .array(
        z
          .object({
            capabilityId: z.string().min(1),
            version: z.string().min(1),
            description: z.string().min(1),
            allowedActions: z.array(z.string().min(1)),
            forbiddenActions: z.array(z.string().min(1)),
            allowedEnvironments: z.array(z.string().min(1)).min(1),
            approvalRequirement: CapabilityApprovalRequirementSchema,
            maximumRuntimeSeconds: z.number().int().nonnegative(),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .default([]),
    requesterGrants: z
      .array(
        z
          .object({
            requesterId: z.string().min(1),
            projectId: z.string().min(1),
            environments: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    approverGrants: z
      .array(
        z
          .object({
            approverId: z.string().min(1),
            projectId: z.string().min(1),
            environments: z.array(z.string().min(1)).min(1),
          })
          .strict(),
      )
      .min(1),
    repositorySource: z
      .object({
        projectId: z.string().min(1),
        provider: z.literal("GITHUB"),
        owner: z.string().min(1),
        repository: z.string().min(1),
        defaultBranch: z.string().min(1),
        remoteUrl: z.string().min(1),
        installationAccountRef: z.string().min(1).optional(),
        enabled: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const projectId = manifest.project.projectId;
    if (manifest.project.activePolicyBundleId !== manifest.policyBundle.policyBundleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "project.activePolicyBundleId must equal policyBundle.policyBundleId",
        path: ["project", "activePolicyBundleId"],
      });
    }
    if (
      manifest.project.resourceBudgetProfileId !==
      manifest.budgetProfile.budgetProfileId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "project.resourceBudgetProfileId must equal budgetProfile.budgetProfileId",
        path: ["project", "resourceBudgetProfileId"],
      });
    }
    if (!manifest.policyBundle.applicableProjectIds.includes(projectId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "policyBundle must include projectId in applicableProjectIds",
        path: ["policyBundle", "applicableProjectIds"],
      });
    }
    for (const env of manifest.project.allowedEnvironments) {
      if (!manifest.policyBundle.applicableEnvironments.includes(env)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `policyBundle missing project environment ${env}`,
          path: ["policyBundle", "applicableEnvironments"],
        });
      }
    }
    for (const grant of manifest.requesterGrants) {
      if (grant.projectId !== projectId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "requester grant projectId must match project.projectId",
          path: ["requesterGrants"],
        });
      }
    }
    for (const grant of manifest.approverGrants) {
      if (grant.projectId !== projectId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "approver grant projectId must match project.projectId",
          path: ["approverGrants"],
        });
      }
    }
    if (
      manifest.repositorySource &&
      manifest.repositorySource.projectId !== projectId
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "repositorySource.projectId must match project.projectId",
        path: ["repositorySource", "projectId"],
      });
    }
  });

export type ControlPlaneProvisionManifest = z.infer<
  typeof ControlPlaneProvisionManifestSchema
>;

export function parseControlPlaneProvisionManifest(
  input: unknown,
): ControlPlaneProvisionManifest {
  return ControlPlaneProvisionManifestSchema.parse(input);
}
