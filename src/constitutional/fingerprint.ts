import { createHash } from "node:crypto";
import type { GovernanceMandate } from "../governance/mandate.js";
import type { OrganizationalUnit } from "../governance/institution.js";
import type { CanonicalAuthorityGrant } from "../governance/canonical-authority.js";

export interface ConstitutionalGrantFingerprint {
  grantId: string;
  principalId: string;
  authorityRole: string;
  projectId: string;
  environmentScope: readonly string[];
  enabled: boolean;
}

export interface GovernanceFingerprintInput {
  institutionId: string;
  mandates: readonly GovernanceMandate[];
  organizationalUnits: readonly OrganizationalUnit[];
  constitutionalControlEnabled: boolean;
  /** Material canonical authority identities — not derived principal-name lists. */
  constitutionalRoleGrants: readonly ConstitutionalGrantFingerprint[];
  /** Immutable revocation record ids affecting constitutional roles (material identity). */
  constitutionalRevocationIds: readonly string[];
  institutionProjectIds: readonly string[];
}

export function canonicalGrantFingerprint(
  grant: CanonicalAuthorityGrant,
): ConstitutionalGrantFingerprint {
  return {
    grantId: grant.grantId,
    principalId: grant.principalId,
    authorityRole: grant.authorityRole,
    projectId: grant.projectId,
    environmentScope: [...grant.environmentScope].sort(),
    enabled: grant.enabled,
  };
}

const CONSTITUTIONAL_ROLES = new Set([
  "GOVERNANCE_ADMIN",
  "CONSTITUTIONAL_REVIEWER",
  "CONSTITUTIONAL_ACTIVATOR",
]);

export function selectConstitutionalRoleGrants(
  grants: readonly CanonicalAuthorityGrant[],
  institutionProjectIds: readonly string[],
): ConstitutionalGrantFingerprint[] {
  const projectSet = new Set(institutionProjectIds);
  return grants
    .filter(
      (g) =>
        CONSTITUTIONAL_ROLES.has(g.authorityRole) &&
        projectSet.has(g.projectId),
    )
    .map(canonicalGrantFingerprint)
    .sort((a, b) => a.grantId.localeCompare(b.grantId));
}

export function computeGovernanceStateFingerprint(
  input: GovernanceFingerprintInput,
): string {
  const activeMandates = input.mandates
    .filter((m) => m.status === "ACTIVE")
    .map((m) => ({
      mandateId: m.mandateId,
      mandateVersion: m.mandateVersion,
      mandateHash: m.mandateHash,
      subjectClasses: [...m.subjectClasses].sort(),
      requiredAuthorities: [...m.requiredAuthorities].sort(),
      projectScope: [...m.projectScope].sort(),
      environmentScope: [...m.environmentScope].sort(),
      quorumRequirement: m.quorumRequirement ?? null,
      separationOfDutyRules: m.separationOfDutyRules,
      maximumDelegationDepth: m.maximumDelegationDepth ?? null,
      delegationPolicy: m.delegationPolicy,
    }))
    .sort((a, b) => a.mandateId.localeCompare(b.mandateId));

  const units = input.organizationalUnits
    .filter((u) => u.status === "ACTIVE")
    .map((u) => ({
      organizationalUnitId: u.organizationalUnitId,
      parentUnitId: u.parentUnitId ?? null,
      projectScope: [...u.projectScope].sort(),
      name: u.name,
    }))
    .sort((a, b) =>
      a.organizationalUnitId.localeCompare(b.organizationalUnitId),
    );

  return createHash("sha256")
    .update(
      JSON.stringify({
        institutionId: input.institutionId,
        constitutionalControlEnabled: input.constitutionalControlEnabled,
        institutionProjectIds: [...input.institutionProjectIds].sort(),
        mandates: activeMandates,
        organizationalUnits: units,
        constitutionalRoleGrants: input.constitutionalRoleGrants,
        constitutionalRevocationIds: [...input.constitutionalRevocationIds].sort(),
      }),
      "utf8",
    )
    .digest("hex");
}
