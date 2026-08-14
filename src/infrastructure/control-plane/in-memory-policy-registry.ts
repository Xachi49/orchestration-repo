import { ControlPlaneError } from "../../control-plane/errors.js";
import {
  parsePolicyBundle,
  type PolicyBundle,
} from "../../control-plane/policies/policy.js";
import type { PolicyRegistry } from "../../control-plane/policies/registry.js";
import type { ControlPlaneClock } from "../../control-plane/service.js";

export interface InMemoryPolicyRegistryOptions {
  clock: ControlPlaneClock;
}

export class InMemoryPolicyRegistry implements PolicyRegistry {
  private readonly bundles: ReadonlyMap<string, PolicyBundle>;
  private readonly clock: ControlPlaneClock;

  constructor(
    seed: readonly PolicyBundle[] = [],
    options: InMemoryPolicyRegistryOptions,
  ) {
    const map = new Map<string, PolicyBundle>();
    for (const item of seed) {
      const bundle = parsePolicyBundle(item);
      if (map.has(bundle.policyBundleId)) {
        throw new Error(
          `Duplicate policyBundleId in seed: ${bundle.policyBundleId}`,
        );
      }
      map.set(bundle.policyBundleId, Object.freeze(bundle));
    }
    this.bundles = map;
    this.clock = options.clock;
  }

  async getBundleById(policyBundleId: string): Promise<PolicyBundle | null> {
    return this.bundles.get(policyBundleId) ?? null;
  }

  async getActiveBundleForProject(
    projectId: string,
    environment: string,
  ): Promise<PolicyBundle> {
    const asOf = this.clock.nowIso();
    const matches = [...this.bundles.values()].filter((bundle) => {
      if (bundle.status !== "ACTIVE") {
        return false;
      }
      if (bundle.effectiveAt > asOf) {
        return false;
      }
      if (!bundle.applicableProjectIds.includes(projectId)) {
        return false;
      }
      if (!bundle.applicableEnvironments.includes(environment)) {
        return false;
      }
      return true;
    });

    if (matches.length === 0) {
      throw new ControlPlaneError(
        "POLICY_BUNDLE_NOT_FOUND",
        `No active policy bundle for project ${projectId} in ${environment}`,
        { projectId, environment, asOf },
      );
    }

    if (matches.length > 1) {
      throw new ControlPlaneError(
        "POLICY_CONFLICT",
        `Multiple active policy bundles for project ${projectId} in ${environment}`,
        {
          projectId,
          environment,
          asOf,
          policyBundleIds: matches.map((bundle) => bundle.policyBundleId),
        },
      );
    }

    return matches[0]!;
  }

  async listVersions(policyBundleId: string): Promise<readonly PolicyBundle[]> {
    const start = this.bundles.get(policyBundleId);
    if (!start) {
      return [];
    }

    const lineageIds = new Set<string>();
    let current: PolicyBundle | undefined = start;
    while (current) {
      lineageIds.add(current.policyBundleId);
      current = current.supersedes
        ? this.bundles.get(current.supersedes)
        : undefined;
    }

    let grew = true;
    while (grew) {
      grew = false;
      for (const bundle of this.bundles.values()) {
        if (
          bundle.supersedes !== null &&
          lineageIds.has(bundle.supersedes) &&
          !lineageIds.has(bundle.policyBundleId)
        ) {
          lineageIds.add(bundle.policyBundleId);
          grew = true;
        }
      }
    }

    return [...this.bundles.values()]
      .filter((bundle) => lineageIds.has(bundle.policyBundleId))
      .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt));
  }
}
