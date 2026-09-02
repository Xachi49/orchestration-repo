import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CASE_SATISFIED_NOT_BUSINESS_ACTION,
  GOVERNANCE_PIPELINE,
  INSTITUTIONAL_GOVERNANCE_DOCTRINE,
  PROOF_NOT_BUSINESS_AUTHORIZATION,
  computeMandateHash,
  evaluateGovernanceQuorum,
  isGovernanceError,
  mintAttestationId,
  mintProofId,
  withAttestationHash,
  withMandateHash,
  withProofHash,
  type GovernanceError,
  type GovernanceMandate,
} from "./index.js";
import {
  GOV_ENV_PRODUCTION,
  GOV_ENV_STAGING,
  GOV_FAR_FUTURE,
  GOV_PROJECT_ID,
  GOV_TEST_NOW,
  PRINCIPALS,
  buildGovernanceService,
  seedCanonicalAuthority,
  seedDefaultRoleGrants,
  seedDirectGrant,
  seedInstitution,
} from "./test-fixtures.js";
import { MutableClock } from "../infrastructure/index.js";

const CASE_EXPIRES = "2026-06-01T00:00:00.000Z";

function expectGovError(
  err: unknown,
  code: GovernanceError["code"],
): asserts err is GovernanceError {
  expect(isGovernanceError(err)).toBe(true);
  expect((err as GovernanceError).code).toBe(code);
}

async function createActiveMandate(
  service: ReturnType<typeof buildGovernanceService>["service"],
  input: {
    institutionId: string;
    requiredAuthorities: string[];
    quorumRequirement?: GovernanceMandate["quorumRequirement"];
    separationOfDutyRules?: GovernanceMandate["separationOfDutyRules"];
    subjectClasses?: string[];
    projectScope?: string[];
    environmentScope?: string[];
    mandateVersion?: number;
    effectiveFrom?: string;
    effectiveUntil?: string;
  },
): Promise<GovernanceMandate> {
  const draft = await service.createMandate({
    institutionId: input.institutionId,
    createdBy: PRINCIPALS.govAdmin,
    subjectClasses: input.subjectClasses ?? ["PORTFOLIO_PLAN"],
    requiredAuthorities: input.requiredAuthorities,
    projectScope: input.projectScope ?? [GOV_PROJECT_ID],
    environmentScope: input.environmentScope ?? [GOV_ENV_STAGING],
    ...(input.quorumRequirement !== undefined
      ? { quorumRequirement: input.quorumRequirement }
      : {}),
    ...(input.separationOfDutyRules !== undefined
      ? { separationOfDutyRules: input.separationOfDutyRules }
      : {}),
    ...(input.mandateVersion !== undefined
      ? { mandateVersion: input.mandateVersion }
      : {}),
    ...(input.effectiveFrom !== undefined
      ? { effectiveFrom: input.effectiveFrom }
      : {}),
    ...(input.effectiveUntil !== undefined
      ? { effectiveUntil: input.effectiveUntil }
      : {}),
  });
  return service.activateMandate({
    mandateId: draft.mandateId,
    actorPrincipalId: PRINCIPALS.govAdmin,
  });
}

describe("Phase 20 institutional governance", () => {
  describe("doctrine constants", () => {
    it("documents identity/role/grant separations", () => {
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.identityNotAuthority).toBe(
        "IDENTITY != AUTHORITY",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.roleNotAuthorization).toBe(
        "ROLE != AUTHORIZATION",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.grantNotBusinessDecision).toBe(
        "AUTHORITY GRANT != BUSINESS DECISION",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.delegationNotExpansion).toBe(
        "DELEGATION != AUTHORITY EXPANSION",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.adminNotSuperuser).toBe(
        "GOVERNANCE ADMIN != SUPERUSER",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.holdNotAuthority).toBe(
        "EMERGENCY HOLD != NEW AUTHORITY",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.cannotManufacture).toContain(
        "cannot manufacture operational authority",
      );
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.formula).toContain("AND");
      expect(INSTITUTIONAL_GOVERNANCE_DOCTRINE.neverOr).toContain("Never:");
    });

    it("documents the governance pipeline order", () => {
      expect(GOVERNANCE_PIPELINE[0]).toBe("DIRECT AUTHORITY");
      expect(GOVERNANCE_PIPELINE).toContain("QUORUM + SEPARATION OF DUTIES");
      expect(GOVERNANCE_PIPELINE.at(-1)).toBe("CANONICAL BUSINESS DECISION");
    });
  });

  describe("institution lifecycle", () => {
    it("creates an institution with project binding and organizational units", async () => {
      const { service } = buildGovernanceService();
      const institution = await seedInstitution(service);
      expect(institution.status).toBe("ACTIVE");
      expect(institution.projectIds).toEqual([GOV_PROJECT_ID]);
      expect(institution.recordRevision).toBe(1);
      expect(institution.createdAt).toBe(GOV_TEST_NOW);

      const unit = await service.createOrganizationalUnit({
        institutionId: institution.institutionId,
        name: "Capital Allocation Desk",
        projectScope: [GOV_PROJECT_ID],
      });
      expect(unit.institutionId).toBe(institution.institutionId);
      expect(unit.status).toBe("ACTIVE");

      const reloaded = await service.createOrganizationalUnit({
        institutionId: institution.institutionId,
        name: "Risk Desk",
        parentUnitId: unit.organizationalUnitId,
      });
      expect(reloaded.parentUnitId).toBe(unit.organizationalUnitId);
    });

    it("rejects organizational unit for unknown institution", async () => {
      const { service } = buildGovernanceService();
      await expect(
        service.createOrganizationalUnit({
          institutionId: "inst_missing",
          name: "Orphan",
        }),
      ).rejects.toMatchObject({ code: "INSTITUTION_NOT_FOUND" });
    });
  });

  describe("mandate hash/version; mandate does not create authority", () => {
    it("hashes mandates deterministically and versions them", async () => {
      const { service } = buildGovernanceService();
      const institution = await seedInstitution(service);
      const m1 = await service.createMandate({
        institutionId: institution.institutionId,
        createdBy: PRINCIPALS.govAdmin,
        subjectClasses: ["PORTFOLIO_PLAN"],
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateVersion: 1,
      });
      expect(m1.status).toBe("DRAFT");
      expect(m1.mandateVersion).toBe(1);
      expect(m1.mandateHash.length).toBeGreaterThan(10);

      const { mandateHash: _h, recordRevision: _r, ...hashMaterial } = m1;
      void _h;
      void _r;
      expect(computeMandateHash(hashMaterial)).toBe(m1.mandateHash);
      const { mandateHash: _dropped, ...withHashInput } = m1;
      void _dropped;
      expect(withMandateHash(withHashInput).mandateHash).toBe(m1.mandateHash);

      const m2 = await service.createMandate({
        institutionId: institution.institutionId,
        createdBy: PRINCIPALS.govAdmin,
        subjectClasses: ["PORTFOLIO_PLAN"],
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateVersion: 2,
      });
      expect(m2.mandateVersion).toBe(2);
      expect(m2.mandateHash).not.toBe(m1.mandateHash);
    });

    it("activating a mandate alone does not authorize a stranger", async () => {
      const { service } = buildGovernanceService();
      const institution = await seedInstitution(service);
      await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
      });

      const resolution = await service.resolveAuthority({
        principalId: PRINCIPALS.stranger,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(resolution.outcome).toBe("DENIED");
    });
  });

  describe("governance admin isolation / self-escalation", () => {
    it("rejects non-admin mandate and grant creation", async () => {
      const { service } = buildGovernanceService();
      const institution = await seedInstitution(service);

      await expect(
        service.createMandate({
          institutionId: institution.institutionId,
          createdBy: PRINCIPALS.stranger,
          subjectClasses: ["PORTFOLIO_PLAN"],
          requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_ADMIN_SCOPE_INSUFFICIENT" });

      await expect(
        service.createDirectGrant({
          createdBy: PRINCIPALS.stranger,
          principalId: PRINCIPALS.allocA,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          institutionId: institution.institutionId,
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_ADMIN_SCOPE_INSUFFICIENT" });
    });

    it("rejects self-escalating direct grant for admin", async () => {
      const { service } = buildGovernanceService();
      const institution = await seedInstitution(service);

      await expect(
        service.createDirectGrant({
          createdBy: PRINCIPALS.govAdmin,
          principalId: PRINCIPALS.govAdmin,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          institutionId: institution.institutionId,
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
        }),
      ).rejects.toMatchObject({
        code: "GOVERNANCE_ADMIN_CANNOT_MINT_OPERATIONAL_AUTHORITY",
      });
    });

    it("rejects mandate that lists creator in requiredAuthorities", async () => {
      const { service } = buildGovernanceService();
      const institution = await seedInstitution(service);

      await expect(
        service.createMandate({
          institutionId: institution.institutionId,
          createdBy: PRINCIPALS.govAdmin,
          subjectClasses: ["PORTFOLIO_PLAN"],
          requiredAuthorities: [PRINCIPALS.govAdmin],
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_SELF_ESCALATION" });
    });
  });

  describe("delegation attenuation", () => {
    it("allows project/env/time/resource narrowing and rejects expansion", async () => {
      const stack = buildGovernanceService({
        adminGrants: new Map([
          [PRINCIPALS.govAdmin, new Set([GOV_PROJECT_ID, "proj_other"])],
        ]),
      });
      const { service, canonicalAuthority } = stack;
      const institution = await service.createInstitution({
        name: "Attenuation Institution",
        projectIds: [GOV_PROJECT_ID, "proj_other"],
      });
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID, "proj_other"],
        environmentScope: [GOV_ENV_STAGING, GOV_ENV_PRODUCTION],
        actionScope: ["allocate", "rebalance"],
        maximumRisk: "HIGH",
        maximumResourceEnvelope: { tokens: 1000 },
        effectiveFrom: GOV_TEST_NOW,
        effectiveUntil: GOV_FAR_FUTURE,
      });

      const narrowed = await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        actionScope: ["allocate"],
        effectiveUntil: "2026-06-01T00:00:00.000Z",
        maximumRisk: "MEDIUM",
        maximumResourceEnvelope: { tokens: 100 },
        reason: "Attenuated handoff",
      });
      expect(narrowed.status).toBe("ACTIVE");
      expect(narrowed.projectScope).toEqual([GOV_PROJECT_ID]);
      expect(narrowed.environmentScope).toEqual([GOV_ENV_STAGING]);
      expect(narrowed.maximumResourceEnvelope).toEqual({ tokens: 100 });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocA,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID, "proj_extra"],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
          reason: "Project expansion",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocA,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING, "canary"],
          effectiveUntil: GOV_FAR_FUTURE,
          reason: "Env expansion",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocA,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveFrom: "2025-01-01T00:00:00.000Z",
          effectiveUntil: "2026-06-01T00:00:00.000Z",
          reason: "Time expansion (from)",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocA,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: "2028-01-01T00:00:00.000Z",
          reason: "Time expansion",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocA,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
          maximumResourceEnvelope: { tokens: 5000 },
          reason: "Resource expansion",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });
    });

    it("permits bounded child delegation under unbounded canonical parent grant", async () => {
      const { service, canonicalAuthority } = buildGovernanceService();
      // Seed canonical grant without explicit effectiveFrom or effectiveUntil (unbounded)
      await canonicalAuthority.seed({
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environmentScope: [GOV_ENV_STAGING, GOV_ENV_PRODUCTION],
      });

      const delegation = await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T23:59:59.000Z",
        reason: "Bounded delegation from unbounded parent",
        maximumDelegationDepth: 2,
      });
      expect(delegation.status).toBe("ACTIVE");
      expect(delegation.effectiveFrom).toBe("2026-01-01T00:00:00.000Z");
      expect(delegation.effectiveUntil).toBe("2026-12-31T23:59:59.000Z");

      // Redelegation must now attenuate the bounded child window (depth 2)
      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocB,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveFrom: "2025-12-31T00:00:00.000Z", // starts before allocB's window
          effectiveUntil: "2026-06-01T00:00:00.000Z",
          reason: "Time expansion (from) on redelegation",
          maximumDelegationDepth: 2,
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocB,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveFrom: "2026-01-01T00:00:00.000Z",
          effectiveUntil: "2027-01-01T00:00:00.000Z", // ends after allocB's window
          reason: "Time expansion (until) on redelegation",
          maximumDelegationDepth: 2,
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SCOPE_EXPANSION" });
    });
  });

  describe("delegation depth + cycle rejection", () => {
    it("rejects depth beyond maximum and cycles", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
      });

      const d1 = await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveUntil: GOV_FAR_FUTURE,
        reason: "First hop",
        maximumDelegationDepth: 1,
      });
      expect(d1.delegationDepth).toBe(1);

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocB,
          delegatePrincipalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
          reason: "Second hop exceeds depth",
          maximumDelegationDepth: 1,
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_DEPTH_EXCEEDED" });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocA,
          delegatePrincipalId: PRINCIPALS.allocA,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
          reason: "Self cycle",
        }),
      ).rejects.toMatchObject({ code: "AUTHORITY_DELEGATION_CYCLE" });

      // Allow depth 2 so B can redelegate, then cycle B→A
      await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocB,
        delegatePrincipalId: PRINCIPALS.allocC,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveUntil: GOV_FAR_FUTURE,
        reason: "Second hop allowed",
        maximumDelegationDepth: 2,
      });

      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.allocC,
          delegatePrincipalId: PRINCIPALS.allocA,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
          reason: "Cycle back to A",
          maximumDelegationDepth: 3,
        }),
      ).rejects.toMatchObject({ code: "AUTHORITY_DELEGATION_CYCLE" });
    });
  });

  describe("expired / revoked source → delegated authority denied", () => {
    it("denies delegate after source grant revocation", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      const grant = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
      });
      await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveUntil: GOV_FAR_FUTURE,
        reason: "Temp delegate",
      });

      const before = await service.resolveAuthority({
        principalId: PRINCIPALS.allocB,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(before.outcome).toBe("AUTHORIZED");

      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grant.grantId,
        reason: "Source revoked",
        principalId: PRINCIPALS.govAdmin,
      });

      const after = await service.resolveAuthority({
        principalId: PRINCIPALS.allocB,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(after.outcome).toBe("DENIED");
    });

    it("denies delegate after source grant expiry", async () => {
      const stack = buildGovernanceService({ mutableClock: true });
      const { service, clock, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        effectiveUntil: "2026-02-01T00:00:00.000Z",
      });
      await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveUntil: "2026-02-01T00:00:00.000Z",
        reason: "Time-bound",
      });

      (clock as MutableClock).set("2026-03-01T00:00:00.000Z");
      const after = await service.resolveAuthority({
        principalId: PRINCIPALS.allocB,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-03-01T00:00:00.000Z",
      });
      expect(after.outcome).toBe("DENIED");
    });
  });

  describe("effective authority resolution + fingerprint stability", () => {
    it("is stable for same inputs and changes when grant changes", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
      });

      const a = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      const b = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(a.outcome).toBe("AUTHORIZED");
      expect(a.institutionalAuthorityFingerprint).toBe(
        b.institutionalAuthorityFingerprint,
      );
      expect(a.sourceAuthorityFingerprint).toBe(b.sourceAuthorityFingerprint);

      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        environmentScope: [GOV_ENV_STAGING],
        maximumResourceEnvelope: { tokens: 42 },
      });
      const c = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(c.outcome).toBe("AUTHORIZED");
      expect(c.institutionalAuthorityFingerprint).not.toBe(
        a.institutionalAuthorityFingerprint,
      );
    });
  });

  describe("quorum kinds", () => {
    it("evaluates ANY_ONE, K_OF_N (2-of-3), ALL_OF, ROLE_SET", () => {
      const anyPending = evaluateGovernanceQuorum({
        requirement: { kind: "ANY_ONE", roles: [], rejectBlocksImmediately: true },
        contributions: [],
      });
      expect(anyPending.outcome).toBe("PENDING");

      const anyOk = evaluateGovernanceQuorum({
        requirement: { kind: "ANY_ONE", roles: [], rejectBlocksImmediately: true },
        contributions: [
          {
            principalId: PRINCIPALS.allocA,
            authorityRole: "PORTFOLIO_ALLOCATOR",
            decision: "APPROVE",
            attestationId: "a1",
          },
        ],
      });
      expect(anyOk.outcome).toBe("SATISFIED");

      const kOfN = evaluateGovernanceQuorum({
        requirement: {
          kind: "K_OF_N",
          k: 2,
          n: 3,
          roles: [],
          rejectBlocksImmediately: false,
        },
        contributions: [
          {
            principalId: PRINCIPALS.allocA,
            authorityRole: "PORTFOLIO_ALLOCATOR",
            decision: "APPROVE",
            attestationId: "a1",
          },
          {
            principalId: PRINCIPALS.allocB,
            authorityRole: "PORTFOLIO_ALLOCATOR",
            decision: "APPROVE",
            attestationId: "a2",
          },
        ],
      });
      expect(kOfN.outcome).toBe("SATISFIED");

      const allOf = evaluateGovernanceQuorum({
        requirement: {
          kind: "ALL_OF",
          n: 2,
          roles: [],
          rejectBlocksImmediately: true,
        },
        contributions: [
          {
            principalId: PRINCIPALS.allocA,
            authorityRole: "PORTFOLIO_ALLOCATOR",
            decision: "APPROVE",
            attestationId: "a1",
          },
        ],
      });
      expect(allOf.outcome).toBe("PENDING");

      const roleSet = evaluateGovernanceQuorum({
        requirement: {
          kind: "ROLE_SET",
          roles: ["PORTFOLIO_ALLOCATOR", "RISK_REVIEWER"],
          rejectBlocksImmediately: true,
        },
        contributions: [
          {
            principalId: PRINCIPALS.allocA,
            authorityRole: "PORTFOLIO_ALLOCATOR",
            decision: "APPROVE",
            attestationId: "a1",
          },
          {
            principalId: PRINCIPALS.riskR,
            authorityRole: "RISK_REVIEWER",
            decision: "APPROVE",
            attestationId: "a2",
          },
        ],
      });
      expect(roleSet.outcome).toBe("SATISFIED");
    });

    it("satisfies ANY_ONE and ROLE_SET via case attestation flow", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);

      const anyMandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const anyCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_any",
        subjectHash: "hash_any",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [anyMandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      const anyResult = await service.attest({
        governanceCaseId: anyCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-any-1",
      });
      expect(anyResult.quorumOutcome).toBe("SATISFIED");
      expect(anyResult.proof).toBeDefined();

      const roleMandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR", "RISK_REVIEWER"],
        quorumRequirement: {
          kind: "ROLE_SET",
          roles: ["PORTFOLIO_ALLOCATOR", "RISK_REVIEWER"],
          rejectBlocksImmediately: true,
        },
      });
      const roleCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_roles",
        subjectHash: "hash_roles",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [roleMandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      const first = await service.attest({
        governanceCaseId: roleCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-role-1",
      });
      expect(first.quorumOutcome).toBe("PENDING");
      const second = await service.attest({
        governanceCaseId: roleCase.governanceCaseId,
        principalId: PRINCIPALS.riskR,
        authorityRole: "RISK_REVIEWER",
        decision: "APPROVE",
        nonce: "nonce-role-2",
      });
      expect(second.quorumOutcome).toBe("SATISFIED");
    });
  });

  describe("same principal cannot count twice for K_OF_N", () => {
    it("ignores duplicate seats from one principal", () => {
      const result = evaluateGovernanceQuorum({
        requirement: {
          kind: "K_OF_N",
          k: 2,
          n: 3,
          roles: [],
          rejectBlocksImmediately: false,
        },
        contributions: [
          {
            principalId: PRINCIPALS.allocA,
            authorityRole: "PORTFOLIO_ALLOCATOR",
            decision: "APPROVE",
            attestationId: "a1",
          },
          {
            principalId: PRINCIPALS.allocA,
            authorityRole: "RISK_REVIEWER",
            decision: "APPROVE",
            attestationId: "a2",
          },
        ],
      });
      expect(result.outcome).toBe("PENDING");
      expect(result.distinctApprovingPrincipals).toEqual([PRINCIPALS.allocA]);
      expect(result.reasons.some((r) => r.includes("already counted"))).toBe(
        true,
      );
    });
  });

  describe("separation of duties FORBID_SAME_PRINCIPAL", () => {
    it("rejects one principal occupying both forbidden roles", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
      });
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "RISK_REVIEWER",
        institutionId: institution.institutionId,
      });
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.riskR,
        authorityRole: "RISK_REVIEWER",
        institutionId: institution.institutionId,
      });

      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR", "RISK_REVIEWER"],
        quorumRequirement: {
          kind: "ROLE_SET",
          roles: ["PORTFOLIO_ALLOCATOR", "RISK_REVIEWER"],
          rejectBlocksImmediately: true,
        },
        separationOfDutyRules: [
          {
            ruleId: "sod_alloc_risk",
            kind: "FORBID_SAME_PRINCIPAL",
            roleA: "PORTFOLIO_ALLOCATOR",
            roleB: "RISK_REVIEWER",
            notes: "Allocator cannot also risk-review",
          },
        ],
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_sod",
        subjectHash: "hash_sod",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });

      await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-sod-1",
      });

      await expect(
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocA,
          authorityRole: "RISK_REVIEWER",
          decision: "APPROVE",
          nonce: "nonce-sod-2",
        }),
      ).rejects.toMatchObject({ code: "SEPARATION_OF_DUTIES_VIOLATION" });
    });
  });

  describe("approval laundering rejected", () => {
    it("rejects attestation with wrong role for the case", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_launder",
        subjectHash: "hash_launder",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });

      await expect(
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.approverA,
          authorityRole: "APPROVER",
          decision: "APPROVE",
          nonce: "nonce-launder",
        }),
      ).rejects.toMatchObject({ code: "APPROVAL_LAUNDERING" });
    });
  });

  describe("case + attestation nonce/replay/expiry/cross-case", () => {
    it("rejects invalid nonceHash, conflicting replay, expiry, and cross-case subjectHash", async () => {
      const stack = buildGovernanceService({ mutableClock: true });
      const { service, clock, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "K_OF_N",
          k: 2,
          n: 3,
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: false,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_case",
        subjectHash: "hash_case",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });

      await expect(
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocA,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          decision: "APPROVE",
          nonce: "nonce-good",
          nonceHash: "deadbeef",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_ATTESTATION_INVALID" });

      await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-good",
      });

      await expect(
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocA,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          decision: "REJECT",
          nonce: "nonce-conflict",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_ATTESTATION_REPLAY" });

      // Idempotent same decision is allowed
      const replayOk = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-good-again",
      });
      expect(replayOk.quorumOutcome).toBe("PENDING");

      await expect(
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocB,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          decision: "APPROVE",
          nonce: "nonce-cross",
          subjectHash: "wrong_subject_hash",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_CROSS_CASE_ATTESTATION" });

      (clock as MutableClock).set("2026-07-01T00:00:00.000Z");
      await expect(
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocB,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          decision: "APPROVE",
          nonce: "nonce-late",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_CASE_EXPIRED" });
    });
  });

  describe("proof identity; proof does not imply business execution", () => {
    it("mints a proof with stable identity and documents non-execution doctrine", async () => {
      expect(PROOF_NOT_BUSINESS_AUTHORIZATION.notExecution).toContain(
        "execution authority",
      );
      expect(PROOF_NOT_BUSINESS_AUTHORIZATION.onlyPrerequisite).toContain(
        "prerequisite",
      );
      expect(CASE_SATISFIED_NOT_BUSINESS_ACTION).toContain("SATISFIED");

      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const subjectHash = createHash("sha256")
        .update("plan-v1")
        .digest("hex");
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_proof",
        subjectHash,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-proof",
      });
      expect(proof).toBeDefined();
      expect(proof!.quorumResult).toBe("SATISFIED");
      expect(proof!.subjectId).toBe("subj_proof");
      expect(proof!.subjectHash).toBe(subjectHash);
      expect(proof!.status).toBe("ACTIVE");

      const validated = await service.getProof({
        proofId: proof!.institutionalAuthorizationProofId,
        subjectId: "subj_proof",
        subjectHash,
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(validated.proofHash).toBe(proof!.proofHash);
      // Proof is institutional only — not a Phase 6 AuthorizationRecord / execution ticket
      expect(PROOF_NOT_BUSINESS_AUTHORIZATION.notAuthorizationRecord).toContain(
        "AuthorizationRecord",
      );
    });
  });

  describe("proof stale after revocation", () => {
    it("marks proof stale and fails validateProof", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_stale",
        subjectHash: "hash_stale",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-stale",
      });
      expect(proof).toBeDefined();

      await service.revokeTarget({
        targetType: "INSTITUTIONAL_PROOF",
        targetId: proof!.institutionalAuthorizationProofId,
        reason: "Attestor left",
        principalId: PRINCIPALS.govAdmin,
      });

      await expect(
        service.getProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectId: "subj_stale",
          subjectHash: "hash_stale",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
    });

    it("stales proof when attestor grant is revoked", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      const grant = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
      });
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_attestor_rev",
        subjectHash: "hash_attestor_rev",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-attestor-rev",
      });

      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grant.grantId,
        reason: "Attestor revoked",
        principalId: PRINCIPALS.govAdmin,
      });

      await expect(
        service.getProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectId: "subj_attestor_rev",
          subjectHash: "hash_attestor_rev",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
    });

    it("fails validateProof when transition time is outside mandate effective window", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);

      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-06-01T00:00:00.000Z",
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_time_fresh",
        subjectHash: "hash_time_fresh",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-fresh-window",
      });
      expect(proof).toBeDefined();

      // Valid inside window
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_time_fresh",
          subjectHash: "hash_time_fresh",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-03-01T00:00:00.000Z",
        }),
      ).resolves.toBeDefined();

      // Fails when transition is before mandate.effectiveFrom
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_time_fresh",
          subjectHash: "hash_time_fresh",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2025-12-31T23:59:59.000Z",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });

      // Fails when transition is after mandate.effectiveUntil
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_time_fresh",
          subjectHash: "hash_time_fresh",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-06-01T00:00:01.000Z",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
    });

    it("fails validateProof when mandate is SUPERSEDED, REVOKED, or after delegation expiry", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority, mandates } = stack;
      const institution = await seedInstitution(service);
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });

      const tempDelegate = "principal_delegate_temporary";

      // Delegated authority to tempDelegate with finite window
      await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: tempDelegate,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-02-01T00:00:00.000Z", // expires Feb 1
        reason: "Temporary delegate",
      });

      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });

      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_mandate_status",
        subjectHash: "hash_mandate_status",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });

      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: tempDelegate,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-delegate-attest",
      });
      expect(proof).toBeDefined();

      // Valid on Jan 15 (inside delegation and mandate window)
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_mandate_status",
          subjectHash: "hash_mandate_status",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-01-15T00:00:00.000Z",
        }),
      ).resolves.toBeDefined();

      // Fails on Feb 15 because tempDelegate's delegation expired on Feb 1
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_mandate_status",
          subjectHash: "hash_mandate_status",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-02-15T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });

      // If mandate becomes SUPERSEDED -> fails
      await mandates.save({ ...mandate, status: "SUPERSEDED" });
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_mandate_status",
          subjectHash: "hash_mandate_status",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-01-15T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });

      // If mandate becomes REVOKED -> fails
      await mandates.save({ ...mandate, status: "REVOKED" });
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_mandate_status",
          subjectHash: "hash_mandate_status",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-01-15T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
    });
  });

  describe("hold blocks; hold cannot grant; hold expiry", () => {
    it("blocks authority and case work while active, then expires", async () => {
      const stack = buildGovernanceService({ mutableClock: true });
      const { service, clock, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);

      await expect(
        service.createHold({
          createdBy: PRINCIPALS.stranger,
          institutionId: institution.institutionId,
          projectScope: [GOV_PROJECT_ID],
          reason: "Unauthorized hold",
        }),
      ).rejects.toMatchObject({
        code: "GOVERNANCE_HOLD_OPERATOR_SCOPE_INSUFFICIENT",
      });

      const hold = await service.createHold({
        createdBy: PRINCIPALS.holdOp,
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        reason: "Incident freeze",
        effect: "BLOCK",
        effectiveUntil: "2026-01-15T00:00:00.000Z",
      });
      expect(hold.effect).toBe("BLOCK");
      expect(["BLOCK", "PAUSE", "CONTAIN"]).toContain(hold.effect);

      const denied = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(denied.outcome).toBe("DENIED");
      expect(denied.reasons.some((r) => r.includes("hold"))).toBe(true);

      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
      });
      await expect(
        service.openGovernanceCase({
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_hold",
          subjectHash: "hash_hold",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectIds: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          mandateIds: [mandate.mandateId],
          expiresAt: CASE_EXPIRES,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_HOLD_ACTIVE" });

      // Hold does not grant authority to anyone
      const holdOpAuth = await service.resolveAuthority({
        principalId: PRINCIPALS.holdOp,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: GOV_TEST_NOW,
      });
      expect(holdOpAuth.outcome).toBe("DENIED");

      (clock as MutableClock).set("2026-01-20T00:00:00.000Z");
      const afterExpiry = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-01-20T00:00:00.000Z",
      });
      expect(afterExpiry.outcome).toBe("AUTHORIZED");
    });
  });

  describe("concurrent final attestation → one proof", () => {
    it("produces a single proof under concurrent completing attestations", async () => {
      const stack = buildGovernanceService();
      const { service, proofs, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "K_OF_N",
          k: 2,
          n: 3,
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: false,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_concurrent",
        subjectHash: "hash_concurrent",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });

      const results = await Promise.allSettled([
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocA,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          decision: "APPROVE",
          nonce: "nonce-conc-a",
        }),
        service.attest({
          governanceCaseId: governanceCase.governanceCaseId,
          principalId: PRINCIPALS.allocB,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          decision: "APPROVE",
          nonce: "nonce-conc-b",
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const proof = await proofs.getByCase(governanceCase.governanceCaseId);
      expect(proof).not.toBeNull();
      expect(proof!.status).toBe("ACTIVE");

      const satisfied = fulfilled.filter(
        (r) =>
          r.status === "fulfilled" &&
          (r.value.quorumOutcome === "SATISFIED" || r.value.proof !== undefined),
      );
      // At least one path observed satisfaction / proof; never more than one proof id
      const proofIds = new Set(
        fulfilled
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.attest>>> =>
            r.status === "fulfilled",
          )
          .map((r) => r.value.proof?.institutionalAuthorizationProofId)
          .filter((id): id is string => typeof id === "string"),
      );
      expect(proofIds.size).toBeLessThanOrEqual(1);
      if (proofIds.size === 1) {
        expect([...proofIds][0]).toBe(proof!.institutionalAuthorizationProofId);
      }
      expect(satisfied.length + (proof ? 1 : 0)).toBeGreaterThan(0);
    });
  });

  describe("isGovernanceError type guard", () => {
    it("returns true only for GovernanceError instances", async () => {
      expect(isGovernanceError(new Error("nope"))).toBe(false);
      expect(isGovernanceError({ code: "AUTHORITY_DENIED" })).toBe(false);

      const { service } = buildGovernanceService();
      try {
        await service.getProof({
          proofId: "iap_missing",
          subjectId: "x",
          subjectHash: "y",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        });
        expect.unreachable("should throw");
      } catch (err) {
        expectGovError(err, "GOVERNANCE_PROOF_NOT_FOUND");
      }
    });
  });

  describe("phase gate assertInstitutionalRequirements", () => {
    it("no-ops without port or without applicable mandate", async () => {
      const { assertInstitutionalRequirements } = await import("./phase-gate.js");
      await assertInstitutionalRequirements({
        port: undefined,
        requiredRole: "APPROVER",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        subjectClass: "PHASE6_APPROVAL",
        subjectType: "PHASE6_APPROVAL",
        subjectId: "subj",
        subjectHash: "hash",
        atIso: GOV_TEST_NOW,
      });

      const { service } = buildGovernanceService();
      await assertInstitutionalRequirements({
        port: service,
        requiredRole: "APPROVER",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        subjectClass: "PHASE6_APPROVAL",
        subjectType: "PHASE6_APPROVAL",
        subjectId: "subj",
        subjectHash: "hash",
        atIso: GOV_TEST_NOW,
      });
    });

    it("requires proof when an active mandate applies", async () => {
      const { assertInstitutionalRequirements } = await import("./phase-gate.js");
      const { service } = buildGovernanceService();
      const institution = await service.createInstitution({
        name: "Gate Inst",
        projectIds: [GOV_PROJECT_ID],
      });
      const draft = await service.createMandate({
        institutionId: institution.institutionId,
        createdBy: PRINCIPALS.govAdmin,
        subjectClasses: ["PHASE6_APPROVAL"],
        requiredAuthorities: ["APPROVER"],
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["APPROVER"],
        },
      });
      await service.activateMandate({
        mandateId: draft.mandateId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });

      await expect(
        assertInstitutionalRequirements({
          port: service,
          requiredRole: "APPROVER",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          subjectClass: "PHASE6_APPROVAL",
          subjectType: "PHASE6_APPROVAL",
          subjectId: "subj",
          subjectHash: "hash",
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toSatisfy((err: unknown) => {
        expectGovError(err, "GOVERNANCE_PROOF_REQUIRED");
        return true;
      });
    });
  });

  describe("pre-postgres authority closure", () => {
    it("mandate repository failure surfaces MANDATE_RESOLUTION_FAILED via phase gate", async () => {
      const stack = buildGovernanceService();
      const { service } = stack;
      const failingPort = {
        resolveAuthority: service.resolveAuthority.bind(service),
        resolveApplicableMandates: async () => ({
          kind: "MANDATE_RESOLUTION_FAILED" as const,
          reason: "simulated persistence outage",
        }),
        validateProof: service.validateProof.bind(service),
        assertNoActiveHold: service.assertNoActiveHold.bind(service),
      };
      const { assertInstitutionalRequirements } = await import("./phase-gate.js");
      await expect(
        assertInstitutionalRequirements({
          port: failingPort,
          requiredRole: "APPROVER",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          subjectClass: "PHASE6_APPROVAL",
          subjectType: "PHASE6_APPROVAL",
          subjectId: "subj",
          subjectHash: "hash",
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "MANDATE_RESOLUTION_FAILED" });
    });

    it("no mandate + active hold still blocks via phase gate", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedCanonicalAuthority(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
      });
      await service.createHold({
        createdBy: PRINCIPALS.holdOp,
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        reason: "Freeze",
        effect: "BLOCK",
      });
      const { assertInstitutionalRequirements } = await import("./phase-gate.js");
      await expect(
        assertInstitutionalRequirements({
          port: service,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          subjectClass: "PORTFOLIO_PLAN",
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj",
          subjectHash: "hash",
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_HOLD_ACTIVE" });
    });

    it("rejects proof for wrong subject hash", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      await seedDefaultRoleGrants(canonicalAuthority);
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_a",
        subjectHash: "hash_a",
        subjectVersion: 1,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-wrong-subject",
      });

      // Proof copies exact immutable subject binding from case
      expect(proof!.subjectType).toBe(governanceCase.subjectType);
      expect(proof!.subjectId).toBe(governanceCase.subjectId);
      expect(proof!.subjectVersion).toBe(governanceCase.subjectVersion);
      expect(proof!.subjectHash).toBe(governanceCase.subjectHash);

      // 1. Wrong subject hash -> reject
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_a",
          subjectHash: "hash_b",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_SUBJECT_MISMATCH" });

      // 2. Wrong subjectType -> reject
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_AUTHORIZATION",
          subjectId: "subj_a",
          subjectHash: "hash_a",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_SUBJECT_MISMATCH" });

      // 3. Wrong subjectId (Plan A proof used for Plan B) -> reject
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_b",
          subjectHash: "hash_a",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_SUBJECT_MISMATCH" });

      // 4. Wrong subjectVersion -> reject
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_a",
          subjectHash: "hash_a",
          subjectVersion: 2,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: GOV_TEST_NOW,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_SUBJECT_MISMATCH" });
    });

    it("delegation without canonical source fails DELEGATION_SOURCE_AUTHORITY_MISSING", async () => {
      const { service } = buildGovernanceService();
      await expect(
        service.createDelegation({
          delegatorPrincipalId: PRINCIPALS.stranger,
          delegatePrincipalId: PRINCIPALS.allocB,
          authorityRole: "PORTFOLIO_ALLOCATOR",
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
          effectiveUntil: GOV_FAR_FUTURE,
          reason: "No source",
        }),
      ).rejects.toMatchObject({ code: "DELEGATION_SOURCE_AUTHORITY_MISSING" });
    });

    it("historical attestation loses quorum weight after attestor revocation", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      const grant = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
      });
      await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
      });
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        quorumRequirement: {
          kind: "K_OF_N",
          k: 2,
          n: 2,
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: false,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_drift",
        subjectHash: "hash_drift",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: CASE_EXPIRES,
      });
      await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-drift-a",
      });
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grant.grantId,
        reason: "Revoke A",
        principalId: PRINCIPALS.govAdmin,
      });
      const second = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-drift-b",
      });
      expect(second.quorumOutcome).toBe("PENDING");
      expect(second.proof).toBeUndefined();
    });

    it("Phase 6 institutional gate precedes nonce consumption", () => {
      const source = readFileSync("src/authorization/service.ts", "utf8");
      const decideIdx = source.indexOf("async decide(");
      const institutionalIdx = source.indexOf(
        "assertInstitutionalRequirements",
        decideIdx,
      );
      const beginDecisionIdx = source.indexOf("beginDecision", decideIdx);
      expect(institutionalIdx).toBeGreaterThan(decideIdx);
      expect(beginDecisionIdx).toBeGreaterThan(institutionalIdx);
    });

    it("satisfies all 8 direct/delegated revocation laws across authority resolution and proof freshness", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);

      // A. direct grant valid, no revocation -> AUTHORIZED
      const grantA = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const resA = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resA.outcome).toBe("AUTHORIZED");

      // B. direct grant + future revocation -> AUTHORIZED before effectiveAt
      const grantB = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grantB.grantId,
        effectiveAt: "2026-07-01T00:00:00.000Z", // future revocation
        reason: "Scheduled retirement",
        principalId: PRINCIPALS.govAdmin,
      });
      const resBBefore = await service.resolveAuthority({
        principalId: PRINCIPALS.allocB,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resBBefore.outcome).toBe("AUTHORIZED");

      // C. direct grant + effective revocation -> DENIED
      const resBAfter = await service.resolveAuthority({
        principalId: PRINCIPALS.allocB,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-07-01T00:00:01.000Z",
      });
      expect(resBAfter.outcome).toBe("DENIED");

      // D. G -> D1; revoke G -> delegate D1 loses authority
      const pD1 = "principal_delegate_1";
      const del1 = await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: pD1,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        reason: "Delegate 1",
      });
      const resD1Pre = await service.resolveAuthority({
        principalId: pD1,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resD1Pre.outcome).toBe("AUTHORIZED");

      // E. G -> D1 -> D2; revoke G -> D1 and D2 lose authority
      const pD2 = "principal_delegate_2";
      await service.createDelegation({
        delegatorPrincipalId: pD1,
        delegatePrincipalId: pD2,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        maximumDelegationDepth: 2,
        reason: "Delegate 2",
      });
      const resD2Pre = await service.resolveAuthority({
        principalId: pD2,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resD2Pre.outcome).toBe("AUTHORIZED");

      // F. G -> D1 -> D2; revoke D1 -> D1 and D2 lose authority
      const pG3 = "principal_g3";
      const pD3 = "principal_d3";
      const pD4 = "principal_d4";
      await seedDirectGrant(canonicalAuthority, {
        principalId: pG3,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const del3 = await service.createDelegation({
        delegatorPrincipalId: pG3,
        delegatePrincipalId: pD3,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        reason: "Delegate 3",
      });
      await service.createDelegation({
        delegatorPrincipalId: pD3,
        delegatePrincipalId: pD4,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        maximumDelegationDepth: 2,
        reason: "Delegate 4",
      });
      await service.revokeTarget({
        targetType: "DELEGATION",
        targetId: del3.delegationId,
        reason: "Revoke D3",
        principalId: PRINCIPALS.govAdmin,
      });
      const resD3Post = await service.resolveAuthority({
        principalId: pD3,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resD3Post.outcome).toBe("DENIED");
      const resD4Post = await service.resolveAuthority({
        principalId: pD4,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resD4Post.outcome).toBe("DENIED");

      // G. attestation created while grant valid, then grant revoked -> attestation stored, no longer counts
      // H. proof created while grant valid, then grant revoked -> proof row unchanged -> validateProof() = GOVERNANCE_PROOF_STALE
      const mandate = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        quorumRequirement: {
          kind: "ANY_ONE",
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: true,
        },
      });
      const governanceCase = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_rev_h",
        subjectHash: "hash_rev_h",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandate.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      const { proof } = await service.attest({
        governanceCaseId: governanceCase.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-rev-h",
      });
      expect(proof).toBeDefined();
      expect(proof!.status).toBe("ACTIVE");

      // Valid before revoking G
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_rev_h",
          subjectHash: "hash_rev_h",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-06-01T00:00:00.000Z",
        }),
      ).resolves.toBeDefined();

      // Revoke G (grantA)
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: grantA.grantId,
        reason: "Revoke grant A",
        principalId: PRINCIPALS.govAdmin,
      });

      // D1 and D2 also now lose authority because root grantA is revoked
      const resD1Post = await service.resolveAuthority({
        principalId: pD1,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resD1Post.outcome).toBe("DENIED");
      const resD2Post = await service.resolveAuthority({
        principalId: pD2,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso: "2026-06-01T00:00:00.000Z",
      });
      expect(resD2Post.outcome).toBe("DENIED");

      // Proof row remains ACTIVE in storage
      const reloadedProof = await stack.proofs.getById(
        proof!.institutionalAuthorizationProofId,
      );
      expect(reloadedProof).not.toBeNull();
      expect(reloadedProof!.status).toBe("ACTIVE");

      // validateProof() fails with GOVERNANCE_PROOF_STALE
      await expect(
        service.validateProof({
          proofId: proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_rev_h",
          subjectHash: "hash_rev_h",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso: "2026-06-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
    });

    it("satisfies exact authority-snapshot freshness and no retroactive authority substitution (A through H)", async () => {
      const stack = buildGovernanceService();
      const { service, canonicalAuthority } = stack;
      const institution = await seedInstitution(service);
      const atIso = "2026-06-01T00:00:00.000Z";

      // A. snapshot uses G1, G1 valid -> FRESH
      const g1 = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const mandateK2 = await createActiveMandate(service, {
        institutionId: institution.institutionId,
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        quorumRequirement: {
          kind: "K_OF_N",
          k: 2,
          n: 3,
          roles: ["PORTFOLIO_ALLOCATOR"],
          rejectBlocksImmediately: false,
        },
      });
      const caseA = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_snap_fresh",
        subjectHash: "hash_snap_fresh",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandateK2.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      const attA = await service.attest({
        governanceCaseId: caseA.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-a",
      });
      const snapAFreshness = await service.validateAuthoritySnapshotFreshness({
        authoritySnapshotId: attA.attestation.authoritySnapshotId,
        authoritySnapshotHash: attA.attestation.authoritySnapshotHash,
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        atIso,
      });
      expect(snapAFreshness.outcome).toBe("FRESH");

      // B. snapshot uses G1, G1 revoked -> STALE
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: g1.grantId,
        reason: "Revoke G1",
        principalId: PRINCIPALS.govAdmin,
      });
      const snapAFreshnessPostRev =
        await service.validateAuthoritySnapshotFreshness({
          authoritySnapshotId: attA.attestation.authoritySnapshotId,
          authoritySnapshotHash: attA.attestation.authoritySnapshotHash,
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          atIso,
        });
      expect(snapAFreshnessPostRev.outcome).toBe("STALE");

      // C. snapshot uses G1, G1 revoked, G2 valid same role -> snapshot remains STALE (no retroactive substitution)
      const g2 = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const resAWithG2 = await service.resolveAuthority({
        principalId: PRINCIPALS.allocA,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso,
      });
      expect(resAWithG2.outcome).toBe("AUTHORIZED");
      const snapAFreshnessWithG2 =
        await service.validateAuthoritySnapshotFreshness({
          authoritySnapshotId: attA.attestation.authoritySnapshotId,
          authoritySnapshotHash: attA.attestation.authoritySnapshotHash,
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          atIso,
        });
      expect(snapAFreshnessWithG2.outcome).toBe("STALE");

      // D. new attestation issued through G2 -> new snapshot may be FRESH
      const caseD = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_snap_d",
        subjectHash: "hash_snap_d",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandateK2.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      const attD = await service.attest({
        governanceCaseId: caseD.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-d",
      });
      const snapDFreshness = await service.validateAuthoritySnapshotFreshness({
        authoritySnapshotId: attD.attestation.authoritySnapshotId,
        authoritySnapshotHash: attD.attestation.authoritySnapshotHash,
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        atIso,
      });
      expect(snapDFreshness.outcome).toBe("FRESH");

      // E. snapshot uses G1 -> D1, D1 revoked, alternate D9 valid -> old snapshot STALE
      const pDel = "principal_snap_del";
      const del1 = await service.createDelegation({
        delegatorPrincipalId: PRINCIPALS.allocA,
        delegatePrincipalId: pDel,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        reason: "Del 1",
      });
      const caseE = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_snap_e",
        subjectHash: "hash_snap_e",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandateK2.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      const attE = await service.attest({
        governanceCaseId: caseE.governanceCaseId,
        principalId: pDel,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-e",
      });
      expect(attE.attestation.authoritySnapshotId).toBeDefined();
      await service.revokeTarget({
        targetType: "DELEGATION",
        targetId: del1.delegationId,
        reason: "Revoke Del 1",
        principalId: PRINCIPALS.govAdmin,
      });
      // Alternate delegation D9 from another delegator
      const pOther = "principal_other_alloc";
      await seedDirectGrant(canonicalAuthority, {
        principalId: pOther,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      await service.createDelegation({
        delegatorPrincipalId: pOther,
        delegatePrincipalId: pDel,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
        reason: "Del 9",
      });
      // Delegate currently has authority via D9:
      const resDelCurrent = await service.resolveAuthority({
        principalId: pDel,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso,
      });
      expect(resDelCurrent.outcome).toBe("AUTHORIZED");
      // But old snapshot bound to D1 is STALE:
      const snapEFreshness = await service.validateAuthoritySnapshotFreshness({
        authoritySnapshotId: attE.attestation.authoritySnapshotId,
        authoritySnapshotHash: attE.attestation.authoritySnapshotHash,
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        atIso,
      });
      expect(snapEFreshness.outcome).toBe("STALE");

      // F. proof A+B / K=2; A snapshot stale -> proof stale
      const gB = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const caseF = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_snap_f",
        subjectHash: "hash_snap_f",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandateK2.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      await service.attest({
        governanceCaseId: caseF.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-fa",
      });
      const resFB = await service.attest({
        governanceCaseId: caseF.governanceCaseId,
        principalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-fb",
      });
      expect(resFB.proof).toBeDefined();
      // Valid before revoking G2
      await expect(
        service.validateProof({
          proofId: resFB.proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_snap_f",
          subjectHash: "hash_snap_f",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso,
        }),
      ).resolves.toBeDefined();
      // Revoke G2 (allocA's grant)
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: g2.grantId,
        reason: "Revoke G2",
        principalId: PRINCIPALS.govAdmin,
      });
      // validateProof fails because only B remains fresh (1 of 2 required)
      await expect(
        service.validateProof({
          proofId: resFB.proof!.institutionalAuthorizationProofId,
          subjectType: "PORTFOLIO_PLAN",
          subjectId: "subj_snap_f",
          subjectHash: "hash_snap_f",
          requiredRole: "PORTFOLIO_ALLOCATOR",
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          atIso,
        }),
      ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });

      // G. proof A+B+C / K=2; A stale, B+C fresh -> quorum remains SATISFIED according to exact quorum semantics
      const gC = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocC,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const gA3 = await seedDirectGrant(canonicalAuthority, {
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        institutionId: institution.institutionId,
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveUntil: "2026-12-31T00:00:00.000Z",
      });
      const caseG = await service.openGovernanceCase({
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_snap_g",
        subjectHash: "hash_snap_g",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [mandateK2.mandateId],
        expiresAt: "2026-12-31T00:00:00.000Z",
      });
      const attGA = await service.attest({
        governanceCaseId: caseG.governanceCaseId,
        principalId: PRINCIPALS.allocA,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-ga",
      });
      const attGB = await service.attest({
        governanceCaseId: caseG.governanceCaseId,
        principalId: PRINCIPALS.allocB,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        decision: "APPROVE",
        nonce: "nonce-snap-gb",
      });
      // Construct a third attestation for C and create proof containing A, B, and C
      const resC = await service.resolveAuthority({
        principalId: PRINCIPALS.allocC,
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso,
      });
      const snapC = await service.createAuthoritySnapshot({ resolution: resC });
      const attGC = withAttestationHash({
        attestationId: mintAttestationId({
          governanceCaseId: caseG.governanceCaseId,
          principalId: PRINCIPALS.allocC,
          authorityRole: "PORTFOLIO_ALLOCATOR",
        }),
        governanceCaseId: caseG.governanceCaseId,
        principalId: PRINCIPALS.allocC,
        authorityRole: "PORTFOLIO_ALLOCATOR",
        authoritySnapshotId: snapC.authoritySnapshotId,
        authoritySnapshotHash: snapC.snapshotHash,
        decision: "APPROVE",
        nonceHash: "hash-c",
        submittedAt: atIso,
      });
      await stack.attestations.save(attGC);

      const proof3 = withProofHash({
        institutionalAuthorizationProofId: mintProofId(caseG.caseHash),
        governanceCaseId: caseG.governanceCaseId,
        governanceCaseHash: caseG.caseHash,
        subjectType: caseG.subjectType,
        subjectId: caseG.subjectId,
        subjectVersion: caseG.subjectVersion,
        subjectHash: caseG.subjectHash,
        mandateIds: [...caseG.mandateIds],
        mandateHashes: [...caseG.mandateHashes],
        attestationIds: [
          attGA.attestation.attestationId,
          attGB.attestation.attestationId,
          attGC.attestationId,
        ],
        attestationHashes: [
          attGA.attestation.attestationHash,
          attGB.attestation.attestationHash,
          attGC.attestationHash,
        ],
        authoritySnapshotIds: [
          attGA.attestation.authoritySnapshotId,
          attGB.attestation.authoritySnapshotId,
          attGC.authoritySnapshotId,
        ],
        authoritySnapshotHashes: [
          attGA.attestation.authoritySnapshotHash,
          attGB.attestation.authoritySnapshotHash,
          attGC.authoritySnapshotHash,
        ],
        projectScope: [...caseG.projectIds],
        environmentScope: [...caseG.environmentScope],
        quorumResult: "SATISFIED",
        separationOfDutyProof: [],
        createdAt: atIso,
        expiresAt: caseG.expiresAt,
        status: "ACTIVE",
      });
      await stack.proofs.save(proof3);

      // Revoke A3
      await service.revokeTarget({
        targetType: "DIRECT_GRANT",
        targetId: gA3.grantId,
        reason: "Revoke A3",
        principalId: PRINCIPALS.govAdmin,
      });
      // Proof remains VALID because B and C are still fresh and 2 >= 2 for K_OF_N
      const proofG = await service.validateProof({
        proofId: proof3.institutionalAuthorizationProofId,
        subjectType: "PORTFOLIO_PLAN",
        subjectId: "subj_snap_g",
        subjectHash: "hash_snap_g",
        requiredRole: "PORTFOLIO_ALLOCATOR",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
        atIso,
      });
      expect(proofG).toBeDefined();
      expect(proofG.institutionalAuthorizationProofId).toBe(
        proof3.institutionalAuthorizationProofId,
      );

      // H. snapshot hash mismatch -> fail closed
      const snapTampered = {
        ...attD.attestation,
        authoritySnapshotHash: "tampered_hash_value",
      };
      const snapTamperedFreshness =
        await service.validateAuthoritySnapshotFreshness({
          authoritySnapshotId: snapTampered.authoritySnapshotId,
          authoritySnapshotHash: snapTampered.authoritySnapshotHash,
          projectId: GOV_PROJECT_ID,
          environment: GOV_ENV_STAGING,
          requiredRole: "PORTFOLIO_ALLOCATOR",
          atIso,
        });
      expect(snapTamperedFreshness.outcome).toBe("STALE");
    });
  });
});
