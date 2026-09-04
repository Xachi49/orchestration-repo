export const CONSTITUTIONAL_DOCTRINE = {
  currentAuthorizesProposed:
    "CURRENT_CONSTITUTION authorizes PROPOSED_CONSTITUTION — never the reverse",
  governanceAdminNotSuperuser: "GOVERNANCE_ADMIN != SUPERUSER",
  reviewerNotActivator: "CONSTITUTIONAL_REVIEWER != CONSTITUTIONAL_ACTIVATOR",
  institutionalProofNotApproval:
    "INSTITUTIONAL_PROOF != CONSTITUTIONAL_APPROVAL",
  approvalNotActivation: "CONSTITUTIONAL_APPROVAL != ACTIVATION",
  proposedNotCurrent:
    "PROPOSED_RULES != CURRENT_AUTHORIZATION_RULES for proposal P",
  changeNotOperationalGrant:
    "CONSTITUTIONAL_CHANGE != OPERATIONAL_AUTHORITY_GRANT",
  holdNotAuthority: "EMERGENCY_HOLD != CONSTITUTIONAL_AUTHORITY",
  historicalNotCurrent:
    "HISTORICAL_GOVERNANCE != CURRENT_GOVERNANCE at validation time",
  changeNotHistoryRewrite: "GOVERNANCE_CHANGE != HISTORY_REWRITE",
  currentNotHistoricalProvenance:
    "CURRENT AUTHORITY != HISTORICAL REVIEW PROVENANCE",
} as const;

export const CONSTITUTIONAL_PIPELINE = [
  "PROPOSE",
  "ANALYZE",
  "REVIEW",
  "AUTHORIZE",
  "STAGE",
  "ACTIVATE",
] as const;
