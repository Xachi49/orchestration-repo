import { createHash } from "node:crypto";
import { z } from "zod";
import type { BudgetResourceEstimate } from "../control-plane/budgets/budget.js";
import {
  BUDGET_DIMENSIONS,
  type BudgetDimension,
} from "../control-plane/budgets/budget.js";
import type { DelegationEnvelope } from "./delegation-envelope.js";

/**
 * Frozen authority references at Program admission.
 * Drift invalidates materialization until revalidation.
 */
export const ProgramAuthorityFreezeSchema = z
  .object({
    policyBundleId: z.string().min(1),
    policyBundleHash: z.string().min(1),
    capabilitySetFingerprint: z.string().min(1),
    projectConfigurationFingerprint: z.string().min(1),
    budgetProfileId: z.string().min(1),
    budgetConfigurationFingerprint: z.string().min(1),
    repositoryAllowlistFingerprint: z.string().min(1),
    delegationEnvelopeHash: z.string().min(1),
    frozenAt: z.string().datetime(),
  })
  .strict();

export type ProgramAuthorityFreeze = z.infer<
  typeof ProgramAuthorityFreezeSchema
>;

export function projectConfigurationFingerprint(input: {
  projectId: string;
  activePolicyBundleId: string;
  budgetProfileId: string;
  allowedEnvironments: readonly string[];
  executionMode: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        activePolicyBundleId: input.activePolicyBundleId,
        allowedEnvironments: [...input.allowedEnvironments].sort(),
        budgetProfileId: input.budgetProfileId,
        executionMode: input.executionMode,
        projectId: input.projectId,
      }),
      "utf8",
    )
    .digest("hex");
}

export function repositoryAllowlistFingerprint(
  identities: readonly string[],
): string {
  return createHash("sha256")
    .update(JSON.stringify([...identities].sort()), "utf8")
    .digest("hex");
}

export function budgetConfigurationFingerprint(
  profileId: string,
  estimate: BudgetResourceEstimate,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ estimate, profileId }), "utf8")
    .digest("hex");
}

/**
 * Intersection-only child authority. Never union.
 * Returns null when intersection empties a required dimension.
 */
export function intersectChildAuthority(input: {
  envelope: DelegationEnvelope;
  requestedProjectId: string;
  requestedEnvironment: string;
  requestedCapabilityIds: readonly string[];
  requestedRepositoryIdentities: readonly string[];
  requestedBudget: BudgetResourceEstimate;
}): {
  ok: true;
  projectId: string;
  environment: string;
  capabilityIds: string[];
  repositoryIdentities: string[];
  budget: BudgetResourceEstimate;
} | {
  ok: false;
  reasonCode: string;
  message: string;
} {
  const { envelope } = input;
  if (!envelope.allowedProjectIds.includes(input.requestedProjectId)) {
    return {
      ok: false,
      reasonCode: "PROJECT_OUTSIDE_ENVELOPE",
      message: `Project ${input.requestedProjectId} not in delegation envelope`,
    };
  }
  if (
    input.requestedProjectId !== envelope.allowedProjectIds[0] &&
    !envelope.crossProjectDelegationAllowed
  ) {
    return {
      ok: false,
      reasonCode: "CROSS_PROJECT_DENIED",
      message: "Cross-project delegation is not allowed",
    };
  }
  if (!envelope.allowedEnvironments.includes(input.requestedEnvironment)) {
    return {
      ok: false,
      reasonCode: "ENVIRONMENT_OUTSIDE_ENVELOPE",
      message: `Environment ${input.requestedEnvironment} not in envelope`,
    };
  }

  const capabilityIds = input.requestedCapabilityIds.filter((id) =>
    envelope.allowedCapabilityIds.includes(id),
  );
  if (
    input.requestedCapabilityIds.length > 0 &&
    capabilityIds.length !== input.requestedCapabilityIds.length
  ) {
    return {
      ok: false,
      reasonCode: "CAPABILITY_EXPANSION_REJECTED",
      message: "Child requested capabilities outside the delegation envelope",
    };
  }

  const repositoryIdentities = input.requestedRepositoryIdentities.filter(
    (id) => envelope.allowedRepositoryIdentities.includes(id),
  );
  if (
    input.requestedRepositoryIdentities.length > 0 &&
    repositoryIdentities.length !== input.requestedRepositoryIdentities.length
  ) {
    return {
      ok: false,
      reasonCode: "REPOSITORY_OUTSIDE_ENVELOPE",
      message: "Child requested repositories outside the delegation envelope",
    };
  }

  const budget = intersectBudget(
    input.requestedBudget,
    envelope.maximumChildBudget,
  );
  if (!budget.ok) {
    return budget;
  }

  return {
    ok: true,
    projectId: input.requestedProjectId,
    environment: input.requestedEnvironment,
    capabilityIds,
    repositoryIdentities,
    budget: budget.value,
  };
}

function intersectBudget(
  requested: BudgetResourceEstimate,
  ceiling: BudgetResourceEstimate,
):
  | { ok: true; value: BudgetResourceEstimate }
  | { ok: false; reasonCode: string; message: string } {
  const value = { ...requested };
  for (const dim of BUDGET_DIMENSIONS) {
    const req = requested[dim as BudgetDimension];
    const max = ceiling[dim as BudgetDimension];
    if (req > max) {
      return {
        ok: false,
        reasonCode: "CHILD_BUDGET_EXCEEDS_CEILING",
        message: `Child budget ${dim}=${req} exceeds maximumChildBudget ${max}`,
      };
    }
    value[dim as BudgetDimension] = req;
  }
  return { ok: true, value };
}

/** Detect constraint weakening: child must not remove parent deny constraints. */
export function childWeakensConstraints(
  parentConstraints: readonly string[],
  childConstraints: readonly string[],
): boolean {
  const childSet = new Set(
    childConstraints.map((c) => c.trim().toLowerCase()),
  );
  for (const parent of parentConstraints) {
    const normalized = parent.trim().toLowerCase();
    if (
      normalized.includes("no production") ||
      normalized.includes("no deploy") ||
      normalized.startsWith("deny:")
    ) {
      if (!childSet.has(normalized)) {
        return true;
      }
    }
  }
  return false;
}
