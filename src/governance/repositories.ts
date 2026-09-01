import type { Institution, OrganizationalUnit } from "./institution.js";
import type { GovernanceMandate } from "./mandate.js";
import type { AuthorityDelegation } from "./delegation.js";
import type { GovernanceCase, GovernanceAttestation } from "./case.js";
import type { InstitutionalAuthorizationProof } from "./proof.js";
import type { AuthorityRevocation, GovernanceHold } from "./revocation-hold.js";
import type { InstitutionalAuthoritySnapshot } from "./authority-resolution.js";
import type { DirectAuthorityGrant, GovernanceAuditEvent } from "./grants.js";

export interface InstitutionRepository {
  save(institution: Institution): Promise<Institution>;
  getById(institutionId: string): Promise<Institution | null>;
}

export interface OrganizationalUnitRepository {
  save(unit: OrganizationalUnit): Promise<OrganizationalUnit>;
  getById(id: string): Promise<OrganizationalUnit | null>;
  listByInstitution(institutionId: string): Promise<OrganizationalUnit[]>;
}

export interface GovernanceMandateRepository {
  save(mandate: GovernanceMandate): Promise<GovernanceMandate>;
  getById(mandateId: string): Promise<GovernanceMandate | null>;
  listActiveByProject(projectId: string): Promise<GovernanceMandate[]>;
  transition(
    mandateId: string,
    fromStatus: GovernanceMandate["status"],
    expectedRevision: number,
    toStatus: GovernanceMandate["status"],
    updatedAt: string,
  ): Promise<GovernanceMandate>;
}

export interface AuthorityDelegationRepository {
  save(delegation: AuthorityDelegation): Promise<AuthorityDelegation>;
  getById(delegationId: string): Promise<AuthorityDelegation | null>;
  listByDelegate(principalId: string): Promise<AuthorityDelegation[]>;
  listByDelegator(principalId: string): Promise<AuthorityDelegation[]>;
  listActive(): Promise<AuthorityDelegation[]>;
  transition(
    delegationId: string,
    fromStatus: AuthorityDelegation["status"],
    expectedRevision: number,
    toStatus: AuthorityDelegation["status"],
    updatedAt: string,
  ): Promise<AuthorityDelegation>;
}

export interface DirectAuthorityGrantRepository {
  save(grant: DirectAuthorityGrant): Promise<DirectAuthorityGrant>;
  getById(grantId: string): Promise<DirectAuthorityGrant | null>;
  listByPrincipal(principalId: string): Promise<DirectAuthorityGrant[]>;
  markRevoked(grantId: string): Promise<DirectAuthorityGrant>;
}

export interface GovernanceCaseRepository {
  save(governanceCase: GovernanceCase): Promise<GovernanceCase>;
  getById(governanceCaseId: string): Promise<GovernanceCase | null>;
  transition(
    governanceCaseId: string,
    fromStatus: GovernanceCase["status"],
    expectedRevision: number,
    toStatus: GovernanceCase["status"],
    updatedAt: string,
    patch?: Partial<GovernanceCase>,
  ): Promise<GovernanceCase>;
}

export interface GovernanceAttestationRepository {
  save(attestation: GovernanceAttestation): Promise<GovernanceAttestation>;
  getById(attestationId: string): Promise<GovernanceAttestation | null>;
  getByLogicalKey(logicalKey: string): Promise<GovernanceAttestation | null>;
  listByCase(governanceCaseId: string): Promise<GovernanceAttestation[]>;
}

export interface InstitutionalAuthorizationProofRepository {
  save(
    proof: InstitutionalAuthorizationProof,
  ): Promise<InstitutionalAuthorizationProof>;
  getById(
    proofId: string,
  ): Promise<InstitutionalAuthorizationProof | null>;
  getByCase(
    governanceCaseId: string,
  ): Promise<InstitutionalAuthorizationProof | null>;
  markStale(proofId: string): Promise<InstitutionalAuthorizationProof>;
}

export interface AuthorityRevocationRepository {
  save(revocation: AuthorityRevocation): Promise<AuthorityRevocation>;
  getById(revocationId: string): Promise<AuthorityRevocation | null>;
  listByTarget(
    targetType: AuthorityRevocation["targetType"],
    targetId: string,
  ): Promise<AuthorityRevocation[]>;
  listAll(): Promise<AuthorityRevocation[]>;
}

export interface GovernanceHoldRepository {
  save(hold: GovernanceHold): Promise<GovernanceHold>;
  getById(holdId: string): Promise<GovernanceHold | null>;
  listActiveByProject(projectId: string): Promise<GovernanceHold[]>;
  transition(
    holdId: string,
    fromStatus: GovernanceHold["status"],
    expectedRevision: number,
    toStatus: GovernanceHold["status"],
    updatedAt: string,
  ): Promise<GovernanceHold>;
}

export interface InstitutionalAuthoritySnapshotRepository {
  save(
    snapshot: InstitutionalAuthoritySnapshot,
  ): Promise<InstitutionalAuthoritySnapshot>;
  getById(id: string): Promise<InstitutionalAuthoritySnapshot | null>;
}

export interface GovernanceAuditRepository {
  append(event: GovernanceAuditEvent): Promise<GovernanceAuditEvent>;
  listByInstitution(institutionId: string): Promise<GovernanceAuditEvent[]>;
}
