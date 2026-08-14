/**
 * Memory authority boundary.
 * May store verified outcomes. Cannot override policy or verified project state.
 * Phase 0: contract only.
 */
export interface MemoryPort {
  readonly authority: "STORE_VERIFIED_OUTCOMES_ONLY";
}

export const MEMORY_AUTHORITY = {
  mayStoreVerifiedOutcomes: true,
  mayOverridePolicy: false,
  mayOverrideVerifiedProjectState: false,
} as const;
