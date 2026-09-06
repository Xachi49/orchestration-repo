import { ConstitutionalError } from "./errors.js";
import type { ConstitutionalChangeOperation } from "./operations.js";

/** Non-amendable system invariants enforced in code — not institution-configurable. */
export const CONSTITUTIONAL_SAFETY_FLOOR_PRINCIPLES = [
  "GOVERNANCE_ADMIN_NOT_SUPERUSER",
  "INSTITUTIONAL_GOVERNANCE_NOT_PHASE1_POLICY",
  "INSTITUTIONAL_PROOF_NOT_BUSINESS_AUTHORIZATION",
  "QUORUM_NOT_BUSINESS_APPROVAL",
  "ATTESTATION_NOT_EXECUTION_AUTHORIZATION",
  "DELEGATION_NOT_AUTHORITY_EXPANSION",
  "REVOCATION_NOT_HISTORY_DELETION",
  "EMERGENCY_HOLD_NOT_NEW_AUTHORITY",
  "CURRENT_AUTHORITY_NOT_HISTORICAL_ATTESTATION",
  "PASS_NOT_APPROVED",
  "APPROVED_NOT_EXECUTED",
  "VERIFIED_SUCCESS_NOT_COMPLETED",
  "NO_SELF_ISSUED_OPERATIONAL_GRANTS",
  "NO_RETROACTIVE_AUTHORIZATION",
  "NO_ARBITRARY_SHELL_AUTHORITY",
] as const;

const FORBIDDEN_OPERATION_PATTERNS: ReadonlyArray<{
  match: (op: ConstitutionalChangeOperation) => boolean;
  principle: string;
}> = [
  {
    principle: "GOVERNANCE_ADMIN_NOT_SUPERUSER",
    match: (op) =>
      op.kind === "CHANGE_GOVERNANCE_ADMIN_SCOPE" && op.projectScope.length === 0,
  },
  {
    principle: "DELEGATION_NOT_AUTHORITY_EXPANSION",
    match: (op) =>
      op.kind === "CHANGE_DELEGATION_LIMITS" &&
      (op.maximumDelegationDepth ?? 0) > 10,
  },
  {
    principle: "REVOCATION_NOT_HISTORY_DELETION",
    match: (op) =>
      op.kind === "CHANGE_MANDATE_QUORUM" && op.deleteHistoricalRecords === true,
  },
  {
    principle: "EMERGENCY_HOLD_NOT_NEW_AUTHORITY",
    match: (op) =>
      op.kind === "CHANGE_MANDATE_SCOPE" && op.grantAuthorityViaHold === true,
  },
  {
    principle: "NO_SELF_ISSUED_OPERATIONAL_GRANTS",
    match: (op) =>
      op.kind === "CREATE_MANDATE_VERSION" &&
      op.selfGrantOperationalAuthority === true,
  },
];

export function assertConstitutionalSafetyFloor(
  operations: readonly ConstitutionalChangeOperation[],
): void {
  for (const op of operations) {
    for (const rule of FORBIDDEN_OPERATION_PATTERNS) {
      if (rule.match(op)) {
        throw new ConstitutionalError(
          "CONSTITUTIONAL_SAFETY_FLOOR_VIOLATION",
          `Operation violates safety floor: ${rule.principle}`,
          { kind: op.kind, principle: rule.principle },
        );
      }
    }
    if (
      op.kind === "CHANGE_MANDATE_QUORUM" &&
      op.quorumRequirement?.kind === "K_OF_N" &&
      (op.quorumRequirement.k ?? 0) < 1
    ) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_SAFETY_FLOOR_VIOLATION",
        "Quorum k must be at least 1",
      );
    }
  }
}
