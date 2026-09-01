import { FixedClock, MutableClock } from "../infrastructure/index.js";
import {
  GovernanceOrchestrationService,
  InMemoryAuthorityDelegationRepository,
  InMemoryAuthorityRevocationRepository,
  InMemoryCanonicalAuthorityGrantRepository,
  InMemoryDirectAuthorityGrantRepository,
  InMemoryGovernanceAttestationRepository,
  InMemoryGovernanceAuditRepository,
  InMemoryGovernanceCaseRepository,
  InMemoryGovernanceHoldRepository,
  InMemoryGovernanceMandateRepository,
  InMemoryInstitutionalAuthoritySnapshotRepository,
  InMemoryInstitutionalAuthorizationProofRepository,
  InMemoryInstitutionRepository,
  InMemoryOrganizationalUnitRepository,
  type CanonicalAuthorityGrant,
  type GovernanceOrchestrationDeps,
} from "./index.js";

/** Fixed wall-clock for Phase 20 governance tests. */
export const GOV_TEST_NOW = "2026-01-01T00:00:00.000Z";

/** Project id used across governance fixtures (EXAMPLE_PROJECT_ID style). */
export const GOV_PROJECT_ID = "proj_gov";

export const GOV_ENV_STAGING = "staging";
export const GOV_ENV_PRODUCTION = "production";

export const GOV_FAR_FUTURE = "2027-01-01T00:00:00.000Z";

export const PRINCIPALS = {
  govAdmin: "gov_admin",
  holdOp: "hold_op",
  allocA: "alloc_a",
  allocB: "alloc_b",
  allocC: "alloc_c",
  riskR: "risk_r",
  dpApprover: "dp_approver",
  dpActivator: "dp_activator",
  sponsorS: "sponsor_s",
  approverA: "approver_a",
  stranger: "stranger",
} as const;

/** Institution-admin project grants: gov_admin → proj_gov. */
export const DEFAULT_GOVERNANCE_ADMIN_GRANTS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([[PRINCIPALS.govAdmin, new Set([GOV_PROJECT_ID])]]);

/** Hold-operator project grants: hold_op → proj_gov. */
export const DEFAULT_HOLD_OPERATOR_GRANTS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([[PRINCIPALS.holdOp, new Set([GOV_PROJECT_ID])]]);

/** Default role → principal for canonical authority_grants bootstrap. */
export const DEFAULT_ROLE_GRANTS: ReadonlyArray<{
  principalId: string;
  authorityRole: string;
}> = [
  { principalId: PRINCIPALS.allocA, authorityRole: "PORTFOLIO_ALLOCATOR" },
  { principalId: PRINCIPALS.allocB, authorityRole: "PORTFOLIO_ALLOCATOR" },
  { principalId: PRINCIPALS.allocC, authorityRole: "PORTFOLIO_ALLOCATOR" },
  { principalId: PRINCIPALS.riskR, authorityRole: "RISK_REVIEWER" },
  { principalId: PRINCIPALS.dpApprover, authorityRole: "DECISION_POLICY_APPROVER" },
  { principalId: PRINCIPALS.dpActivator, authorityRole: "DECISION_POLICY_ACTIVATOR" },
  { principalId: PRINCIPALS.sponsorS, authorityRole: "EXPERIMENT_SPONSOR" },
  { principalId: PRINCIPALS.approverA, authorityRole: "APPROVER" },
];

export function buildGovernanceAdminChecker(
  grants: ReadonlyMap<string, ReadonlySet<string>> = DEFAULT_GOVERNANCE_ADMIN_GRANTS,
): NonNullable<GovernanceOrchestrationDeps["isGovernanceAdmin"]> {
  return async (principalId, _institutionId, projectIds) => {
    const held = grants.get(principalId);
    if (!held) return false;
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return false;
    return unique.every((projectId) => held.has(projectId));
  };
}

export function buildHoldOperatorChecker(
  grants: ReadonlyMap<string, ReadonlySet<string>> = DEFAULT_HOLD_OPERATOR_GRANTS,
): NonNullable<GovernanceOrchestrationDeps["isGovernanceHoldOperator"]> {
  return async (principalId, projectIds) => {
    const held = grants.get(principalId);
    if (!held) return false;
    const unique = [...new Set(projectIds.filter((id) => id.length > 0))];
    if (unique.length === 0) return false;
    return unique.every((projectId) => held.has(projectId));
  };
}

export interface GovernanceTestStack {
  service: GovernanceOrchestrationService;
  clock: FixedClock | MutableClock;
  nowIso: () => string;
  institutions: InMemoryInstitutionRepository;
  units: InMemoryOrganizationalUnitRepository;
  mandates: InMemoryGovernanceMandateRepository;
  delegations: InMemoryAuthorityDelegationRepository;
  canonicalAuthority: InMemoryCanonicalAuthorityGrantRepository;
  directGrants: InMemoryDirectAuthorityGrantRepository;
  cases: InMemoryGovernanceCaseRepository;
  attestations: InMemoryGovernanceAttestationRepository;
  proofs: InMemoryInstitutionalAuthorizationProofRepository;
  revocations: InMemoryAuthorityRevocationRepository;
  holds: InMemoryGovernanceHoldRepository;
  snapshots: InMemoryInstitutionalAuthoritySnapshotRepository;
  audits: InMemoryGovernanceAuditRepository;
}

export function buildGovernanceService(options?: {
  nowIso?: string;
  mutableClock?: boolean;
  adminGrants?: ReadonlyMap<string, ReadonlySet<string>>;
  holdOperatorGrants?: ReadonlyMap<string, ReadonlySet<string>>;
}): GovernanceTestStack {
  const iso = options?.nowIso ?? GOV_TEST_NOW;
  const clock: FixedClock | MutableClock = options?.mutableClock
    ? new MutableClock(iso)
    : new FixedClock(iso);
  const nowIso = () => clock.nowIso();

  const institutions = new InMemoryInstitutionRepository();
  const units = new InMemoryOrganizationalUnitRepository();
  const mandates = new InMemoryGovernanceMandateRepository();
  const delegations = new InMemoryAuthorityDelegationRepository();
  const canonicalAuthority = new InMemoryCanonicalAuthorityGrantRepository();
  const directGrants = new InMemoryDirectAuthorityGrantRepository();
  const cases = new InMemoryGovernanceCaseRepository();
  const attestations = new InMemoryGovernanceAttestationRepository();
  const proofs = new InMemoryInstitutionalAuthorizationProofRepository();
  const revocations = new InMemoryAuthorityRevocationRepository();
  const holds = new InMemoryGovernanceHoldRepository();
  const snapshots = new InMemoryInstitutionalAuthoritySnapshotRepository();
  const audits = new InMemoryGovernanceAuditRepository();

  const service = new GovernanceOrchestrationService({
    nowIso,
    institutions,
    units,
    mandates,
    delegations,
    canonicalAuthority,
    directGrants,
    cases,
    attestations,
    proofs,
    revocations,
    holds,
    snapshots,
    audits,
    isGovernanceAdmin: buildGovernanceAdminChecker(options?.adminGrants),
    isGovernanceHoldOperator: buildHoldOperatorChecker(
      options?.holdOperatorGrants,
    ),
  });

  return {
    service,
    clock,
    nowIso,
    institutions,
    units,
    mandates,
    delegations,
    canonicalAuthority,
    directGrants,
    cases,
    attestations,
    proofs,
    revocations,
    holds,
    snapshots,
    audits,
  };
}

/** Create institution bound to proj_gov. */
export async function seedInstitution(
  service: GovernanceOrchestrationService,
  name = "Example Governance Institution",
) {
  return service.createInstitution({
    name,
    projectIds: [GOV_PROJECT_ID],
  });
}

/** Bootstrap canonical authority_grants (operator/deployment concern in production). */
export async function seedCanonicalAuthority(
  canonical: InMemoryCanonicalAuthorityGrantRepository,
  input: {
    principalId: string;
    authorityRole: string;
    projectId?: string;
    environmentScope?: string[];
    effectiveFrom?: string;
    effectiveUntil?: string;
    grantId?: string;
    actionScope?: readonly string[];
    maximumRisk?: CanonicalAuthorityGrant["maximumRisk"];
    maximumResourceEnvelope?: Record<string, number>;
  },
): Promise<CanonicalAuthorityGrant> {
  return canonical.seed({
    principalId: input.principalId,
    authorityRole: input.authorityRole,
    projectId: input.projectId ?? GOV_PROJECT_ID,
    environmentScope: input.environmentScope ?? [
      GOV_ENV_STAGING,
      GOV_ENV_PRODUCTION,
    ],
    ...(input.effectiveFrom !== undefined
      ? { effectiveFrom: input.effectiveFrom }
      : {}),
    effectiveUntil: input.effectiveUntil ?? GOV_FAR_FUTURE,
    ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
    ...(input.actionScope !== undefined ? { actionScope: input.actionScope } : {}),
    ...(input.maximumRisk !== undefined ? { maximumRisk: input.maximumRisk } : {}),
    ...(input.maximumResourceEnvelope !== undefined
      ? { maximumResourceEnvelope: input.maximumResourceEnvelope }
      : {}),
  });
}

/** @deprecated Pass stack.canonicalAuthority — direct grants resolve from canonical authority only. */
export async function seedDirectGrant(
  canonical: InMemoryCanonicalAuthorityGrantRepository,
  input: {
    principalId: string;
    authorityRole: string;
    institutionId?: string;
    projectScope?: string[];
    environmentScope?: string[];
    actionScope?: string[];
    effectiveFrom?: string;
    effectiveUntil?: string;
    grantId?: string;
    maximumRisk?: CanonicalAuthorityGrant["maximumRisk"];
    maximumResourceEnvelope?: Record<string, number>;
  },
): Promise<CanonicalAuthorityGrant> {
  void input.institutionId;
  const projectId = input.projectScope?.[0] ?? GOV_PROJECT_ID;
  return seedCanonicalAuthority(canonical, {
    principalId: input.principalId,
    authorityRole: input.authorityRole,
    projectId,
    ...(input.environmentScope !== undefined
      ? { environmentScope: input.environmentScope }
      : {}),
    ...(input.effectiveFrom !== undefined
      ? { effectiveFrom: input.effectiveFrom }
      : {}),
    ...(input.effectiveUntil !== undefined
      ? { effectiveUntil: input.effectiveUntil }
      : {}),
    ...(input.grantId !== undefined ? { grantId: input.grantId } : {}),
    ...(input.actionScope !== undefined ? { actionScope: input.actionScope } : {}),
    ...(input.maximumRisk !== undefined ? { maximumRisk: input.maximumRisk } : {}),
    ...(input.maximumResourceEnvelope !== undefined
      ? { maximumResourceEnvelope: input.maximumResourceEnvelope }
      : {}),
  });
}

/** Seed default role grants via canonical authority_grants. */
export async function seedDefaultRoleGrants(
  canonical: InMemoryCanonicalAuthorityGrantRepository,
  overrides?: Partial<{
    projectScope: string[];
    environmentScope: string[];
    effectiveUntil: string;
  }>,
): Promise<CanonicalAuthorityGrant[]> {
  const out: CanonicalAuthorityGrant[] = [];
  for (const row of DEFAULT_ROLE_GRANTS) {
    out.push(
      await seedCanonicalAuthority(canonical, {
        principalId: row.principalId,
        authorityRole: row.authorityRole,
        projectId: overrides?.projectScope?.[0] ?? GOV_PROJECT_ID,
        ...(overrides?.environmentScope !== undefined
          ? { environmentScope: overrides.environmentScope }
          : {}),
        ...(overrides?.effectiveUntil !== undefined
          ? { effectiveUntil: overrides.effectiveUntil }
          : {}),
      }),
    );
  }
  return out;
}
