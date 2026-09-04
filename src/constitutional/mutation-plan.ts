import { createHash } from "node:crypto";
import type { ConstitutionalChangeOperation } from "./operations.js";
import type { ConstitutionalChangeProposal } from "./proposal.js";
import type { GovernanceMandate } from "../governance/mandate.js";
import type { Institution, OrganizationalUnit } from "../governance/institution.js";
import { ConstitutionalError } from "./errors.js";

export interface ConstitutionalMutationPlan {
  planHash: string;
  proposalId: string;
  proposalHash: string;
  proposalVersion: number;
  baseGovernanceFingerprint: string;
  operations: readonly ConstitutionalChangeOperation[];
}

export function compileConstitutionalMutationPlan(input: {
  proposal: ConstitutionalChangeProposal;
}): ConstitutionalMutationPlan {
  const operations = input.proposal.changeOperations;
  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        proposalId: input.proposal.constitutionalChangeProposalId,
        proposalHash: input.proposal.proposalHash,
        proposalVersion: input.proposal.proposalVersion,
        baseGovernanceFingerprint: input.proposal.baseGovernanceFingerprint,
        operations,
      }),
      "utf8",
    )
    .digest("hex");
  return {
    planHash,
    proposalId: input.proposal.constitutionalChangeProposalId,
    proposalHash: input.proposal.proposalHash,
    proposalVersion: input.proposal.proposalVersion,
    baseGovernanceFingerprint: input.proposal.baseGovernanceFingerprint,
    operations,
  };
}

/** Compile-time + runtime proof that every accepted operation kind is handled. */
export function assertExhaustiveOperationKind(
  op: ConstitutionalChangeOperation,
): void {
  switch (op.kind) {
    case "CREATE_MANDATE_VERSION":
    case "SUPERSEDE_MANDATE_VERSION":
    case "CHANGE_MANDATE_QUORUM":
    case "CHANGE_MANDATE_SEPARATION_OF_DUTIES":
    case "CHANGE_MANDATE_SCOPE":
    case "CHANGE_DELEGATION_LIMITS":
    case "CHANGE_GOVERNANCE_ADMIN_SCOPE":
    case "CREATE_ORGANIZATIONAL_UNIT":
    case "CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP":
    case "RETIRE_ORGANIZATIONAL_UNIT":
      return;
    default: {
      const _exhaustive: never = op;
      throw new ConstitutionalError(
        "CONSTITUTIONAL_OPERATION_INVALID",
        `Unhandled operation kind ${(_exhaustive as { kind: string }).kind}`,
      );
    }
  }
}

export function assertAllOperationsExecutable(
  operations: readonly ConstitutionalChangeOperation[],
): void {
  for (const op of operations) {
    assertExhaustiveOperationKind(op);
  }
}

/** Project mandate list after applying operations (deterministic, no writes). */
export function projectMandatesAfterOperations(input: {
  currentMandates: readonly GovernanceMandate[];
  operations: readonly ConstitutionalChangeOperation[];
  nowIso: string;
  actorPrincipalId: string;
}): GovernanceMandate[] {
  const byId = new Map(input.currentMandates.map((m) => [m.mandateId, { ...m }]));
  const superseded = new Set<string>();

  for (const op of input.operations) {
    assertExhaustiveOperationKind(op);
    switch (op.kind) {
      case "CHANGE_MANDATE_QUORUM":
      case "CHANGE_MANDATE_SEPARATION_OF_DUTIES":
      case "CHANGE_MANDATE_SCOPE":
      case "CHANGE_DELEGATION_LIMITS": {
        const current = byId.get(op.mandateId);
        if (!current) break;
        superseded.add(op.mandateId);
        const nextVersion = current.mandateVersion + 1;
        const next: GovernanceMandate = {
          ...current,
          mandateId: `${current.mandateId}_v${nextVersion}`,
          mandateVersion: nextVersion,
          status: "ACTIVE",
          createdAt: input.nowIso,
          createdBy: input.actorPrincipalId,
          recordRevision: 1,
          mandateHash: `projected_${op.kind}_${op.mandateId}`,
          ...(op.kind === "CHANGE_MANDATE_QUORUM"
            ? { quorumRequirement: op.quorumRequirement }
            : {}),
          ...(op.kind === "CHANGE_MANDATE_SEPARATION_OF_DUTIES"
            ? { separationOfDutyRules: [...op.separationOfDutyRules] }
            : {}),
          ...(op.kind === "CHANGE_MANDATE_SCOPE"
            ? {
                projectScope: [...op.projectScope],
                environmentScope: [...op.environmentScope],
              }
            : {}),
          ...(op.kind === "CHANGE_DELEGATION_LIMITS"
            ? {
                maximumDelegationDepth: op.maximumDelegationDepth,
                ...(op.delegationPolicy !== undefined
                  ? { delegationPolicy: op.delegationPolicy }
                  : {}),
              }
            : {}),
        };
        byId.set(next.mandateId, next);
        break;
      }
      case "CREATE_MANDATE_VERSION": {
        const next: GovernanceMandate = {
          mandateId: `new_${op.institutionId}_v${op.mandateVersion ?? 1}`,
          mandateVersion: op.mandateVersion ?? 1,
          institutionId: op.institutionId,
          subjectClasses: [...op.subjectClasses],
          requiredAuthorities: [...op.requiredAuthorities],
          projectScope: [...op.projectScope],
          environmentScope: [...op.environmentScope],
          separationOfDutyRules: [...op.separationOfDutyRules],
          delegationPolicy: op.delegationPolicy ?? {
            allowDelegation: true,
            maximumDelegationDepth: 1,
            redelegationForbidden: false,
          },
          riskScope: [],
          resourceScope: {},
          effectiveFrom: op.effectiveFrom ?? input.nowIso,
          ...(op.effectiveUntil !== undefined
            ? { effectiveUntil: op.effectiveUntil }
            : {}),
          ...(op.quorumRequirement !== undefined
            ? { quorumRequirement: op.quorumRequirement }
            : {}),
          ...(op.maximumDelegationDepth !== undefined
            ? { maximumDelegationDepth: op.maximumDelegationDepth }
            : {}),
          status: "ACTIVE",
          mandateHash: `projected_${op.kind}`,
          createdBy: input.actorPrincipalId,
          createdAt: input.nowIso,
          recordRevision: 1,
        };
        byId.set(next.mandateId, next);
        break;
      }
      case "SUPERSEDE_MANDATE_VERSION": {
        superseded.add(op.mandateId);
        const next: GovernanceMandate = {
          mandateId: `${op.mandateId}_v${op.newMandateVersion}`,
          mandateVersion: op.newMandateVersion,
          institutionId: input.currentMandates.find((m) => m.mandateId === op.mandateId)
            ?.institutionId ?? "",
          subjectClasses: [...op.subjectClasses],
          requiredAuthorities: [...op.requiredAuthorities],
          projectScope: [...op.projectScope],
          environmentScope: [...op.environmentScope],
          separationOfDutyRules: [...op.separationOfDutyRules],
          delegationPolicy: op.delegationPolicy ?? {
            allowDelegation: true,
            maximumDelegationDepth: 1,
            redelegationForbidden: false,
          },
          riskScope: [],
          resourceScope: {},
          effectiveFrom: op.effectiveFrom ?? input.nowIso,
          ...(op.effectiveUntil !== undefined
            ? { effectiveUntil: op.effectiveUntil }
            : {}),
          ...(op.quorumRequirement !== undefined
            ? { quorumRequirement: op.quorumRequirement }
            : {}),
          ...(op.maximumDelegationDepth !== undefined
            ? { maximumDelegationDepth: op.maximumDelegationDepth }
            : {}),
          status: "ACTIVE",
          mandateHash: `projected_${op.kind}`,
          createdBy: input.actorPrincipalId,
          createdAt: input.nowIso,
          recordRevision: 1,
        };
        byId.set(next.mandateId, next);
        break;
      }
      default:
        break;
    }
  }

  return [...byId.values()].filter(
    (m) => m.status === "ACTIVE" && !superseded.has(m.mandateId),
  );
}

export function projectOrganizationalUnitsAfterOperations(input: {
  currentUnits: readonly OrganizationalUnit[];
  operations: readonly ConstitutionalChangeOperation[];
}): OrganizationalUnit[] {
  const byId = new Map(input.currentUnits.map((u) => [u.organizationalUnitId, { ...u }]));

  for (const op of input.operations) {
    switch (op.kind) {
      case "CREATE_ORGANIZATIONAL_UNIT": {
        const id = `projected_ou_${op.name}`;
        byId.set(id, {
          organizationalUnitId: id,
          institutionId: op.institutionId,
          name: op.name,
          description: op.description,
          projectScope: [...op.projectScope],
          ...(op.parentUnitId !== undefined ? { parentUnitId: op.parentUnitId } : {}),
          status: "ACTIVE",
        });
        break;
      }
      case "CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP": {
        const unit = byId.get(op.organizationalUnitId);
        if (unit) {
          byId.set(op.organizationalUnitId, {
            ...unit,
            ...(op.parentUnitId !== undefined
              ? { parentUnitId: op.parentUnitId }
              : { parentUnitId: undefined }),
          });
        }
        break;
      }
      case "RETIRE_ORGANIZATIONAL_UNIT": {
        const unit = byId.get(op.organizationalUnitId);
        if (unit) {
          byId.set(op.organizationalUnitId, { ...unit, status: "RETIRED" });
        }
        break;
      }
      default:
        break;
    }
  }

  return [...byId.values()].filter((u) => u.status === "ACTIVE");
}

export function projectInstitutionAfterOperations(input: {
  institution: Institution;
  operations: readonly ConstitutionalChangeOperation[];
}): Institution {
  let projectIds = [...input.institution.projectIds];
  for (const op of input.operations) {
    if (op.kind === "CHANGE_GOVERNANCE_ADMIN_SCOPE") {
      projectIds = [...op.projectScope];
    }
  }
  return {
    ...input.institution,
    projectIds,
  };
}
