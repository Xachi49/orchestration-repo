import { hashCanonical } from "../../ingestion/hashing.js";
import type { Project } from "../projects/project.js";
import type { PolicyBundle } from "../policies/policy.js";
import type { ResourceBudgetProfile } from "../budgets/budget.js";
import type { Capability } from "../capabilities/capability.js";
import type { RepositorySource } from "../../ingestion/repository-source.js";
import type { ControlPlaneProvisionManifest } from "./manifest.js";

export type MaterializedControlPlane = {
  project: Project;
  policyBundle: PolicyBundle;
  budgetProfile: ResourceBudgetProfile;
  capabilities: readonly Capability[];
  requesterGrants: readonly {
    requesterId: string;
    projectId: string;
    environments: readonly string[];
  }[];
  approverGrants: readonly {
    approverId: string;
    projectId: string;
    environments: readonly string[];
  }[];
  repositorySource?: RepositorySource;
};

export function computePolicyBundleHash(
  input: Omit<PolicyBundle, "policyHash" | "effectiveAt" | "createdAt">,
): string {
  return `sha256:${hashCanonical({
    policyBundleId: input.policyBundleId,
    semanticVersion: input.semanticVersion,
    supersedes: input.supersedes,
    applicableProjectIds: input.applicableProjectIds,
    applicableEnvironments: input.applicableEnvironments,
    approvedBy: input.approvedBy,
    status: input.status,
    rules: input.rules,
  })}`;
}

export function materializeControlPlaneManifest(
  manifest: ControlPlaneProvisionManifest,
  nowIso: string,
): MaterializedControlPlane {
  const policyMaterial = {
    policyBundleId: manifest.policyBundle.policyBundleId,
    semanticVersion: manifest.policyBundle.semanticVersion,
    supersedes: manifest.policyBundle.supersedes,
    applicableProjectIds: manifest.policyBundle.applicableProjectIds,
    applicableEnvironments: manifest.policyBundle.applicableEnvironments,
    approvedBy: manifest.policyBundle.approvedBy,
    status: manifest.policyBundle.status,
    rules: manifest.policyBundle.rules,
  };
  const policyBundle: PolicyBundle = {
    ...policyMaterial,
    policyHash: computePolicyBundleHash(policyMaterial),
    effectiveAt: nowIso,
    createdAt: nowIso,
  };
  const budgetProfile: ResourceBudgetProfile = {
    ...manifest.budgetProfile,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const project: Project = {
    ...manifest.project,
    createdAt: nowIso,
    updatedAt: nowIso,
  };
  const capabilities: Capability[] = manifest.capabilities.map((c) => ({
    ...c,
    createdAt: nowIso,
    updatedAt: nowIso,
  }));
  const repositorySource = manifest.repositorySource
    ? {
        ...manifest.repositorySource,
        createdAt: nowIso,
        updatedAt: nowIso,
      }
    : undefined;
  return {
    project,
    policyBundle,
    budgetProfile,
    capabilities,
    requesterGrants: manifest.requesterGrants,
    approverGrants: manifest.approverGrants,
    ...(repositorySource ? { repositorySource } : {}),
  };
}

function omitTimestamps<T extends Record<string, unknown>>(
  value: T,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (keys.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

export function projectMaterialFingerprint(project: Project): string {
  return hashCanonical(
    omitTimestamps(project as unknown as Record<string, unknown>, [
      "createdAt",
      "updatedAt",
    ]),
  );
}

export function policyMaterialFingerprint(bundle: PolicyBundle): string {
  return hashCanonical(
    omitTimestamps(bundle as unknown as Record<string, unknown>, [
      "createdAt",
      "effectiveAt",
      "policyHash",
    ]),
  );
}

export function budgetMaterialFingerprint(
  profile: ResourceBudgetProfile,
): string {
  return hashCanonical(
    omitTimestamps(profile as unknown as Record<string, unknown>, [
      "createdAt",
      "updatedAt",
    ]),
  );
}

export function capabilityMaterialFingerprint(capability: Capability): string {
  return hashCanonical(
    omitTimestamps(capability as unknown as Record<string, unknown>, [
      "createdAt",
      "updatedAt",
    ]),
  );
}

export function repositorySourceMaterialFingerprint(
  source: RepositorySource,
): string {
  return hashCanonical(
    omitTimestamps(source as unknown as Record<string, unknown>, [
      "createdAt",
      "updatedAt",
    ]),
  );
}

export function environmentsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  if (left.length !== right.length) return false;
  return left.every((env, i) => env === right[i]);
}
