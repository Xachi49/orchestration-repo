/**
 * Validator authority boundary.
 * May evaluate plans and produce findings. Cannot approve, revise itself into
 * authority, or execute.
 */
export interface ValidatorPort {
  readonly authority: "VALIDATE_ONLY";
}

export const VALIDATOR_AUTHORITY = {
  mayValidatePlans: true,
  mayExecutePlans: false,
  mayApprovePlans: false,
  mayGrantCapabilities: false,
} as const;
