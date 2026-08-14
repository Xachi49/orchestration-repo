/**
 * Control-plane: policy bundle contracts.
 * Phase 0: types only — policies are not evaluated yet.
 */
export interface PolicyBundleRef {
  policyBundleId: string;
  policyBundleHash: string;
  version: string;
}

export interface PolicyRegistryPort {
  getActiveBundle(projectId: string): Promise<PolicyBundleRef | null>;
}
