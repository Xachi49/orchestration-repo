import type { PolicyBundle } from "./policy.js";

export interface PolicyRegistry {
  getBundleById(policyBundleId: string): Promise<PolicyBundle | null>;
  /**
   * Resolves the unique ACTIVE bundle applicable to the project and environment.
   * Fails closed if none exist or if more than one ACTIVE bundle matches.
   */
  getActiveBundleForProject(
    projectId: string,
    environment: string,
  ): Promise<PolicyBundle>;
  listVersions(policyBundleId: string): Promise<readonly PolicyBundle[]>;
}

/** Phase 0 name retained as an alias. */
export type PolicyRegistryPort = PolicyRegistry;
