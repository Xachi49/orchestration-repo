import type { CanonicalAuthorityGrant } from "../governance/canonical-authority.js";
import type { Institution } from "../governance/institution.js";
import type { GovernanceMandate } from "../governance/mandate.js";
import type { OrganizationalUnit } from "../governance/institution.js";
import type { ConstitutionalChangeOperation } from "./operations.js";
import { ConstitutionalError } from "./errors.js";
import {
  projectInstitutionAfterOperations,
  projectMandatesAfterOperations,
  projectOrganizationalUnitsAfterOperations,
} from "./mutation-plan.js";

const META_ROLES = [
  "GOVERNANCE_ADMIN",
  "CONSTITUTIONAL_REVIEWER",
  "CONSTITUTIONAL_ACTIVATOR",
] as const;

export type MetaGovernanceRole = (typeof META_ROLES)[number];

export function isViableCanonicalGrant(
  grant: CanonicalAuthorityGrant,
  institution: Institution,
  role: MetaGovernanceRole,
): boolean {
  if (!grant.enabled || grant.authorityRole !== role) return false;
  return institution.projectIds.includes(grant.projectId);
}

export function countViableRoleHolders(input: {
  institution: Institution;
  grants: readonly CanonicalAuthorityGrant[];
  role: MetaGovernanceRole;
}): number {
  const principals = new Set<string>();
  for (const grant of input.grants) {
    if (isViableCanonicalGrant(grant, input.institution, input.role)) {
      principals.add(grant.principalId);
    }
  }
  return principals.size;
}

export function assertProjectedGovernanceContinuity(input: {
  institution: Institution;
  mandates: readonly GovernanceMandate[];
  units: readonly OrganizationalUnit[];
  grants: readonly CanonicalAuthorityGrant[];
  operations: readonly ConstitutionalChangeOperation[];
  nowIso: string;
  actorPrincipalId: string;
}): void {
  if (!input.institution.constitutionalControlEnabled) {
    return;
  }

  const projectedInstitution = projectInstitutionAfterOperations({
    institution: input.institution,
    operations: input.operations,
  });
  const projectedMandates = projectMandatesAfterOperations({
    currentMandates: input.mandates,
    operations: input.operations,
    nowIso: input.nowIso,
    actorPrincipalId: input.actorPrincipalId,
  });
  void projectOrganizationalUnitsAfterOperations({
    currentUnits: input.units,
    operations: input.operations,
  });

  const adminCount = countViableRoleHolders({
    institution: projectedInstitution,
    grants: input.grants,
    role: "GOVERNANCE_ADMIN",
  });
  if (adminCount < 1) {
    throw new ConstitutionalError(
      "CONSTITUTIONAL_GOVERNANCE_LOCKOUT",
      "Projected state removes all viable GOVERNANCE_ADMIN paths",
      { role: "GOVERNANCE_ADMIN" },
    );
  }

  const hasConstitutionalMandate = projectedMandates.some((m) =>
    m.subjectClasses.includes("CONSTITUTIONAL_CHANGE"),
  );
  if (hasConstitutionalMandate) {
    const reviewerCount = countViableRoleHolders({
      institution: projectedInstitution,
      grants: input.grants,
      role: "CONSTITUTIONAL_REVIEWER",
    });
    if (reviewerCount < 1) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_GOVERNANCE_LOCKOUT",
        "Projected state removes all viable CONSTITUTIONAL_REVIEWER paths",
        { role: "CONSTITUTIONAL_REVIEWER" },
      );
    }

    const activatorCount = countViableRoleHolders({
      institution: projectedInstitution,
      grants: input.grants,
      role: "CONSTITUTIONAL_ACTIVATOR",
    });
    if (activatorCount < 1) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_GOVERNANCE_LOCKOUT",
        "Projected state removes all viable CONSTITUTIONAL_ACTIVATOR paths",
        { role: "CONSTITUTIONAL_ACTIVATOR" },
      );
    }
  }
}
