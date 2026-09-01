import {
  InstitutionSchema,
  OrganizationalUnitSchema,
  type Institution,
  type OrganizationalUnit,
} from "./institution.js";
import {
  GovernanceMandateSchema,
  type GovernanceMandate,
} from "./mandate.js";
import {
  AuthorityDelegationSchema,
  type AuthorityDelegation,
} from "./delegation.js";
import {
  DirectAuthorityGrantSchema,
  GovernanceAuditEventSchema,
  type DirectAuthorityGrant,
  type GovernanceAuditEvent,
} from "./grants.js";
import {
  GovernanceCaseSchema,
  GovernanceAttestationSchema,
  attestationLogicalKey,
  type GovernanceCase,
  type GovernanceAttestation,
} from "./case.js";
import {
  InstitutionalAuthorizationProofSchema,
  type InstitutionalAuthorizationProof,
} from "./proof.js";
import {
  AuthorityRevocationSchema,
  GovernanceHoldSchema,
  type AuthorityRevocation,
  type GovernanceHold,
} from "./revocation-hold.js";
import {
  InstitutionalAuthoritySnapshotSchema,
  type InstitutionalAuthoritySnapshot,
} from "./authority-resolution.js";
import { GovernanceError } from "./errors.js";
import type {
  InstitutionRepository,
  OrganizationalUnitRepository,
  GovernanceMandateRepository,
  AuthorityDelegationRepository,
  DirectAuthorityGrantRepository,
  GovernanceCaseRepository,
  GovernanceAttestationRepository,
  InstitutionalAuthorizationProofRepository,
  AuthorityRevocationRepository,
  GovernanceHoldRepository,
  InstitutionalAuthoritySnapshotRepository,
  GovernanceAuditRepository,
} from "./repositories.js";

function assertCasTransition(input: {
  entity: string;
  id: string;
  existingStatus: string;
  fromStatus: string;
  existingRevision: number;
  expectedRevision: number;
}): void {
  if (input.existingStatus !== input.fromStatus) {
    throw new GovernanceError(
      "GOVERNANCE_CAS_CONFLICT",
      `${input.entity} ${input.id} status mismatch (expected ${input.fromStatus}, have ${input.existingStatus})`,
      {
        id: input.id,
        fromStatus: input.fromStatus,
        actualStatus: input.existingStatus,
      },
    );
  }
  if (input.existingRevision !== input.expectedRevision) {
    throw new GovernanceError(
      "GOVERNANCE_VERSION_CONFLICT",
      `${input.entity} ${input.id} revision mismatch (expected ${input.expectedRevision}, have ${input.existingRevision})`,
      {
        id: input.id,
        expectedRevision: input.expectedRevision,
        actualRevision: input.existingRevision,
      },
    );
  }
}

export class InMemoryInstitutionRepository implements InstitutionRepository {
  private readonly byId = new Map<string, Institution>();

  async save(institution: Institution): Promise<Institution> {
    const parsed = InstitutionSchema.parse(institution);
    this.byId.set(parsed.institutionId, parsed);
    return parsed;
  }

  async getById(institutionId: string): Promise<Institution | null> {
    return this.byId.get(institutionId) ?? null;
  }
}

export class InMemoryOrganizationalUnitRepository
  implements OrganizationalUnitRepository
{
  private readonly byId = new Map<string, OrganizationalUnit>();

  async save(unit: OrganizationalUnit): Promise<OrganizationalUnit> {
    const parsed = OrganizationalUnitSchema.parse(unit);
    this.byId.set(parsed.organizationalUnitId, parsed);
    return parsed;
  }

  async getById(id: string): Promise<OrganizationalUnit | null> {
    return this.byId.get(id) ?? null;
  }

  async listByInstitution(
    institutionId: string,
  ): Promise<OrganizationalUnit[]> {
    return [...this.byId.values()].filter(
      (u) => u.institutionId === institutionId,
    );
  }
}

export class InMemoryGovernanceMandateRepository
  implements GovernanceMandateRepository
{
  private readonly byId = new Map<string, GovernanceMandate>();

  async save(mandate: GovernanceMandate): Promise<GovernanceMandate> {
    const parsed = GovernanceMandateSchema.parse(mandate);
    this.byId.set(parsed.mandateId, parsed);
    return parsed;
  }

  async getById(mandateId: string): Promise<GovernanceMandate | null> {
    return this.byId.get(mandateId) ?? null;
  }

  async listActiveByProject(projectId: string): Promise<GovernanceMandate[]> {
    return [...this.byId.values()].filter(
      (m) => m.status === "ACTIVE" && m.projectScope.includes(projectId),
    );
  }

  async transition(
    mandateId: string,
    fromStatus: GovernanceMandate["status"],
    expectedRevision: number,
    toStatus: GovernanceMandate["status"],
    updatedAt: string,
  ): Promise<GovernanceMandate> {
    const existing = this.byId.get(mandateId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_MANDATE_NOT_FOUND",
        `Mandate ${mandateId} not found`,
      );
    }
    assertCasTransition({
      entity: "Mandate",
      id: mandateId,
      existingStatus: existing.status,
      fromStatus,
      existingRevision: existing.recordRevision,
      expectedRevision,
    });
    void updatedAt;
    const next = GovernanceMandateSchema.parse({
      ...existing,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    this.byId.set(mandateId, next);
    return next;
  }
}

export class InMemoryAuthorityDelegationRepository
  implements AuthorityDelegationRepository
{
  private readonly byId = new Map<string, AuthorityDelegation>();

  async save(delegation: AuthorityDelegation): Promise<AuthorityDelegation> {
    const parsed = AuthorityDelegationSchema.parse(delegation);
    this.byId.set(parsed.delegationId, parsed);
    return parsed;
  }

  async getById(delegationId: string): Promise<AuthorityDelegation | null> {
    return this.byId.get(delegationId) ?? null;
  }

  async listByDelegate(principalId: string): Promise<AuthorityDelegation[]> {
    return [...this.byId.values()].filter(
      (d) => d.delegatePrincipalId === principalId,
    );
  }

  async listByDelegator(principalId: string): Promise<AuthorityDelegation[]> {
    return [...this.byId.values()].filter(
      (d) => d.delegatorPrincipalId === principalId,
    );
  }

  async listActive(): Promise<AuthorityDelegation[]> {
    return [...this.byId.values()].filter((d) => d.status === "ACTIVE");
  }

  async transition(
    delegationId: string,
    fromStatus: AuthorityDelegation["status"],
    expectedRevision: number,
    toStatus: AuthorityDelegation["status"],
    updatedAt: string,
  ): Promise<AuthorityDelegation> {
    const existing = this.byId.get(delegationId);
    if (!existing) {
      throw new GovernanceError(
        "AUTHORITY_DELEGATION_NOT_FOUND",
        `Delegation ${delegationId} not found`,
      );
    }
    assertCasTransition({
      entity: "Delegation",
      id: delegationId,
      existingStatus: existing.status,
      fromStatus,
      existingRevision: existing.recordRevision,
      expectedRevision,
    });
    void updatedAt;
    const next = AuthorityDelegationSchema.parse({
      ...existing,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    this.byId.set(delegationId, next);
    return next;
  }
}

export class InMemoryDirectAuthorityGrantRepository
  implements DirectAuthorityGrantRepository
{
  private readonly byId = new Map<string, DirectAuthorityGrant>();

  async save(grant: DirectAuthorityGrant): Promise<DirectAuthorityGrant> {
    const parsed = DirectAuthorityGrantSchema.parse(grant);
    this.byId.set(parsed.grantId, parsed);
    return parsed;
  }

  async getById(grantId: string): Promise<DirectAuthorityGrant | null> {
    return this.byId.get(grantId) ?? null;
  }

  async listByPrincipal(principalId: string): Promise<DirectAuthorityGrant[]> {
    return [...this.byId.values()].filter((g) => g.principalId === principalId);
  }

  async markRevoked(grantId: string): Promise<DirectAuthorityGrant> {
    const existing = this.byId.get(grantId);
    if (!existing) {
      throw new GovernanceError(
        "AUTHORITY_REVOCATION_INVALID",
        `Direct grant ${grantId} not found`,
      );
    }
    const next = DirectAuthorityGrantSchema.parse({
      ...existing,
      status: "REVOKED",
    });
    this.byId.set(grantId, next);
    return next;
  }
}

export class InMemoryGovernanceCaseRepository
  implements GovernanceCaseRepository
{
  private readonly byId = new Map<string, GovernanceCase>();

  async save(governanceCase: GovernanceCase): Promise<GovernanceCase> {
    const parsed = GovernanceCaseSchema.parse(governanceCase);
    this.byId.set(parsed.governanceCaseId, parsed);
    return parsed;
  }

  async getById(governanceCaseId: string): Promise<GovernanceCase | null> {
    return this.byId.get(governanceCaseId) ?? null;
  }

  async transition(
    governanceCaseId: string,
    fromStatus: GovernanceCase["status"],
    expectedRevision: number,
    toStatus: GovernanceCase["status"],
    updatedAt: string,
    patch?: Partial<GovernanceCase>,
  ): Promise<GovernanceCase> {
    const existing = this.byId.get(governanceCaseId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_CASE_NOT_FOUND",
        `Governance case ${governanceCaseId} not found`,
      );
    }
    assertCasTransition({
      entity: "GovernanceCase",
      id: governanceCaseId,
      existingStatus: existing.status,
      fromStatus,
      existingRevision: existing.recordRevision,
      expectedRevision,
    });
    void updatedAt;
    const next = GovernanceCaseSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    this.byId.set(governanceCaseId, next);
    return next;
  }
}

export class InMemoryGovernanceAttestationRepository
  implements GovernanceAttestationRepository
{
  private readonly byId = new Map<string, GovernanceAttestation>();
  private readonly byLogicalKey = new Map<string, string>();

  async save(attestation: GovernanceAttestation): Promise<GovernanceAttestation> {
    const parsed = GovernanceAttestationSchema.parse(attestation);
    this.byId.set(parsed.attestationId, parsed);
    const key = attestationLogicalKey({
      governanceCaseId: parsed.governanceCaseId,
      principalId: parsed.principalId,
      authorityRole: parsed.authorityRole,
    });
    this.byLogicalKey.set(key, parsed.attestationId);
    return parsed;
  }

  async getById(attestationId: string): Promise<GovernanceAttestation | null> {
    return this.byId.get(attestationId) ?? null;
  }

  async getByLogicalKey(logicalKey: string): Promise<GovernanceAttestation | null> {
    const id = this.byLogicalKey.get(logicalKey);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async listByCase(governanceCaseId: string): Promise<GovernanceAttestation[]> {
    return [...this.byId.values()].filter(
      (a) => a.governanceCaseId === governanceCaseId,
    );
  }
}

export class InMemoryInstitutionalAuthorizationProofRepository
  implements InstitutionalAuthorizationProofRepository
{
  private readonly byId = new Map<string, InstitutionalAuthorizationProof>();
  private readonly byCase = new Map<string, string>();

  async save(
    proof: InstitutionalAuthorizationProof,
  ): Promise<InstitutionalAuthorizationProof> {
    const parsed = InstitutionalAuthorizationProofSchema.parse(proof);
    this.byId.set(parsed.institutionalAuthorizationProofId, parsed);
    this.byCase.set(
      parsed.governanceCaseId,
      parsed.institutionalAuthorizationProofId,
    );
    return parsed;
  }

  async getById(
    proofId: string,
  ): Promise<InstitutionalAuthorizationProof | null> {
    return this.byId.get(proofId) ?? null;
  }

  async getByCase(
    governanceCaseId: string,
  ): Promise<InstitutionalAuthorizationProof | null> {
    const id = this.byCase.get(governanceCaseId);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async markStale(
    proofId: string,
  ): Promise<InstitutionalAuthorizationProof> {
    const existing = this.byId.get(proofId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_NOT_FOUND",
        `Proof ${proofId} not found`,
      );
    }
    const next = InstitutionalAuthorizationProofSchema.parse({
      ...existing,
      status: "STALE",
    });
    this.byId.set(proofId, next);
    return next;
  }
}

export class InMemoryAuthorityRevocationRepository
  implements AuthorityRevocationRepository
{
  private readonly byId = new Map<string, AuthorityRevocation>();

  async save(revocation: AuthorityRevocation): Promise<AuthorityRevocation> {
    const parsed = AuthorityRevocationSchema.parse(revocation);
    this.byId.set(parsed.revocationId, parsed);
    return parsed;
  }

  async getById(revocationId: string): Promise<AuthorityRevocation | null> {
    return this.byId.get(revocationId) ?? null;
  }

  async listByTarget(
    targetType: AuthorityRevocation["targetType"],
    targetId: string,
  ): Promise<AuthorityRevocation[]> {
    return [...this.byId.values()].filter(
      (r) => r.targetType === targetType && r.targetId === targetId,
    );
  }

  async listAll(): Promise<AuthorityRevocation[]> {
    return [...this.byId.values()];
  }
}

export class InMemoryGovernanceHoldRepository
  implements GovernanceHoldRepository
{
  private readonly byId = new Map<string, GovernanceHold>();

  async save(hold: GovernanceHold): Promise<GovernanceHold> {
    const parsed = GovernanceHoldSchema.parse(hold);
    this.byId.set(parsed.holdId, parsed);
    return parsed;
  }

  async getById(holdId: string): Promise<GovernanceHold | null> {
    return this.byId.get(holdId) ?? null;
  }

  async listActiveByProject(projectId: string): Promise<GovernanceHold[]> {
    return [...this.byId.values()].filter(
      (h) => h.status === "ACTIVE" && h.projectScope.includes(projectId),
    );
  }

  async transition(
    holdId: string,
    fromStatus: GovernanceHold["status"],
    expectedRevision: number,
    toStatus: GovernanceHold["status"],
    updatedAt: string,
  ): Promise<GovernanceHold> {
    const existing = this.byId.get(holdId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_HOLD_NOT_FOUND",
        `Hold ${holdId} not found`,
      );
    }
    assertCasTransition({
      entity: "Hold",
      id: holdId,
      existingStatus: existing.status,
      fromStatus,
      existingRevision: existing.recordRevision,
      expectedRevision,
    });
    void updatedAt;
    const next = GovernanceHoldSchema.parse({
      ...existing,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    this.byId.set(holdId, next);
    return next;
  }
}

export class InMemoryInstitutionalAuthoritySnapshotRepository
  implements InstitutionalAuthoritySnapshotRepository
{
  private readonly byId = new Map<string, InstitutionalAuthoritySnapshot>();

  async save(
    snapshot: InstitutionalAuthoritySnapshot,
  ): Promise<InstitutionalAuthoritySnapshot> {
    const parsed = InstitutionalAuthoritySnapshotSchema.parse(snapshot);
    this.byId.set(parsed.authoritySnapshotId, parsed);
    return parsed;
  }

  async getById(id: string): Promise<InstitutionalAuthoritySnapshot | null> {
    return this.byId.get(id) ?? null;
  }
}

export class InMemoryGovernanceAuditRepository
  implements GovernanceAuditRepository
{
  private readonly events: GovernanceAuditEvent[] = [];

  async append(event: GovernanceAuditEvent): Promise<GovernanceAuditEvent> {
    const parsed = GovernanceAuditEventSchema.parse(event);
    this.events.push(parsed);
    return parsed;
  }

  async listByInstitution(
    institutionId: string,
  ): Promise<GovernanceAuditEvent[]> {
    return this.events.filter((e) => e.institutionId === institutionId);
  }
}
