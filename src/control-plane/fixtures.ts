import type { Capability } from "./capabilities/capability.js";
import type { PolicyBundle } from "./policies/policy.js";
import type { Project } from "./projects/project.js";
import type { ResourceBudgetProfile } from "./budgets/budget.js";

const CREATED_AT = "2026-08-01T00:00:00.000Z";
const UPDATED_AT = "2026-08-13T00:00:00.000Z";

/**
 * Example fixtures for the discord-scale-architect target project.
 * These grant no real external authority.
 */
export const EXAMPLE_PROJECT_ID = "discord-scale-architect";
export const EXAMPLE_POLICY_BUNDLE_ID = "pol_discord_scale_architect_v1";
export const EXAMPLE_BUDGET_PROFILE_ID = "budget_discord_scale_local";
export const EXAMPLE_ENVIRONMENT = "local";

export const EXAMPLE_BUDGET: ResourceBudgetProfile = {
  budgetProfileId: EXAMPLE_BUDGET_PROFILE_ID,
  maximumLlmCalls: 50,
  maximumTotalTokens: 200_000,
  maximumApiCalls: 100,
  maximumExecutionMinutes: 30,
  maximumEstimatedCost: 25,
  maximumHumanReviewMinutes: 60,
  maximumPlanSteps: 40,
  maximumParallelWorkstreams: 3,
  maximumRevisionAttempts: 5,
  // Stored configuration authority; runtime enforcement deferred to the
  // admission/execution phases. Phase 1 does not enforce these windows.
  allowedExecutionWindows: [
    {
      windowId: "weekday_utc",
      daysOfWeek: [1, 2, 3, 4, 5],
      startTimeUtc: "00:00",
      endTimeUtc: "23:59",
    },
  ],
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

export const EXAMPLE_POLICY_BUNDLE: PolicyBundle = {
  policyBundleId: EXAMPLE_POLICY_BUNDLE_ID,
  semanticVersion: "1.0.0",
  policyHash: "sha256:example-policy-discord-scale-architect-v1",
  effectiveAt: "2026-08-01T00:00:00.000Z",
  supersedes: null,
  applicableProjectIds: [EXAMPLE_PROJECT_ID],
  applicableEnvironments: ["local", "development"],
  approvedBy: "approver_bootstrap",
  status: "ACTIVE",
  rules: [
    {
      ruleId: "allow_local_read_and_patch",
      description: "Allow local read and patch actions in local/development",
      effect: "ALLOW",
      actionTypes: ["READ_FILE", "CREATE_LOCAL_PATCH", "RUN_TESTS"],
      environments: ["local", "development"],
      conditions: [],
      reasonCode: "LOCAL_SAFE_ACTIONS",
    },
    {
      ruleId: "deny_production_mutation",
      description: "Deny production-impacting actions",
      effect: "DENY",
      actionTypes: [
        "PUSH_TO_MAIN",
        "DELETE_REPOSITORY",
        "CHANGE_ACCESS_CONTROL",
        "DEPLOY_PRODUCTION",
      ],
      environments: ["local", "development", "production"],
      conditions: [],
      reasonCode: "PRODUCTION_MUTATION_DENIED",
    },
  ],
  createdAt: CREATED_AT,
};

export const EXAMPLE_PROJECT: Project = {
  projectId: EXAMPLE_PROJECT_ID,
  projectName: "Discord Scale Architect",
  repositoryUrl: "https://github.com/example/discord-scale-architect",
  defaultBranch: "main",
  workspaceRoot: "/workspace/discord-scale-architect",
  allowedEnvironments: ["local", "development"],
  executionMode: "PATCH_ONLY",
  activePolicyBundleId: EXAMPLE_POLICY_BUNDLE_ID,
  resourceBudgetProfileId: EXAMPLE_BUDGET_PROFILE_ID,
  authorizedApproverIds: ["approver_bootstrap"],
  sensitivityClassification: "INTERNAL",
  status: "ACTIVE",
  createdAt: CREATED_AT,
  updatedAt: UPDATED_AT,
};

export const EXAMPLE_CAPABILITIES: readonly Capability[] = [
  {
    capabilityId: "READ_FILE",
    version: "1.0.0",
    description: "Read files from the local workspace",
    allowedActions: ["READ_FILE"],
    forbiddenActions: ["WRITE_FILE", "DELETE_FILE"],
    allowedEnvironments: ["local", "development"],
    approvalRequirement: "NONE",
    maximumRuntimeSeconds: 30,
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "CREATE_LOCAL_PATCH",
    version: "1.0.0",
    description: "Create a local patch in the workspace",
    allowedActions: ["CREATE_LOCAL_PATCH"],
    forbiddenActions: ["PUSH_TO_MAIN", "FORCE_PUSH"],
    allowedEnvironments: ["local", "development"],
    approvalRequirement: "CONDITIONAL",
    maximumRuntimeSeconds: 120,
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "RUN_TESTS",
    version: "1.0.0",
    description: "Run the local test suite",
    allowedActions: ["RUN_TESTS"],
    forbiddenActions: ["DEPLOY_PRODUCTION"],
    allowedEnvironments: ["local", "development"],
    approvalRequirement: "NONE",
    maximumRuntimeSeconds: 600,
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "CREATE_TASK",
    version: "1.0.0",
    description: "Create a tracked task record",
    allowedActions: ["CREATE_TASK"],
    forbiddenActions: ["CHANGE_ACCESS_CONTROL"],
    allowedEnvironments: ["local", "development"],
    approvalRequirement: "NONE",
    maximumRuntimeSeconds: 15,
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "PREPARE_PULL_REQUEST",
    version: "1.0.0",
    description: "Prepare pull request metadata locally; does not publish",
    allowedActions: ["PREPARE_PULL_REQUEST"],
    forbiddenActions: ["PUSH_TO_MAIN", "MERGE_PULL_REQUEST"],
    allowedEnvironments: ["local", "development"],
    approvalRequirement: "REQUIRED",
    maximumRuntimeSeconds: 60,
    enabled: true,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "PUSH_TO_MAIN",
    version: "1.0.0",
    description: "Push directly to main — disabled example, not permitted",
    allowedActions: [],
    forbiddenActions: ["PUSH_TO_MAIN"],
    allowedEnvironments: ["local"],
    approvalRequirement: "REQUIRED",
    maximumRuntimeSeconds: 0,
    enabled: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "DELETE_REPOSITORY",
    version: "1.0.0",
    description: "Delete a repository — disabled example, not permitted",
    allowedActions: [],
    forbiddenActions: ["DELETE_REPOSITORY"],
    allowedEnvironments: ["local"],
    approvalRequirement: "REQUIRED",
    maximumRuntimeSeconds: 0,
    enabled: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "CHANGE_ACCESS_CONTROL",
    version: "1.0.0",
    description: "Change access control — disabled example, not permitted",
    allowedActions: [],
    forbiddenActions: ["CHANGE_ACCESS_CONTROL"],
    allowedEnvironments: ["local"],
    approvalRequirement: "REQUIRED",
    maximumRuntimeSeconds: 0,
    enabled: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
  {
    capabilityId: "DEPLOY_PRODUCTION",
    version: "1.0.0",
    description: "Deploy to production — disabled example, not permitted",
    allowedActions: [],
    forbiddenActions: ["DEPLOY_PRODUCTION"],
    allowedEnvironments: ["production"],
    approvalRequirement: "REQUIRED",
    maximumRuntimeSeconds: 0,
    enabled: false,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  },
];

export const EXAMPLE_SUSPENDED_PROJECT: Project = {
  ...EXAMPLE_PROJECT,
  projectId: "discord-scale-architect-suspended",
  projectName: "Discord Scale Architect (suspended example)",
  status: "SUSPENDED",
  activePolicyBundleId: EXAMPLE_POLICY_BUNDLE_ID,
};
