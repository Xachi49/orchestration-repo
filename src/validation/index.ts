/**
 * Validator authority boundary.
 * May validate plans. Cannot execute.
 * Phase 0: contract only.
 */
export interface ValidatorPort {
  readonly authority: "VALIDATE_ONLY";
}

export const VALIDATOR_AUTHORITY = {
  mayValidatePlans: true,
  mayExecutePlans: false,
} as const;
