import type { PostgresDatabase } from "../database.js";
import { wrapDatabaseError } from "../database.js";
import { hydrateRecord } from "../hydrate.js";
import { DurabilityError } from "../../../durability/errors.js";
import {
  InstitutionSchema,
  OrganizationalUnitSchema,
  type Institution,
  type OrganizationalUnit,
} from "../../../governance/institution.js";
import {
  GovernanceMandateSchema,
  type GovernanceMandate,
} from "../../../governance/mandate.js";
import {
  AuthorityDelegationSchema,
  type AuthorityDelegation,
} from "../../../governance/delegation.js";
import {
  DirectAuthorityGrantSchema,
  GovernanceAuditEventSchema,
  type DirectAuthorityGrant,
  type GovernanceAuditEvent,
} from "../../../governance/grants.js";
import {
  GovernanceCaseSchema,
  GovernanceAttestationSchema,
  attestationLogicalKey,
  type GovernanceCase,
  type GovernanceAttestation,
} from "../../../governance/case.js";
import {
  InstitutionalAuthorizationProofSchema,
  type InstitutionalAuthorizationProof,
} from "../../../governance/proof.js";
import {
  AuthorityRevocationSchema,
  GovernanceHoldSchema,
  type AuthorityRevocation,
  type GovernanceHold,
} from "../../../governance/revocation-hold.js";
import {
  InstitutionalAuthoritySnapshotSchema,
  type InstitutionalAuthoritySnapshot,
} from "../../../governance/authority-resolution.js";
import { GovernanceError } from "../../../governance/errors.js";
import type { CanonicalAuthorityGrantPort } from "../../../governance/canonical-authority.js";
import {
  CanonicalAuthorityGrantSchema,
  type CanonicalAuthorityGrant,
} from "../../../governance/canonical-authority.js";
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
} from "../../../governance/repositories.js";

function isDurableConflict(error: unknown): boolean {
  return error instanceof DurabilityError && error.code === "DURABLE_CONFLICT";
}

export class PostgresInstitutionRepository implements InstitutionRepository {
  constructor(private readonly db: PostgresDatabase) {}

  async save(institution: Institution): Promise<Institution> {
    const parsed = InstitutionSchema.parse(institution);
    try {
      await this.db.query(
        `INSERT INTO institutions (
           institution_id, status, payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3::jsonb,$4,$5::timestamptz,$5::timestamptz)
         ON CONFLICT (institution_id) DO UPDATE
         SET status = EXCLUDED.status,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.institutionId,
          parsed.status,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(institutionId: string): Promise<Institution | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM institutions
       WHERE institution_id = $1`,
      [institutionId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return InstitutionSchema.parse({
      ...hydrateRecord(
        (i) => InstitutionSchema.parse(i),
        row.payload,
        "institutions",
      ),
      recordRevision: Number(row.record_revision),
    });
  }
}

export class PostgresOrganizationalUnitRepository
  implements OrganizationalUnitRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(unit: OrganizationalUnit): Promise<OrganizationalUnit> {
    const parsed = OrganizationalUnitSchema.parse(unit);
    try {
      await this.db.query(
        `INSERT INTO organizational_units (
           organizational_unit_id, institution_id, status, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,NOW())
         ON CONFLICT (organizational_unit_id) DO UPDATE
         SET institution_id = EXCLUDED.institution_id,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload`,
        [
          parsed.organizationalUnitId,
          parsed.institutionId,
          parsed.status,
          JSON.stringify(parsed),
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(id: string): Promise<OrganizationalUnit | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM organizational_units
       WHERE organizational_unit_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => OrganizationalUnitSchema.parse(i),
          row.payload,
          "organizational_units",
        )
      : null;
  }

  async listByInstitution(
    institutionId: string,
  ): Promise<OrganizationalUnit[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM organizational_units
       WHERE institution_id = $1
       ORDER BY organizational_unit_id ASC`,
      [institutionId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => OrganizationalUnitSchema.parse(i),
        row.payload,
        "organizational_units",
      ),
    );
  }
}

export class PostgresGovernanceMandateRepository
  implements GovernanceMandateRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(mandate: GovernanceMandate): Promise<GovernanceMandate> {
    const parsed = GovernanceMandateSchema.parse(mandate);
    try {
      await this.db.query(
        `INSERT INTO governance_mandates (
           mandate_id, mandate_version, institution_id, status, mandate_hash,
           payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$8::timestamptz)
         ON CONFLICT (mandate_id) DO UPDATE
         SET mandate_version = EXCLUDED.mandate_version,
             institution_id = EXCLUDED.institution_id,
             status = EXCLUDED.status,
             mandate_hash = EXCLUDED.mandate_hash,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.mandateId,
          parsed.mandateVersion,
          parsed.institutionId,
          parsed.status,
          parsed.mandateHash,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(mandateId: string): Promise<GovernanceMandate | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governance_mandates
       WHERE mandate_id = $1`,
      [mandateId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return GovernanceMandateSchema.parse({
      ...hydrateRecord(
        (i) => GovernanceMandateSchema.parse(i),
        row.payload,
        "governance_mandates",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async listActiveByProject(projectId: string): Promise<GovernanceMandate[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governance_mandates
       WHERE status = 'ACTIVE'
         AND payload->'projectScope' ? $1
       ORDER BY mandate_id ASC`,
      [projectId],
    );
    return result.rows.map((row) =>
      GovernanceMandateSchema.parse({
        ...hydrateRecord(
          (i) => GovernanceMandateSchema.parse(i),
          row.payload,
          "governance_mandates",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async transition(
    mandateId: string,
    fromStatus: GovernanceMandate["status"],
    expectedRevision: number,
    toStatus: GovernanceMandate["status"],
    updatedAt: string,
  ): Promise<GovernanceMandate> {
    const existing = await this.getById(mandateId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_MANDATE_NOT_FOUND",
        `Mandate ${mandateId} not found`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new GovernanceError(
        existing.status !== fromStatus
          ? "GOVERNANCE_CAS_CONFLICT"
          : "GOVERNANCE_VERSION_CONFLICT",
        `Mandate ${mandateId} state/revision mismatch`,
      );
    }
    const next = GovernanceMandateSchema.parse({
      ...existing,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE governance_mandates
       SET status = $2, mandate_hash = $3, payload = $4::jsonb,
           record_revision = $5, updated_at = $6::timestamptz
       WHERE mandate_id = $1 AND record_revision = $7 AND status = $8`,
      [
        next.mandateId,
        next.status,
        next.mandateHash,
        JSON.stringify(next),
        next.recordRevision,
        updatedAt,
        expectedRevision,
        fromStatus,
      ],
    );
    if (result.rowCount !== 1) {
      throw new GovernanceError(
        "GOVERNANCE_CAS_CONFLICT",
        `CAS conflict for mandate ${mandateId}`,
      );
    }
    return next;
  }
}

export class PostgresAuthorityDelegationRepository
  implements AuthorityDelegationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(delegation: AuthorityDelegation): Promise<AuthorityDelegation> {
    const parsed = AuthorityDelegationSchema.parse(delegation);
    try {
      await this.db.query(
        `INSERT INTO authority_delegations (
           delegation_id, delegation_version, delegator_principal_id,
           delegate_principal_id, authority_role, status, delegation_hash,
           payload, record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10::timestamptz,$10::timestamptz)
         ON CONFLICT (delegation_id) DO UPDATE
         SET delegation_version = EXCLUDED.delegation_version,
             delegator_principal_id = EXCLUDED.delegator_principal_id,
             delegate_principal_id = EXCLUDED.delegate_principal_id,
             authority_role = EXCLUDED.authority_role,
             status = EXCLUDED.status,
             delegation_hash = EXCLUDED.delegation_hash,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.delegationId,
          parsed.delegationVersion,
          parsed.delegatorPrincipalId,
          parsed.delegatePrincipalId,
          parsed.authorityRole,
          parsed.status,
          parsed.delegationHash,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(delegationId: string): Promise<AuthorityDelegation | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM authority_delegations
       WHERE delegation_id = $1`,
      [delegationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return AuthorityDelegationSchema.parse({
      ...hydrateRecord(
        (i) => AuthorityDelegationSchema.parse(i),
        row.payload,
        "authority_delegations",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async listByDelegate(principalId: string): Promise<AuthorityDelegation[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM authority_delegations
       WHERE delegate_principal_id = $1
       ORDER BY delegation_id ASC`,
      [principalId],
    );
    return result.rows.map((row) =>
      AuthorityDelegationSchema.parse({
        ...hydrateRecord(
          (i) => AuthorityDelegationSchema.parse(i),
          row.payload,
          "authority_delegations",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async listByDelegator(principalId: string): Promise<AuthorityDelegation[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM authority_delegations
       WHERE delegator_principal_id = $1
       ORDER BY delegation_id ASC`,
      [principalId],
    );
    return result.rows.map((row) =>
      AuthorityDelegationSchema.parse({
        ...hydrateRecord(
          (i) => AuthorityDelegationSchema.parse(i),
          row.payload,
          "authority_delegations",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async listActive(): Promise<AuthorityDelegation[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM authority_delegations
       WHERE status = 'ACTIVE'
       ORDER BY delegation_id ASC`,
    );
    return result.rows.map((row) =>
      AuthorityDelegationSchema.parse({
        ...hydrateRecord(
          (i) => AuthorityDelegationSchema.parse(i),
          row.payload,
          "authority_delegations",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async transition(
    delegationId: string,
    fromStatus: AuthorityDelegation["status"],
    expectedRevision: number,
    toStatus: AuthorityDelegation["status"],
    updatedAt: string,
  ): Promise<AuthorityDelegation> {
    const existing = await this.getById(delegationId);
    if (!existing) {
      throw new GovernanceError(
        "AUTHORITY_DELEGATION_NOT_FOUND",
        `Delegation ${delegationId} not found`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new GovernanceError(
        existing.status !== fromStatus
          ? "GOVERNANCE_CAS_CONFLICT"
          : "GOVERNANCE_VERSION_CONFLICT",
        `Delegation ${delegationId} state/revision mismatch`,
      );
    }
    const next = AuthorityDelegationSchema.parse({
      ...existing,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE authority_delegations
       SET status = $2, delegation_hash = $3, payload = $4::jsonb,
           record_revision = $5, updated_at = $6::timestamptz
       WHERE delegation_id = $1 AND record_revision = $7 AND status = $8`,
      [
        next.delegationId,
        next.status,
        next.delegationHash,
        JSON.stringify(next),
        next.recordRevision,
        updatedAt,
        expectedRevision,
        fromStatus,
      ],
    );
    if (result.rowCount !== 1) {
      throw new GovernanceError(
        "GOVERNANCE_CAS_CONFLICT",
        `CAS conflict for delegation ${delegationId}`,
      );
    }
    return next;
  }
}

export class PostgresDirectAuthorityGrantRepository
  implements DirectAuthorityGrantRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(grant: DirectAuthorityGrant): Promise<DirectAuthorityGrant> {
    const parsed = DirectAuthorityGrantSchema.parse(grant);
    try {
      await this.db.query(
        `INSERT INTO governance_direct_grants (
           grant_id, principal_id, authority_role, institution_id, status,
           payload, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::timestamptz)
         ON CONFLICT (grant_id) DO UPDATE
         SET principal_id = EXCLUDED.principal_id,
             authority_role = EXCLUDED.authority_role,
             institution_id = EXCLUDED.institution_id,
             status = EXCLUDED.status,
             payload = EXCLUDED.payload`,
        [
          parsed.grantId,
          parsed.principalId,
          parsed.authorityRole,
          parsed.institutionId,
          parsed.status,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(grantId: string): Promise<DirectAuthorityGrant | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM governance_direct_grants WHERE grant_id = $1`,
      [grantId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => DirectAuthorityGrantSchema.parse(i),
          row.payload,
          "governance_direct_grants",
        )
      : null;
  }

  async listByPrincipal(principalId: string): Promise<DirectAuthorityGrant[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM governance_direct_grants
       WHERE principal_id = $1
       ORDER BY grant_id ASC`,
      [principalId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => DirectAuthorityGrantSchema.parse(i),
        row.payload,
        "governance_direct_grants",
      ),
    );
  }

  async markRevoked(grantId: string): Promise<DirectAuthorityGrant> {
    const existing = await this.getById(grantId);
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
    return this.save(next);
  }
}

export class PostgresGovernanceCaseRepository
  implements GovernanceCaseRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(governanceCase: GovernanceCase): Promise<GovernanceCase> {
    const parsed = GovernanceCaseSchema.parse(governanceCase);
    try {
      await this.db.query(
        `INSERT INTO governance_cases (
           governance_case_id, case_version, subject_id, status, case_hash,
           payload, record_revision, created_at, updated_at, expires_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6::jsonb,$7,$8::timestamptz,$8::timestamptz,$9::timestamptz
         )
         ON CONFLICT (governance_case_id) DO UPDATE
         SET case_version = EXCLUDED.case_version,
             subject_id = EXCLUDED.subject_id,
             status = EXCLUDED.status,
             case_hash = EXCLUDED.case_hash,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at,
             expires_at = EXCLUDED.expires_at`,
        [
          parsed.governanceCaseId,
          parsed.caseVersion,
          parsed.subjectId,
          parsed.status,
          parsed.caseHash,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
          parsed.expiresAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(governanceCaseId: string): Promise<GovernanceCase | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governance_cases
       WHERE governance_case_id = $1`,
      [governanceCaseId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return GovernanceCaseSchema.parse({
      ...hydrateRecord(
        (i) => GovernanceCaseSchema.parse(i),
        row.payload,
        "governance_cases",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async transition(
    governanceCaseId: string,
    fromStatus: GovernanceCase["status"],
    expectedRevision: number,
    toStatus: GovernanceCase["status"],
    updatedAt: string,
    patch?: Partial<GovernanceCase>,
  ): Promise<GovernanceCase> {
    const existing = await this.getById(governanceCaseId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_CASE_NOT_FOUND",
        `Governance case ${governanceCaseId} not found`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new GovernanceError(
        existing.status !== fromStatus
          ? "GOVERNANCE_CAS_CONFLICT"
          : "GOVERNANCE_VERSION_CONFLICT",
        `Governance case ${governanceCaseId} state/revision mismatch`,
      );
    }
    const next = GovernanceCaseSchema.parse({
      ...existing,
      ...patch,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE governance_cases
       SET status = $2, case_hash = $3, payload = $4::jsonb,
           record_revision = $5, updated_at = $6::timestamptz
       WHERE governance_case_id = $1 AND record_revision = $7 AND status = $8`,
      [
        next.governanceCaseId,
        next.status,
        next.caseHash,
        JSON.stringify(next),
        next.recordRevision,
        updatedAt,
        expectedRevision,
        fromStatus,
      ],
    );
    if (result.rowCount !== 1) {
      throw new GovernanceError(
        "GOVERNANCE_CAS_CONFLICT",
        `CAS conflict for governance case ${governanceCaseId}`,
      );
    }
    return next;
  }
}

export class PostgresGovernanceAttestationRepository
  implements GovernanceAttestationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(attestation: GovernanceAttestation): Promise<GovernanceAttestation> {
    const parsed = GovernanceAttestationSchema.parse(attestation);
    const logicalKey = attestationLogicalKey({
      governanceCaseId: parsed.governanceCaseId,
      principalId: parsed.principalId,
      authorityRole: parsed.authorityRole,
    });
    try {
      const result = await this.db.query(
        `INSERT INTO governance_attestations (
           attestation_id, governance_case_id, principal_id, authority_role,
           logical_key, attestation_hash, payload, created_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::timestamptz)
         ON CONFLICT (logical_key) DO NOTHING`,
        [
          parsed.attestationId,
          parsed.governanceCaseId,
          parsed.principalId,
          parsed.authorityRole,
          logicalKey,
          parsed.attestationHash,
          JSON.stringify(parsed),
          parsed.submittedAt,
        ],
      );
      if (result.rowCount === 1) {
        return parsed;
      }
      const existing = await this.getByLogicalKey(logicalKey);
      if (existing && existing.attestationHash === parsed.attestationHash) {
        return existing;
      }
      throw new GovernanceError(
        "GOVERNANCE_ATTESTATION_REPLAY",
        "Conflicting attestation for same logical key",
        { logicalKey },
      );
    } catch (error) {
      if (error instanceof GovernanceError) throw error;
      if (isDurableConflict(error)) {
        const existing = await this.getByLogicalKey(logicalKey);
        if (existing && existing.attestationHash === parsed.attestationHash) {
          return existing;
        }
        throw new GovernanceError(
          "GOVERNANCE_ATTESTATION_REPLAY",
          "Conflicting attestation for same logical key",
          { logicalKey },
        );
      }
      throw wrapDatabaseError(error);
    }
  }

  async getById(attestationId: string): Promise<GovernanceAttestation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM governance_attestations WHERE attestation_id = $1`,
      [attestationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => GovernanceAttestationSchema.parse(i),
          row.payload,
          "governance_attestations",
        )
      : null;
  }

  async getByLogicalKey(
    logicalKey: string,
  ): Promise<GovernanceAttestation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM governance_attestations WHERE logical_key = $1`,
      [logicalKey],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => GovernanceAttestationSchema.parse(i),
          row.payload,
          "governance_attestations",
        )
      : null;
  }

  async listByCase(
    governanceCaseId: string,
  ): Promise<GovernanceAttestation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM governance_attestations
       WHERE governance_case_id = $1
       ORDER BY created_at ASC, attestation_id ASC`,
      [governanceCaseId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => GovernanceAttestationSchema.parse(i),
        row.payload,
        "governance_attestations",
      ),
    );
  }
}

export class PostgresInstitutionalAuthorizationProofRepository
  implements InstitutionalAuthorizationProofRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    proof: InstitutionalAuthorizationProof,
  ): Promise<InstitutionalAuthorizationProof> {
    const parsed = InstitutionalAuthorizationProofSchema.parse(proof);
    try {
      const result = await this.db.query(
        `INSERT INTO institutional_authorization_proofs (
           institutional_authorization_proof_id, governance_case_id, proof_hash,
           status, payload, created_at, expires_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7::timestamptz)
         ON CONFLICT (governance_case_id) DO NOTHING`,
        [
          parsed.institutionalAuthorizationProofId,
          parsed.governanceCaseId,
          parsed.proofHash,
          parsed.status,
          JSON.stringify(parsed),
          parsed.createdAt,
          parsed.expiresAt,
        ],
      );
      if (result.rowCount === 1) {
        return parsed;
      }
      const existing = await this.getByCase(parsed.governanceCaseId);
      if (existing) return existing;
      throw new GovernanceError(
        "GOVERNANCE_CAS_CONFLICT",
        `Proof conflict for case ${parsed.governanceCaseId}`,
      );
    } catch (error) {
      if (error instanceof GovernanceError) throw error;
      if (isDurableConflict(error)) {
        const existing = await this.getByCase(parsed.governanceCaseId);
        if (existing) return existing;
      }
      throw wrapDatabaseError(error);
    }
  }

  async getById(
    proofId: string,
  ): Promise<InstitutionalAuthorizationProof | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM institutional_authorization_proofs
       WHERE institutional_authorization_proof_id = $1`,
      [proofId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => InstitutionalAuthorizationProofSchema.parse(i),
          row.payload,
          "institutional_authorization_proofs",
        )
      : null;
  }

  async getByCase(
    governanceCaseId: string,
  ): Promise<InstitutionalAuthorizationProof | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM institutional_authorization_proofs
       WHERE governance_case_id = $1`,
      [governanceCaseId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => InstitutionalAuthorizationProofSchema.parse(i),
          row.payload,
          "institutional_authorization_proofs",
        )
      : null;
  }

  async markStale(
    proofId: string,
  ): Promise<InstitutionalAuthorizationProof> {
    const existing = await this.getById(proofId);
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
    await this.db.query(
      `UPDATE institutional_authorization_proofs
       SET status = $2, payload = $3::jsonb
       WHERE institutional_authorization_proof_id = $1`,
      [next.institutionalAuthorizationProofId, next.status, JSON.stringify(next)],
    );
    return next;
  }
}

export class PostgresAuthorityRevocationRepository
  implements AuthorityRevocationRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(revocation: AuthorityRevocation): Promise<AuthorityRevocation> {
    const parsed = AuthorityRevocationSchema.parse(revocation);
    try {
      await this.db.query(
        `INSERT INTO authority_revocations (
           revocation_id, target_type, target_id, revocation_hash, payload,
           effective_at, created_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz,$7::timestamptz)
         ON CONFLICT (revocation_id) DO UPDATE
         SET target_type = EXCLUDED.target_type,
             target_id = EXCLUDED.target_id,
             revocation_hash = EXCLUDED.revocation_hash,
             payload = EXCLUDED.payload,
             effective_at = EXCLUDED.effective_at`,
        [
          parsed.revocationId,
          parsed.targetType,
          parsed.targetId,
          parsed.revocationHash,
          JSON.stringify(parsed),
          parsed.effectiveAt,
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(revocationId: string): Promise<AuthorityRevocation | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM authority_revocations WHERE revocation_id = $1`,
      [revocationId],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => AuthorityRevocationSchema.parse(i),
          row.payload,
          "authority_revocations",
        )
      : null;
  }

  async listByTarget(
    targetType: AuthorityRevocation["targetType"],
    targetId: string,
  ): Promise<AuthorityRevocation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM authority_revocations
       WHERE target_type = $1 AND target_id = $2
       ORDER BY effective_at ASC, revocation_id ASC`,
      [targetType, targetId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => AuthorityRevocationSchema.parse(i),
        row.payload,
        "authority_revocations",
      ),
    );
  }

  async listAll(): Promise<AuthorityRevocation[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM authority_revocations
       ORDER BY effective_at ASC, revocation_id ASC`,
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => AuthorityRevocationSchema.parse(i),
        row.payload,
        "authority_revocations",
      ),
    );
  }
}

export class PostgresGovernanceHoldRepository
  implements GovernanceHoldRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(hold: GovernanceHold): Promise<GovernanceHold> {
    const parsed = GovernanceHoldSchema.parse(hold);
    try {
      await this.db.query(
        `INSERT INTO governance_holds (
           hold_id, institution_id, status, hold_hash, payload,
           record_revision, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7::timestamptz,$7::timestamptz)
         ON CONFLICT (hold_id) DO UPDATE
         SET institution_id = EXCLUDED.institution_id,
             status = EXCLUDED.status,
             hold_hash = EXCLUDED.hold_hash,
             payload = EXCLUDED.payload,
             record_revision = EXCLUDED.record_revision,
             updated_at = EXCLUDED.updated_at`,
        [
          parsed.holdId,
          parsed.institutionId,
          parsed.status,
          parsed.holdHash,
          JSON.stringify(parsed),
          parsed.recordRevision,
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(holdId: string): Promise<GovernanceHold | null> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governance_holds WHERE hold_id = $1`,
      [holdId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return GovernanceHoldSchema.parse({
      ...hydrateRecord(
        (i) => GovernanceHoldSchema.parse(i),
        row.payload,
        "governance_holds",
      ),
      recordRevision: Number(row.record_revision),
    });
  }

  async listActiveByProject(projectId: string): Promise<GovernanceHold[]> {
    const result = await this.db.query<{
      payload: unknown;
      record_revision: string | number;
    }>(
      `SELECT payload, record_revision FROM governance_holds
       WHERE status = 'ACTIVE'
         AND payload->'projectScope' ? $1
       ORDER BY hold_id ASC`,
      [projectId],
    );
    return result.rows.map((row) =>
      GovernanceHoldSchema.parse({
        ...hydrateRecord(
          (i) => GovernanceHoldSchema.parse(i),
          row.payload,
          "governance_holds",
        ),
        recordRevision: Number(row.record_revision),
      }),
    );
  }

  async transition(
    holdId: string,
    fromStatus: GovernanceHold["status"],
    expectedRevision: number,
    toStatus: GovernanceHold["status"],
    updatedAt: string,
  ): Promise<GovernanceHold> {
    const existing = await this.getById(holdId);
    if (!existing) {
      throw new GovernanceError(
        "GOVERNANCE_HOLD_NOT_FOUND",
        `Hold ${holdId} not found`,
      );
    }
    if (
      existing.status !== fromStatus ||
      existing.recordRevision !== expectedRevision
    ) {
      throw new GovernanceError(
        existing.status !== fromStatus
          ? "GOVERNANCE_CAS_CONFLICT"
          : "GOVERNANCE_VERSION_CONFLICT",
        `Hold ${holdId} state/revision mismatch`,
      );
    }
    const next = GovernanceHoldSchema.parse({
      ...existing,
      status: toStatus,
      recordRevision: existing.recordRevision + 1,
    });
    const result = await this.db.query(
      `UPDATE governance_holds
       SET status = $2, hold_hash = $3, payload = $4::jsonb,
           record_revision = $5, updated_at = $6::timestamptz
       WHERE hold_id = $1 AND record_revision = $7 AND status = $8`,
      [
        next.holdId,
        next.status,
        next.holdHash,
        JSON.stringify(next),
        next.recordRevision,
        updatedAt,
        expectedRevision,
        fromStatus,
      ],
    );
    if (result.rowCount !== 1) {
      throw new GovernanceError(
        "GOVERNANCE_CAS_CONFLICT",
        `CAS conflict for hold ${holdId}`,
      );
    }
    return next;
  }
}

export class PostgresInstitutionalAuthoritySnapshotRepository
  implements InstitutionalAuthoritySnapshotRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async save(
    snapshot: InstitutionalAuthoritySnapshot,
  ): Promise<InstitutionalAuthoritySnapshot> {
    const parsed = InstitutionalAuthoritySnapshotSchema.parse(snapshot);
    try {
      await this.db.query(
        `INSERT INTO institutional_authority_snapshots (
           authority_snapshot_id, snapshot_hash, payload, created_at
         ) VALUES ($1,$2,$3::jsonb,NOW())
         ON CONFLICT (authority_snapshot_id) DO UPDATE
         SET snapshot_hash = EXCLUDED.snapshot_hash,
             payload = EXCLUDED.payload`,
        [
          parsed.authoritySnapshotId,
          parsed.snapshotHash,
          JSON.stringify(parsed),
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async getById(
    id: string,
  ): Promise<InstitutionalAuthoritySnapshot | null> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM institutional_authority_snapshots
       WHERE authority_snapshot_id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row
      ? hydrateRecord(
          (i) => InstitutionalAuthoritySnapshotSchema.parse(i),
          row.payload,
          "institutional_authority_snapshots",
        )
      : null;
  }
}

export class PostgresGovernanceAuditRepository
  implements GovernanceAuditRepository
{
  constructor(private readonly db: PostgresDatabase) {}

  async append(event: GovernanceAuditEvent): Promise<GovernanceAuditEvent> {
    const parsed = GovernanceAuditEventSchema.parse(event);
    try {
      await this.db.query(
        `INSERT INTO governance_audit_events (
           audit_event_id, event_type, institution_id, payload, created_at
         ) VALUES ($1,$2,$3,$4::jsonb,$5::timestamptz)
         ON CONFLICT (audit_event_id) DO UPDATE
         SET event_type = EXCLUDED.event_type,
             institution_id = EXCLUDED.institution_id,
             payload = EXCLUDED.payload`,
        [
          parsed.auditEventId,
          parsed.eventType,
          parsed.institutionId ?? null,
          JSON.stringify(parsed),
          parsed.createdAt,
        ],
      );
      return parsed;
    } catch (error) {
      throw wrapDatabaseError(error);
    }
  }

  async listByInstitution(
    institutionId: string,
  ): Promise<GovernanceAuditEvent[]> {
    const result = await this.db.query<{ payload: unknown }>(
      `SELECT payload FROM governance_audit_events
       WHERE institution_id = $1
       ORDER BY created_at ASC, audit_event_id ASC`,
      [institutionId],
    );
    return result.rows.map((row) =>
      hydrateRecord(
        (i) => GovernanceAuditEventSchema.parse(i),
        row.payload,
        "governance_audit_events",
      ),
    );
  }
}

/** Reads direct authority exclusively from canonical authority_grants. */
export class PostgresCanonicalAuthorityGrantAdapter
  implements CanonicalAuthorityGrantPort
{
  constructor(private readonly db: PostgresDatabase) {}

  async listByPrincipal(
    principalId: string,
  ): Promise<readonly CanonicalAuthorityGrant[]> {
    const result = await this.db.query<{
      grant_id: string;
      principal_id: string;
      principal_type: string;
      project_id: string;
      authorized_environments: string[];
      enabled: boolean;
    }>(
      `SELECT grant_id, principal_id, principal_type, project_id,
              authorized_environments, enabled
       FROM authority_grants
       WHERE principal_id = $1 AND enabled = TRUE`,
      [principalId],
    );
    return result.rows.map((row) =>
      CanonicalAuthorityGrantSchema.parse({
        grantId: row.grant_id,
        principalId: row.principal_id,
        authorityRole: row.principal_type,
        projectId: row.project_id,
        environmentScope: row.authorized_environments,
        enabled: row.enabled,
      }),
    );
  }

  async getById(grantId: string): Promise<CanonicalAuthorityGrant | null> {
    const result = await this.db.query<{
      grant_id: string;
      principal_id: string;
      principal_type: string;
      project_id: string;
      authorized_environments: string[];
      enabled: boolean;
    }>(
      `SELECT grant_id, principal_id, principal_type, project_id,
              authorized_environments, enabled
       FROM authority_grants
       WHERE grant_id = $1`,
      [grantId],
    );
    const row = result.rows[0];
    if (!row || !row.enabled) return null;
    return CanonicalAuthorityGrantSchema.parse({
      grantId: row.grant_id,
      principalId: row.principal_id,
      authorityRole: row.principal_type,
      projectId: row.project_id,
      environmentScope: row.authorized_environments,
      enabled: row.enabled,
    });
  }
}
