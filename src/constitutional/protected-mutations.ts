import type { ConstitutionalChangeOperation } from "./operations.js";

/**
 * Phase 20 mutation classification when institution.constitutionalControlEnabled.
 *
 * PROTECTED — requires ConstitutionalActivationCapability from Phase 21 activation.
 * ROUTINE_NON_CONSTITUTIONAL — normal Phase 20 operational flow.
 */
export const PROTECTED_GOVERNANCE_MUTATIONS = [
  "createMandate",
  "activateMandate",
  "supersedeMandate",
  "suspendMandate",
  "createOrganizationalUnit",
  "updateOrganizationalUnit",
  "retireOrganizationalUnit",
  "updateInstitutionProjectScope",
] as const;

export const ROUTINE_NON_CONSTITUTIONAL_MUTATIONS = [
  "createInstitution",
  "createDelegation",
  "createDirectGrant",
  "openGovernanceCase",
  "attest",
  "validateProof",
  "createHold",
  "revokeTarget",
  "createAuthoritySnapshot",
  "enableConstitutionalControl",
] as const;

export type ProtectedGovernanceMutation =
  (typeof PROTECTED_GOVERNANCE_MUTATIONS)[number];

export type RoutineNonConstitutionalMutation =
  (typeof ROUTINE_NON_CONSTITUTIONAL_MUTATIONS)[number];

/**
 * Derive the exact protected Phase20 mutation methods authorized by a compiled
 * constitutional mutation plan. Capability gates must reject any method outside
 * this set — institution match alone is insufficient.
 */
export function authorizedProtectedMutationsForOperations(
  operations: readonly ConstitutionalChangeOperation[],
): readonly ProtectedGovernanceMutation[] {
  const authorized = new Set<ProtectedGovernanceMutation>();
  for (const op of operations) {
    switch (op.kind) {
      case "CREATE_MANDATE_VERSION":
        authorized.add("createMandate");
        authorized.add("activateMandate");
        break;
      case "SUPERSEDE_MANDATE_VERSION":
      case "CHANGE_MANDATE_QUORUM":
      case "CHANGE_MANDATE_SEPARATION_OF_DUTIES":
      case "CHANGE_MANDATE_SCOPE":
      case "CHANGE_DELEGATION_LIMITS":
        authorized.add("createMandate");
        authorized.add("activateMandate");
        authorized.add("supersedeMandate");
        break;
      case "CHANGE_GOVERNANCE_ADMIN_SCOPE":
        authorized.add("updateInstitutionProjectScope");
        break;
      case "CREATE_ORGANIZATIONAL_UNIT":
        authorized.add("createOrganizationalUnit");
        break;
      case "CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP":
        authorized.add("updateOrganizationalUnit");
        break;
      case "RETIRE_ORGANIZATIONAL_UNIT":
        authorized.add("retireOrganizationalUnit");
        break;
      default: {
        const _never: never = op;
        void _never;
        break;
      }
    }
  }
  return [...authorized].sort();
}
