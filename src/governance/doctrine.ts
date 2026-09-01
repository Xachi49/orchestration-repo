/**
 * Phase 20 — Institutional governance doctrine.
 *
 * Institutional governance constrains authority. It cannot manufacture
 * operational authority.
 */
export const INSTITUTIONAL_GOVERNANCE_DOCTRINE = {
  identityNotAuthority: "IDENTITY != AUTHORITY",
  roleNotAuthorization: "ROLE != AUTHORIZATION",
  grantNotBusinessDecision: "AUTHORITY GRANT != BUSINESS DECISION",
  delegationNotExpansion: "DELEGATION != AUTHORITY EXPANSION",
  quorumNotBusinessApproval: "QUORUM != BUSINESS APPROVAL",
  attestationNotExecution: "ATTESTATION != EXECUTION AUTHORIZATION",
  proofNotPhaseDecision: "GOVERNANCE PROOF != PHASE-SPECIFIC DECISION",
  adminNotSuperuser: "GOVERNANCE ADMIN != SUPERUSER",
  revocationNotDeletion: "REVOCATION != HISTORY DELETION",
  holdNotAuthority: "EMERGENCY HOLD != NEW AUTHORITY",
  governanceNotPhase1Policy: "INSTITUTIONAL GOVERNANCE != PHASE 1 POLICY",
  concurrenceNotEvidence: "HUMAN CONCURRENCE != FACTUAL EVIDENCE",
  formula:
    "PHASE_SPECIFIC_ROLE_AUTHORITY AND INSTITUTIONAL_REQUIREMENTS_SATISFIED",
  neverOr:
    "Never: PHASE_SPECIFIC_ROLE_AUTHORITY OR INSTITUTIONAL_REQUIREMENTS_SATISFIED",
  attenuation:
    "EffectiveAuthority ⊆ DelegatedAuthority ⊆ SourceAuthority ⊆ ExistingInstitutionalBoundary",
  cannotManufacture:
    "Institutional governance can constrain authority. It cannot manufacture operational authority.",
} as const;

export const GOVERNANCE_PIPELINE = [
  "DIRECT AUTHORITY",
  "OPTIONAL BOUNDED DELEGATION",
  "INSTITUTIONAL AUTHORITY RESOLUTION",
  "MANDATE CONDITIONS",
  "QUORUM + SEPARATION OF DUTIES",
  "INSTITUTIONAL AUTHORIZATION PROOF",
  "EXISTING PHASE-SPECIFIC AUTHORITY",
  "CANONICAL BUSINESS DECISION",
] as const;
