export const FEDERATION_DOCTRINE = {
  agreementNotLocalAuthority: "FEDERATION_AGREEMENT != LOCAL_AUTHORITY",
  remoteApprovalNotLocalAuth: "REMOTE_APPROVAL != LOCAL_AUTHORIZATION",
  sharedObjectiveNotSharedExecution:
    "SHARED_OBJECTIVE != SHARED_EXECUTION_AUTHORITY",
  proposeNotAccept: "PERMISSION_TO_PROPOSE != PERMISSION_TO_ACCEPT",
  acceptNotExecute: "PERMISSION_TO_ACCEPT != PERMISSION_TO_EXECUTE",
  federatedIntentNotLocalObjective: "FEDERATED_INTENT != LOCAL_OBJECTIVE",
  acceptanceNotAdmission: "FEDERATED_ACCEPTANCE != PHASE2_ADMISSION",
  resourceLimitNotReservation:
    "FEDERATION_RESOURCE_LIMIT != LOCAL_BUDGET_RESERVATION",
  foreignEvidenceNotTruth: "FOREIGN_EVIDENCE != LOCAL_TRUTH",
  foreignVerificationNotAcceptance:
    "FOREIGN_VERIFICATION != LOCAL_ACCEPTANCE_CRITERION_PROOF",
  ratificationNotExecution: "AGREEMENT_RATIFICATION != EXECUTION_AUTHORIZATION",
  activationNotProjectAuthority: "AGREEMENT_ACTIVATION != PROJECT_AUTHORITY",
  participantIsolation: "PARTICIPANT_A_AUTHORITY != PARTICIPANT_B_AUTHORITY",
  noTransitiveTrust: "A↔B + B↔C != A↔C",
  federationNotTransitiveTrust: "FEDERATION != TRANSITIVE_TRUST",
  federationNotSharedSuperuser: "FEDERATION != SHARED_SUPERUSER",
  federationNotAuthorityGrant: "FEDERATION != AUTHORITY_GRANT",
  revocationNotHistoryDeletion: "FEDERATION_REVOCATION != HISTORY_DELETION",
  localConstitutionWins: "LOCAL_CONSTITUTION > FEDERATION_AGREEMENT",
  localInstitutionalWins: "LOCAL_INSTITUTIONAL_GOVERNANCE > FEDERATION_AGREEMENT",
  localPolicyWins: "LOCAL_POLICY > FOREIGN_REQUEST",
  localPipelineAuthoritative: "LOCAL_EXECUTION_PIPELINE REMAINS AUTHORITATIVE",
} as const;

export const FEDERATION_GOVERNING_LAW =
  "Federation determines what independent institutions have mutually agreed may be REQUESTED or EXCHANGED. Each institution independently determines what is locally AUTHORIZED, ADMITTED, EXECUTABLE, VERIFIED, and REMEMBERED.";

export const FEDERATION_ROLES = [
  "FEDERATION_NEGOTIATOR",
  "FEDERATION_RATIFIER",
  "FEDERATION_WORK_ACCEPTOR",
  "FEDERATION_EVIDENCE_SHARER",
] as const;

export type FederationRole = (typeof FEDERATION_ROLES)[number];

export function isFederationRole(role: string): role is FederationRole {
  return (FEDERATION_ROLES as readonly string[]).includes(role);
}

export const FEDERATION_GOVERNANCE_SUBJECTS = [
  "FEDERATION_AGREEMENT_RATIFICATION",
  "FEDERATION_WORK_PROPOSAL",
  "FEDERATION_WORK_ACCEPTANCE",
  "FEDERATION_EVIDENCE_SHARE",
  "FEDERATION_PARTICIPATION_WITHDRAWAL",
] as const;

export type FederationGovernanceSubject =
  (typeof FEDERATION_GOVERNANCE_SUBJECTS)[number];

export const FEDERATION_ACTIONS = [
  "PROPOSE_OBJECTIVE",
  "SHARE_EVIDENCE",
  "REQUEST_RESOURCES",
] as const;

export type FederationAction = (typeof FEDERATION_ACTIONS)[number];

export function assertExhaustiveFederationAction(
  action: never,
): never {
  throw new Error(`Unhandled federation action: ${String(action)}`);
}

export function describeFederationAction(action: FederationAction): string {
  switch (action) {
    case "PROPOSE_OBJECTIVE":
      return "Propose bounded OBJECTIVE work intent within agreement scope";
    case "SHARE_EVIDENCE":
      return "Share bounded evidence envelopes as EXTERNAL_UNVERIFIED";
    case "REQUEST_RESOURCES":
      return "Request resource ceilings only — never local reservation";
    default:
      return assertExhaustiveFederationAction(action);
  }
}
