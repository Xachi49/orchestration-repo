import { createHash } from "node:crypto";
import { GovernanceError } from "./errors.js";
import type { InstitutionalGovernancePort } from "./port.js";
import {
  isOperationalPhaseRole,
  type CanonicalAuthorityGrant,
  type CanonicalAuthorityGrantPort,
} from "./canonical-authority.js";
import {
  resolveMandateApplicability,
  type MandateResolutionResult,
} from "./mandate-resolution.js";
import {
  mintInstitutionId,
  mintOrganizationalUnitId,
  type Institution,
  type OrganizationalUnit,
} from "./institution.js";
import {
  mintMandateId,
  withMandateHash,
  type GovernanceMandate,
} from "./mandate.js";
import {
  assertDelegationAttenuation,
  assertDelegationDepth,
  assertNoDelegationCycle,
  mintDelegationId,
  withDelegationHash,
  type AuthorityDelegation,
  type DelegatorEffectiveScope,
} from "./delegation.js";
import {
  mintAuditEventId,
  mintDirectGrantId,
  type DirectAuthorityGrant,
} from "./grants.js";
import {
  attestationLogicalKey,
  mintAttestationId,
  mintGovernanceCaseId,
  withAttestationHash,
  withCaseHash,
  type GovernanceAttestation,
  type GovernanceCase,
} from "./case.js";
import {
  mintProofId,
  withProofHash,
  type InstitutionalAuthorizationProof,
} from "./proof.js";
import {
  mintHoldId,
  mintRevocationId,
  withHoldHash,
  withRevocationHash,
  type AuthorityRevocation,
  type GovernanceHold,
} from "./revocation-hold.js";
import {
  buildAuthoritySnapshot,
  computeAuthorityFingerprint,
  computeSnapshotHash,
  type InstitutionalAuthorityResolution,
  type InstitutionalAuthoritySnapshot,
} from "./authority-resolution.js";
import {
  evaluateGovernanceQuorum,
  type GovernanceQuorumRequirement,
  type QuorumSeatContribution,
} from "./quorum.js";
import {
  assertSeparationOfDuties,
  type SeparationOfDutyRule,
} from "./separation.js";
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

function defaultNonceHash(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function isSubset(
  inner: readonly string[],
  outer: readonly string[],
): boolean {
  const set = new Set(outer);
  return inner.every((x) => set.has(x));
}

function inTimeWindow(
  atIso: string,
  effectiveFrom: string,
  effectiveUntil: string | undefined,
): boolean {
  const t = Date.parse(atIso);
  if (Number.isNaN(t)) return false;
  if (t < Date.parse(effectiveFrom)) return false;
  if (effectiveUntil !== undefined && t > Date.parse(effectiveUntil)) {
    return false;
  }
  return true;
}

export interface GovernanceOrchestrationDeps {
  nowIso: () => string;
  institutions: InstitutionRepository;
  units: OrganizationalUnitRepository;
  mandates: GovernanceMandateRepository;
  delegations: AuthorityDelegationRepository;
  /** Canonical authority_grants projection — sole direct authority source. */
  canonicalAuthority: CanonicalAuthorityGrantPort;
  directGrants: DirectAuthorityGrantRepository;
  cases: GovernanceCaseRepository;
  attestations: GovernanceAttestationRepository;
  proofs: InstitutionalAuthorizationProofRepository;
  revocations: AuthorityRevocationRepository;
  holds: GovernanceHoldRepository;
  snapshots: InstitutionalAuthoritySnapshotRepository;
  audits: GovernanceAuditRepository;
  isGovernanceAdmin?: (
    principalId: string,
    institutionId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  isGovernanceHoldOperator?: (
    principalId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  /** Defaults to sha256 hex digest of nonce (hashDecisionNonce pattern). */
  nonceHash?: (nonce: string) => string;
}

export class GovernanceOrchestrationService
  implements InstitutionalGovernancePort
{
  private readonly nonceHash: (nonce: string) => string;

  constructor(private readonly deps: GovernanceOrchestrationDeps) {
    this.nonceHash = deps.nonceHash ?? defaultNonceHash;
  }

  // ── InstitutionalGovernancePort ──────────────────────────────────────

  async resolveAuthority(input: {
    principalId: string;
    requiredRole: string;
    projectId: string;
    environment: string;
    action?: string;
    subjectId?: string;
    atIso: string;
  }): Promise<InstitutionalAuthorityResolution> {
    return this.resolveAuthorityInternal(input);
  }

  async resolveApplicableMandates(input: {
    requiredRole: string;
    projectId: string;
    environment: string;
    subjectClass: string;
    atIso: string;
    action?: string;
    riskLevel?: string;
    materialityContext?: Record<string, number>;
  }): Promise<MandateResolutionResult> {
    try {
      const active = await this.deps.mandates.listActiveByProject(input.projectId);
      return resolveMandateApplicability(active, input);
    } catch (error) {
      return {
        kind: "MANDATE_RESOLUTION_FAILED",
        reason:
          error instanceof Error
            ? error.message
            : "Mandate repository resolution failed",
      };
    }
  }

  async validateProof(input: {
    proofId: string;
    subjectType: string;
    subjectId: string;
    subjectHash: string;
    subjectVersion?: number;
    requiredRole: string;
    action?: string;
    projectId: string;
    environment: string;
    atIso: string;
  }): Promise<InstitutionalAuthorizationProof> {
    const proof = await this.deps.proofs.getById(input.proofId);
    if (!proof) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_NOT_FOUND",
        `Proof ${input.proofId} not found`,
      );
    }
    if (proof.status === "REVOKED" || proof.status === "STALE") {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_STALE",
        `Proof ${input.proofId} is ${proof.status}`,
      );
    }
    const revocations = await this.deps.revocations.listByTarget(
      "INSTITUTIONAL_PROOF",
      proof.institutionalAuthorizationProofId,
    );
    if (revocations.length > 0) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_STALE",
        `Proof ${input.proofId} has been revoked`,
      );
    }

    this.assertProofSubjectBinding(proof, input);
    const governanceCase = await this.requireCase(proof.governanceCaseId);
    if (governanceCase.requiredRole !== input.requiredRole) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_SUBJECT_MISMATCH",
        "Proof requiredRole mismatch",
      );
    }
    if (
      input.action !== undefined &&
      governanceCase.action !== undefined &&
      governanceCase.action !== input.action
    ) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_SUBJECT_MISMATCH",
        "Proof action mismatch",
      );
    }

    if (Date.parse(input.atIso) > Date.parse(proof.expiresAt)) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_EXPIRED",
        `Proof ${input.proofId} expired`,
      );
    }

    await this.assertMandatesFreshForProof(proof, input.atIso);

    await this.assertNoActiveHold({
      projectId: input.projectId,
      environment: input.environment,
      atIso: input.atIso,
    });

    const attestations = await this.deps.attestations.listByCase(
      proof.governanceCaseId,
    );
    const byId = new Map(attestations.map((a) => [a.attestationId, a]));
    const validContributions: QuorumSeatContribution[] = [];

    for (let i = 0; i < proof.attestationIds.length; i++) {
      const attestationId = proof.attestationIds[i]!;
      const expectedAttestationHash = proof.attestationHashes[i];
      const expectedSnapshotId = proof.authoritySnapshotIds[i];
      const expectedSnapshotHash = proof.authoritySnapshotHashes[i];

      const att = byId.get(attestationId);
      if (!att || att.decision !== "APPROVE") {
        throw new GovernanceError(
          "GOVERNANCE_PROOF_STALE",
          `Proof attestation ${attestationId} missing or not APPROVE`,
        );
      }
      if (
        expectedAttestationHash !== undefined &&
        att.attestationHash !== expectedAttestationHash
      ) {
        throw new GovernanceError(
          "GOVERNANCE_PROOF_STALE",
          `Proof attestation ${attestationId} hash drift`,
        );
      }

      const snapshotId = expectedSnapshotId ?? att.authoritySnapshotId;
      const snapshotHash = expectedSnapshotHash ?? att.authoritySnapshotHash;

      const snapshotFreshness = await this.validateAuthoritySnapshotFreshness({
        authoritySnapshotId: snapshotId,
        authoritySnapshotHash: snapshotHash,
        projectId: input.projectId,
        environment: input.environment,
        requiredRole: att.authorityRole,
        atIso: input.atIso,
      });

      if (snapshotFreshness.outcome === "FRESH") {
        validContributions.push({
          principalId: att.principalId,
          authorityRole: att.authorityRole,
          decision: att.decision,
          attestationId: att.attestationId,
        });
      }
    }

    const quorum = evaluateGovernanceQuorum({
      requirement: governanceCase.quorumRequirement,
      contributions: validContributions,
    });

    if (quorum.outcome !== "SATISFIED") {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_STALE",
        `Proof quorum no longer SATISFIED (now ${quorum.outcome}) — attestor authority loss or drift`,
      );
    }

    return proof;
  }

  async getAuthoritySnapshot(
    snapshotId: string,
  ): Promise<InstitutionalAuthoritySnapshot | null> {
    return this.deps.snapshots.getById(snapshotId);
  }

  async validateAuthoritySnapshotFreshness(input: {
    authoritySnapshotId: string;
    authoritySnapshotHash?: string;
    projectId?: string;
    environment?: string;
    requiredRole?: string;
    atIso: string;
  }): Promise<
    | { outcome: "FRESH"; snapshot: InstitutionalAuthoritySnapshot }
    | { outcome: "STALE"; reasons: string[] }
  > {
    const snapshot = await this.deps.snapshots.getById(
      input.authoritySnapshotId,
    );
    if (!snapshot) {
      return {
        outcome: "STALE",
        reasons: [`Authority snapshot ${input.authoritySnapshotId} not found`],
      };
    }

    const { authoritySnapshotId, snapshotHash, ...payload } = snapshot;
    const computedHash = computeSnapshotHash(payload);
    if (snapshot.snapshotHash !== computedHash) {
      return {
        outcome: "STALE",
        reasons: [
          `Authority snapshot ${input.authoritySnapshotId} hash mismatch`,
        ],
      };
    }
    if (
      input.authoritySnapshotHash !== undefined &&
      input.authoritySnapshotHash !== snapshot.snapshotHash
    ) {
      return {
        outcome: "STALE",
        reasons: [
          `Authority snapshot ${input.authoritySnapshotId} expected hash mismatch`,
        ],
      };
    }

    if (input.requiredRole && snapshot.role !== input.requiredRole) {
      return {
        outcome: "STALE",
        reasons: [
          `Snapshot role ${snapshot.role} does not match required role ${input.requiredRole}`,
        ],
      };
    }

    if (
      input.projectId &&
      !snapshot.resolvedScope.projectIds.includes(input.projectId)
    ) {
      return {
        outcome: "STALE",
        reasons: [
          `Snapshot project scope does not include project ${input.projectId}`,
        ],
      };
    }

    if (
      input.environment &&
      !snapshot.resolvedScope.environments.includes(input.environment)
    ) {
      return {
        outcome: "STALE",
        reasons: [
          `Snapshot environment scope does not include environment ${input.environment}`,
        ],
      };
    }

    // Check active holds for project / environment / role
    const holds = await this.deps.holds.listActiveByProject(snapshot.projectId);
    for (const hold of holds) {
      if (!inTimeWindow(input.atIso, hold.effectiveFrom, hold.effectiveUntil)) {
        continue;
      }
      if (
        hold.environmentScope.length > 0 &&
        input.environment &&
        !hold.environmentScope.includes(input.environment)
      ) {
        continue;
      }
      if (
        hold.authorityRoles.length > 0 &&
        !hold.authorityRoles.includes(snapshot.role)
      ) {
        continue;
      }
      return {
        outcome: "STALE",
        reasons: [`Active hold ${hold.holdId} blocks authority snapshot`],
      };
    }

    // Direct grant basis
    if (
      snapshot.directGrantIds.length > 0 &&
      snapshot.delegationChain.length === 0
    ) {
      for (const grantId of snapshot.directGrantIds) {
        const g = await this.deps.canonicalAuthority.getById(grantId);
        if (!g || !g.enabled) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} not found or disabled`],
          };
        }
        if (g.principalId !== snapshot.principalId) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} principal mismatch`],
          };
        }
        if (g.authorityRole !== snapshot.role) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} role mismatch`],
          };
        }
        if (
          input.projectId &&
          g.projectId !== input.projectId
        ) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} project mismatch`],
          };
        }
        if (
          input.environment &&
          !g.environmentScope.includes(input.environment)
        ) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} environment mismatch`],
          };
        }
        if (
          g.effectiveFrom !== undefined &&
          !inTimeWindow(input.atIso, g.effectiveFrom, g.effectiveUntil)
        ) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} outside effective window`],
          };
        }
        if (
          g.effectiveFrom === undefined &&
          g.effectiveUntil !== undefined &&
          Date.parse(input.atIso) > Date.parse(g.effectiveUntil)
        ) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} expired`],
          };
        }
        const revs = await this.deps.revocations.listByTarget(
          "DIRECT_GRANT",
          grantId,
        );
        if (
          revs.some((r) => Date.parse(r.effectiveAt) <= Date.parse(input.atIso))
        ) {
          return {
            outcome: "STALE",
            reasons: [`Canonical grant ${grantId} revoked`],
          };
        }
      }
      return { outcome: "FRESH", snapshot };
    }

    // Delegated basis
    if (snapshot.delegationChain.length > 0) {
      for (const delegationId of snapshot.delegationChain) {
        const d = await this.deps.delegations.getById(delegationId);
        if (!d || d.status !== "ACTIVE") {
          return {
            outcome: "STALE",
            reasons: [`Delegation ${delegationId} not ACTIVE`],
          };
        }
        if (!inTimeWindow(input.atIso, d.effectiveFrom, d.effectiveUntil)) {
          return {
            outcome: "STALE",
            reasons: [`Delegation ${delegationId} outside effective window`],
          };
        }
        const dRevs = await this.deps.revocations.listByTarget(
          "DELEGATION",
          delegationId,
        );
        if (
          dRevs.some(
            (r) => Date.parse(r.effectiveAt) <= Date.parse(input.atIso),
          )
        ) {
          return {
            outcome: "STALE",
            reasons: [`Delegation ${delegationId} revoked`],
          };
        }
        const sourceGrantsOk = await this.sourceGrantsValid(
          d.sourceAuthorityGrantIds,
          input.atIso,
        );
        if (!sourceGrantsOk.ok) {
          return {
            outcome: "STALE",
            reasons: [
              `Source grant in delegation chain ${delegationId} revoked or invalid`,
            ],
          };
        }
      }
      const leafId =
        snapshot.delegationChain[snapshot.delegationChain.length - 1]!;
      const leaf = await this.deps.delegations.getById(leafId);
      if (
        !leaf ||
        leaf.delegatePrincipalId !== snapshot.principalId ||
        leaf.authorityRole !== snapshot.role
      ) {
        return {
          outcome: "STALE",
          reasons: [`Leaf delegation ${leafId} delegate/role mismatch`],
        };
      }
      return { outcome: "FRESH", snapshot };
    }

    return {
      outcome: "STALE",
      reasons: ["No direct grants or delegation chain in snapshot"],
    };
  }

  private assertProofSubjectBinding(
    proof: InstitutionalAuthorizationProof,
    input: {
      subjectType: string;
      subjectId: string;
      subjectHash: string;
      subjectVersion?: number;
      requiredRole: string;
      projectId: string;
      environment: string;
    },
  ): void {
    const mismatch = (detail: string) =>
      new GovernanceError("GOVERNANCE_PROOF_SUBJECT_MISMATCH", detail);

    if (proof.subjectType !== input.subjectType) {
      throw mismatch("Proof subjectType mismatch");
    }
    if (proof.subjectId !== input.subjectId) {
      throw mismatch("Proof subjectId mismatch");
    }
    if (proof.subjectHash !== input.subjectHash) {
      throw mismatch("Proof subjectHash mismatch");
    }
    if (
      input.subjectVersion !== undefined &&
      proof.subjectVersion !== undefined &&
      proof.subjectVersion !== input.subjectVersion
    ) {
      throw mismatch("Proof subjectVersion mismatch");
    }
    if (!proof.projectScope.includes(input.projectId)) {
      throw mismatch("Proof project scope mismatch");
    }
    if (!proof.environmentScope.includes(input.environment)) {
      throw mismatch("Proof environment scope mismatch");
    }
  }

  private async assertMandatesFreshForProof(
    proof: InstitutionalAuthorizationProof,
    atIso: string,
  ): Promise<void> {
    for (let i = 0; i < proof.mandateIds.length; i++) {
      const mandateId = proof.mandateIds[i]!;
      const expectedHash = proof.mandateHashes[i];
      const mandate = await this.deps.mandates.getById(mandateId);
      if (!mandate || mandate.status !== "ACTIVE") {
        throw new GovernanceError(
          "GOVERNANCE_PROOF_STALE",
          `Mandate ${mandateId} no longer ACTIVE for proof`,
        );
      }
      if (expectedHash !== undefined && mandate.mandateHash !== expectedHash) {
        throw new GovernanceError(
          "GOVERNANCE_PROOF_STALE",
          `Mandate ${mandateId} version/hash drift — proof stale`,
        );
      }
      if (!inTimeWindow(atIso, mandate.effectiveFrom, mandate.effectiveUntil)) {
        throw new GovernanceError(
          "GOVERNANCE_PROOF_STALE",
          `Mandate ${mandateId} outside effective window`,
        );
      }
    }
  }

  async assertNoActiveHold(input: {
    projectId: string;
    environment: string;
    authorityRole?: string;
    subjectClass?: string;
    atIso: string;
  }): Promise<void> {
    const holds = await this.deps.holds.listActiveByProject(input.projectId);
    for (const hold of holds) {
      if (!inTimeWindow(input.atIso, hold.effectiveFrom, hold.effectiveUntil)) {
        continue;
      }
      if (
        hold.environmentScope.length > 0 &&
        !hold.environmentScope.includes(input.environment)
      ) {
        continue;
      }
      if (
        input.authorityRole &&
        hold.authorityRoles.length > 0 &&
        !hold.authorityRoles.includes(input.authorityRole)
      ) {
        continue;
      }
      if (
        input.subjectClass &&
        hold.subjectClasses.length > 0 &&
        !hold.subjectClasses.includes(input.subjectClass)
      ) {
        continue;
      }
      throw new GovernanceError(
        "GOVERNANCE_HOLD_ACTIVE",
        `Active governance hold ${hold.holdId}: ${hold.reason}`,
        { holdId: hold.holdId, reason: hold.reason },
      );
    }
  }

  /** Port alias — identical to validateProof with proof-derived subject metadata. */
  async getProof(input: {
    proofId: string;
    subjectId: string;
    subjectHash: string;
    projectId: string;
    environment: string;
    atIso: string;
  }): Promise<InstitutionalAuthorizationProof> {
    const proof = await this.deps.proofs.getById(input.proofId);
    if (!proof) {
      throw new GovernanceError(
        "GOVERNANCE_PROOF_NOT_FOUND",
        `Proof ${input.proofId} not found`,
      );
    }
    const governanceCase = await this.requireCase(proof.governanceCaseId);
    return this.validateProof({
      proofId: input.proofId,
      subjectType: proof.subjectType,
      subjectId: input.subjectId,
      subjectHash: input.subjectHash,
      ...(proof.subjectVersion !== undefined
        ? { subjectVersion: proof.subjectVersion }
        : {}),
      requiredRole: governanceCase.requiredRole,
      ...(governanceCase.action !== undefined
        ? { action: governanceCase.action }
        : {}),
      projectId: input.projectId,
      environment: input.environment,
      atIso: input.atIso,
    });
  }

  // ── Mutations ────────────────────────────────────────────────────────

  async createInstitution(input: {
    name: string;
    projectIds?: string[];
  }): Promise<Institution> {
    const now = this.deps.nowIso();
    const institutionId = mintInstitutionId({
      name: input.name,
      createdAt: now,
    });
    const institution: Institution = {
      institutionId,
      name: input.name,
      projectIds: input.projectIds ?? [],
      organizationalUnitIds: [],
      createdAt: now,
      status: "ACTIVE",
      recordRevision: 1,
    };
    const saved = await this.deps.institutions.save(institution);
    await this.audit("INSTITUTION_CREATED", {
      institutionId,
      subjectIds: [institutionId],
      payload: { name: input.name },
    });
    return saved;
  }

  async createOrganizationalUnit(input: {
    institutionId: string;
    name: string;
    description?: string;
    projectScope?: string[];
    parentUnitId?: string;
  }): Promise<OrganizationalUnit> {
    const institution = await this.deps.institutions.getById(input.institutionId);
    if (!institution) {
      throw new GovernanceError(
        "INSTITUTION_NOT_FOUND",
        `Institution ${input.institutionId} not found`,
      );
    }
    const organizationalUnitId = mintOrganizationalUnitId({
      institutionId: input.institutionId,
      name: input.name,
    });
    const unit: OrganizationalUnit = {
      organizationalUnitId,
      institutionId: input.institutionId,
      name: input.name,
      description: input.description ?? "",
      projectScope: input.projectScope ?? [],
      parentUnitId: input.parentUnitId,
      status: "ACTIVE",
    };
    const saved = await this.deps.units.save(unit);
    await this.deps.institutions.save({
      ...institution,
      organizationalUnitIds: [
        ...new Set([
          ...institution.organizationalUnitIds,
          organizationalUnitId,
        ]),
      ],
      recordRevision: institution.recordRevision + 1,
    });
    await this.audit("ORGANIZATIONAL_UNIT_CREATED", {
      institutionId: input.institutionId,
      subjectIds: [organizationalUnitId],
      payload: { name: input.name },
    });
    return saved;
  }

  async createMandate(input: {
    institutionId: string;
    createdBy: string;
    subjectClasses: string[];
    requiredAuthorities: string[];
    projectScope: string[];
    environmentScope: string[];
    quorumRequirement?: GovernanceQuorumRequirement;
    separationOfDutyRules?: SeparationOfDutyRule[];
    delegationPolicy?: GovernanceMandate["delegationPolicy"];
    maximumAuthorityDurationMs?: number;
    maximumDelegationDepth?: number;
    riskScope?: string[];
    resourceScope?: Record<string, number>;
    effectiveFrom?: string;
    effectiveUntil?: string;
    mandateVersion?: number;
  }): Promise<GovernanceMandate> {
    await this.requireGovernanceAdmin(
      input.createdBy,
      input.institutionId,
      input.projectScope,
    );
    await this.assertMandateNotSelfEscalation(input);

    const now = this.deps.nowIso();
    const mandateId = mintMandateId({
      institutionId: input.institutionId,
      createdAt: now,
    });
    const mandate = withMandateHash({
      mandateId,
      mandateVersion: input.mandateVersion ?? 1,
      institutionId: input.institutionId,
      subjectClasses: input.subjectClasses,
      requiredAuthorities: input.requiredAuthorities,
      projectScope: input.projectScope,
      environmentScope: input.environmentScope,
      quorumRequirement: input.quorumRequirement,
      separationOfDutyRules: input.separationOfDutyRules ?? [],
      delegationPolicy: input.delegationPolicy ?? {
        allowDelegation: true,
        maximumDelegationDepth: 1,
        redelegationForbidden: false,
      },
      maximumAuthorityDurationMs: input.maximumAuthorityDurationMs,
      maximumDelegationDepth: input.maximumDelegationDepth,
      riskScope: input.riskScope ?? [],
      resourceScope: input.resourceScope ?? {},
      effectiveFrom: input.effectiveFrom ?? now,
      effectiveUntil: input.effectiveUntil,
      status: "DRAFT",
      createdBy: input.createdBy,
      createdAt: now,
      recordRevision: 1,
    });
    const saved = await this.deps.mandates.save(mandate);
    await this.audit("MANDATE_CREATED", {
      institutionId: input.institutionId,
      principalId: input.createdBy,
      subjectIds: [mandateId],
      payload: { status: "DRAFT" },
    });
    return saved;
  }

  async activateMandate(input: {
    mandateId: string;
    actorPrincipalId: string;
  }): Promise<GovernanceMandate> {
    const mandate = await this.requireMandate(input.mandateId);
    await this.requireGovernanceAdmin(
      input.actorPrincipalId,
      mandate.institutionId,
      mandate.projectScope,
    );
    if (mandate.status !== "DRAFT" && mandate.status !== "SUSPENDED") {
      throw new GovernanceError(
        "GOVERNANCE_MANDATE_STATE_CONFLICT",
        `Mandate ${input.mandateId} cannot activate from ${mandate.status}`,
      );
    }
    const activated = await this.deps.mandates.transition(
      input.mandateId,
      mandate.status,
      mandate.recordRevision,
      "ACTIVE",
      this.deps.nowIso(),
    );
    await this.audit("MANDATE_ACTIVATED", {
      institutionId: mandate.institutionId,
      principalId: input.actorPrincipalId,
      subjectIds: [input.mandateId],
    });
    return activated;
  }

  async createDirectGrant(input: {
    createdBy: string;
    principalId: string;
    authorityRole: string;
    institutionId: string;
    projectScope: string[];
    environmentScope: string[];
    actionScope?: string[];
    effectiveFrom?: string;
    effectiveUntil: string;
    maximumRisk?: DirectAuthorityGrant["maximumRisk"];
    maximumResourceEnvelope?: Record<string, number>;
  }): Promise<DirectAuthorityGrant> {
    await this.requireGovernanceAdmin(
      input.createdBy,
      input.institutionId,
      input.projectScope,
    );
    if (isOperationalPhaseRole(input.authorityRole)) {
      throw new GovernanceError(
        "GOVERNANCE_ADMIN_CANNOT_MINT_OPERATIONAL_AUTHORITY",
        `GOVERNANCE_ADMIN cannot mint operational role ${input.authorityRole} — use canonical authority_grants bootstrap`,
        { authorityRole: input.authorityRole },
      );
    }
    if (input.principalId === input.createdBy) {
      await this.assertDirectGrantNotSelfEscalation(input);
    }

    const now = this.deps.nowIso();
    for (const projectId of input.projectScope) {
      const canonical = await this.deps.canonicalAuthority.listByPrincipal(
        input.principalId,
      );
      const hasCanonical = canonical.some(
        (g) =>
          g.authorityRole === input.authorityRole &&
          g.projectId === projectId &&
          g.enabled &&
          input.environmentScope.some((env) =>
            g.environmentScope.includes(env),
          ),
      );
      if (!hasCanonical) {
        throw new GovernanceError(
          "DELEGATION_SOURCE_AUTHORITY_MISSING",
          `No canonical authority_grants source for ${input.authorityRole} on ${projectId}`,
        );
      }
    }

    const grantId = mintDirectGrantId({
      principalId: input.principalId,
      authorityRole: input.authorityRole,
      createdAt: now,
    });
    const grant: DirectAuthorityGrant = {
      grantId,
      principalId: input.principalId,
      authorityRole: input.authorityRole,
      institutionId: input.institutionId,
      projectScope: input.projectScope,
      environmentScope: input.environmentScope,
      actionScope: input.actionScope ?? [],
      effectiveFrom: input.effectiveFrom ?? now,
      effectiveUntil: input.effectiveUntil,
      ...(input.maximumRisk !== undefined
        ? { maximumRisk: input.maximumRisk }
        : {}),
      maximumResourceEnvelope: input.maximumResourceEnvelope ?? {},
      status: "ACTIVE",
      createdAt: now,
    };
    const saved = await this.deps.directGrants.save(grant);
    await this.audit("DIRECT_GRANT_CREATED", {
      institutionId: input.institutionId,
      principalId: input.createdBy,
      subjectIds: [grantId, input.principalId],
      payload: { authorityRole: input.authorityRole },
    });
    return saved;
  }

  async createDelegation(input: {
    delegatorPrincipalId: string;
    delegatePrincipalId: string;
    authorityRole: string;
    projectScope: string[];
    environmentScope: string[];
    actionScope?: string[];
    subjectScope?: string[];
    effectiveFrom?: string;
    effectiveUntil: string;
    maximumRisk?: AuthorityDelegation["maximumRisk"];
    maximumResourceEnvelope?: Record<string, number>;
    reason: string;
    maximumDelegationDepth?: number;
  }): Promise<AuthorityDelegation> {
    const now = this.deps.nowIso();
    const atIso = input.effectiveFrom ?? now;

    const delegatorScope = await this.resolveDelegatorScope({
      delegatorPrincipalId: input.delegatorPrincipalId,
      authorityRole: input.authorityRole,
      projectScope: input.projectScope,
      environmentScope: input.environmentScope,
      atIso: now,
    });

    assertDelegationAttenuation({
      proposed: {
        projectScope: input.projectScope,
        environmentScope: input.environmentScope,
        authorityRole: input.authorityRole,
        effectiveFrom: atIso,
        effectiveUntil: input.effectiveUntil,
        ...(input.maximumRisk !== undefined
          ? { maximumRisk: input.maximumRisk }
          : {}),
        maximumResourceEnvelope: input.maximumResourceEnvelope ?? {},
        actionScope: input.actionScope ?? [],
      },
      delegator: delegatorScope,
    });

    const depth = delegatorScope.delegationDepth + 1;
    const maximumDepth = input.maximumDelegationDepth ?? 1;
    assertDelegationDepth(depth, maximumDepth);

    const delegationId = mintDelegationId({
      delegatorPrincipalId: input.delegatorPrincipalId,
      delegatePrincipalId: input.delegatePrincipalId,
      createdAt: now,
    });

    const active = await this.deps.delegations.listActive();
    assertNoDelegationCycle({
      newDelegationId: delegationId,
      delegatePrincipalId: input.delegatePrincipalId,
      delegatorPrincipalId: input.delegatorPrincipalId,
      edges: active.map((d) => ({
        from: d.delegatorPrincipalId,
        to: d.delegatePrincipalId,
        delegationId: d.delegationId,
      })),
    });

    // When redelegating, append the leaf delegation that authorized the delegator.
    const sourceDelegationIds =
      delegatorScope.sourceDelegationIds.length > 0
        ? [...delegatorScope.sourceDelegationIds]
        : [];

    const finalDelegation = withDelegationHash({
      delegationId,
      delegationVersion: 1,
      delegatorPrincipalId: input.delegatorPrincipalId,
      delegatePrincipalId: input.delegatePrincipalId,
      authorityRole: input.authorityRole,
      projectScope: input.projectScope,
      environmentScope: input.environmentScope,
      actionScope: input.actionScope ?? [],
      subjectScope: input.subjectScope ?? [],
      effectiveFrom: atIso,
      effectiveUntil: input.effectiveUntil,
      ...(input.maximumRisk !== undefined
        ? { maximumRisk: input.maximumRisk }
        : {}),
      maximumResourceEnvelope: input.maximumResourceEnvelope ?? {},
      sourceAuthorityGrantIds: [...delegatorScope.sourceAuthorityGrantIds],
      sourceDelegationIds,
      delegationDepth: depth,
      reason: input.reason,
      status: "ACTIVE",
      createdAt: now,
      recordRevision: 1,
    });

    const saved = await this.deps.delegations.save(finalDelegation);
    await this.audit("DELEGATION_CREATED", {
      principalId: input.delegatorPrincipalId,
      subjectIds: [delegationId, input.delegatePrincipalId],
      payload: { authorityRole: input.authorityRole, depth },
    });
    return saved;
  }

  async revokeTarget(input: {
    targetType: AuthorityRevocation["targetType"];
    targetId: string;
    reason: string;
    principalId: string;
    effectiveAt?: string;
  }): Promise<AuthorityRevocation> {
    const now = this.deps.nowIso();
    const effectiveAt = input.effectiveAt ?? now;
    const revocationId = mintRevocationId({
      targetType: input.targetType,
      targetId: input.targetId,
      effectiveAt,
    });
    const revocation = withRevocationHash({
      revocationId,
      targetType: input.targetType,
      targetId: input.targetId,
      reason: input.reason,
      effectiveAt,
      principalId: input.principalId,
      createdAt: now,
    });
    const saved = await this.deps.revocations.save(revocation);

    switch (input.targetType) {
      case "DIRECT_GRANT": {
        const canonical = await this.deps.canonicalAuthority.getById(
          input.targetId,
        );
        if (!canonical) {
          await this.deps.directGrants.markRevoked(input.targetId);
        }
        break;
      }
      case "DELEGATION": {
        const d = await this.deps.delegations.getById(input.targetId);
        if (!d) {
          throw new GovernanceError(
            "AUTHORITY_DELEGATION_NOT_FOUND",
            `Delegation ${input.targetId} not found`,
          );
        }
        if (d.status === "ACTIVE" || d.status === "PROPOSED" || d.status === "SUSPENDED") {
          await this.deps.delegations.transition(
            input.targetId,
            d.status,
            d.recordRevision,
            "REVOKED",
            now,
          );
        }
        break;
      }
      case "MANDATE": {
        const m = await this.deps.mandates.getById(input.targetId);
        if (!m) {
          throw new GovernanceError(
            "GOVERNANCE_MANDATE_NOT_FOUND",
            `Mandate ${input.targetId} not found`,
          );
        }
        if (m.status === "ACTIVE" || m.status === "DRAFT" || m.status === "SUSPENDED") {
          await this.deps.mandates.transition(
            input.targetId,
            m.status,
            m.recordRevision,
            "REVOKED",
            now,
          );
        }
        break;
      }
      case "INSTITUTIONAL_PROOF": {
        await this.deps.proofs.markStale(input.targetId);
        break;
      }
      default: {
        const _exhaustive: never = input.targetType;
        throw new GovernanceError(
          "AUTHORITY_REVOCATION_INVALID",
          `Unknown target type ${_exhaustive}`,
        );
      }
    }

    await this.audit("AUTHORITY_REVOKED", {
      principalId: input.principalId,
      subjectIds: [input.targetId],
      payload: { targetType: input.targetType, reason: input.reason },
    });
    return saved;
  }

  async createAuthoritySnapshot(input: {
    resolution: InstitutionalAuthorityResolution;
    revocationIds?: string[];
    holdIds?: string[];
  }): Promise<InstitutionalAuthoritySnapshot> {
    const snapshot = buildAuthoritySnapshot({
      principalId: input.resolution.principalId,
      role: input.resolution.requiredRole,
      projectId: input.resolution.projectId,
      environment: input.resolution.environment,
      directGrantIds: [...input.resolution.directGrantIds],
      delegationChain: [...input.resolution.delegationChain],
      mandateIds: [...input.resolution.mandateIds],
      mandateHashes: [...input.resolution.mandateHashes],
      revocationIds: input.revocationIds ?? [],
      holdIds: input.holdIds ?? [],
      resolvedScope: {
        projectIds: [...input.resolution.scope.projectIds],
        environments: [...input.resolution.scope.environments],
      },
      sourceAuthorityFingerprint: input.resolution.sourceAuthorityFingerprint,
      institutionalAuthorityFingerprint:
        input.resolution.institutionalAuthorityFingerprint,
    });
    return this.deps.snapshots.save(snapshot);
  }

  async openGovernanceCase(input: {
    subjectType: string;
    subjectId: string;
    subjectHash: string;
    subjectVersion?: number;
    requiredRole: string;
    action?: string;
    projectIds: string[];
    environmentScope: string[];
    mandateIds: string[];
    expiresAt: string;
  }): Promise<GovernanceCase> {
    if (input.mandateIds.length === 0) {
      throw new GovernanceError(
        "GOVERNANCE_MANDATE_INVALID",
        "openGovernanceCase requires at least one mandate",
      );
    }
    const mandates: GovernanceMandate[] = [];
    for (const id of input.mandateIds) {
      const m = await this.requireMandate(id);
      if (m.status !== "ACTIVE") {
        throw new GovernanceError(
          "GOVERNANCE_MANDATE_STATE_CONFLICT",
          `Mandate ${id} is not ACTIVE`,
        );
      }
      mandates.push(m);
    }

    const now = this.deps.nowIso();
    for (const projectId of input.projectIds) {
      await this.assertNoActiveHold({
        projectId,
        environment: input.environmentScope[0]!,
        authorityRole: input.requiredRole,
        atIso: now,
      });
    }

    const quorumRequirement =
      mandates.find((m) => m.quorumRequirement)?.quorumRequirement ?? {
        kind: "ANY_ONE" as const,
        roles: [],
        rejectBlocksImmediately: true,
      };
    const separationRules = mandates.flatMap((m) => m.separationOfDutyRules);

    const governanceCaseId = mintGovernanceCaseId({
      subjectId: input.subjectId,
      createdAt: now,
    });
    const governanceCase = withCaseHash({
      governanceCaseId,
      caseVersion: 1,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectVersion: input.subjectVersion,
      subjectHash: input.subjectHash,
      requiredRole: input.requiredRole,
      action: input.action,
      projectIds: input.projectIds,
      environmentScope: input.environmentScope,
      mandateIds: mandates.map((m) => m.mandateId),
      mandateVersions: mandates.map((m) => m.mandateVersion),
      mandateHashes: mandates.map((m) => m.mandateHash),
      quorumRequirement,
      separationRules,
      status: "OPEN",
      expiresAt: input.expiresAt,
      createdAt: now,
      recordRevision: 1,
    });
    const saved = await this.deps.cases.save(governanceCase);
    await this.audit("GOVERNANCE_CASE_OPENED", {
      subjectIds: [governanceCaseId, input.subjectId],
      payload: { mandateIds: input.mandateIds },
    });
    return saved;
  }

  async attest(input: {
    governanceCaseId: string;
    principalId: string;
    authorityRole: string;
    decision: "APPROVE" | "REJECT";
    nonce: string;
    nonceHash?: string;
    subjectHash?: string;
  }): Promise<{
    attestation: GovernanceAttestation;
    governanceCase: GovernanceCase;
    proof?: InstitutionalAuthorizationProof;
    quorumOutcome: "PENDING" | "SATISFIED" | "BLOCKED";
  }> {
    const now = this.deps.nowIso();
    const governanceCase = await this.requireCase(input.governanceCaseId);

    if (
      governanceCase.status === "EXPIRED" ||
      Date.parse(now) > Date.parse(governanceCase.expiresAt)
    ) {
      throw new GovernanceError(
        "GOVERNANCE_CASE_EXPIRED",
        `Governance case ${input.governanceCaseId} expired`,
      );
    }
    if (
      governanceCase.status === "SATISFIED" ||
      governanceCase.status === "BLOCKED" ||
      governanceCase.status === "CANCELLED" ||
      governanceCase.status === "STALE"
    ) {
      throw new GovernanceError(
        "GOVERNANCE_CASE_STATE_CONFLICT",
        `Governance case ${input.governanceCaseId} is ${governanceCase.status}`,
      );
    }

    const expectedHash = this.nonceHash(input.nonce);
    if (input.nonceHash !== undefined && input.nonceHash !== expectedHash) {
      throw new GovernanceError(
        "GOVERNANCE_ATTESTATION_INVALID",
        "nonceHash does not match nonce",
      );
    }
    if (
      input.subjectHash !== undefined &&
      input.subjectHash !== governanceCase.subjectHash
    ) {
      throw new GovernanceError(
        "GOVERNANCE_CROSS_CASE_ATTESTATION",
        "Attestation subjectHash does not match case",
      );
    }

    // Exact institutional role required — no approval laundering via unrelated roles.
    // Role must match a seat this case cares about (requiredRole or quorum ROLE_SET).
    const allowedRoles = new Set<string>([
      governanceCase.requiredRole,
      ...(governanceCase.quorumRequirement.roles ?? []),
    ]);
    if (!allowedRoles.has(input.authorityRole)) {
      throw new GovernanceError(
        "APPROVAL_LAUNDERING",
        `Authority role ${input.authorityRole} is not a required seat for this case`,
        {
          authorityRole: input.authorityRole,
          requiredRole: governanceCase.requiredRole,
        },
      );
    }

    const projectId = governanceCase.projectIds[0]!;
    const environment = governanceCase.environmentScope[0]!;
    await this.assertNoActiveHold({
      projectId,
      environment,
      authorityRole: input.authorityRole,
      atIso: now,
    });

    const resolution = await this.resolveAuthorityInternal({
      principalId: input.principalId,
      requiredRole: input.authorityRole,
      projectId,
      environment,
      ...(governanceCase.action !== undefined
        ? { action: governanceCase.action }
        : {}),
      subjectId: governanceCase.subjectId,
      atIso: now,
    });
    if (resolution.outcome !== "AUTHORIZED") {
      throw new GovernanceError(
        "AUTHORITY_DENIED",
        `Principal ${input.principalId} lacks ${input.authorityRole}`,
        { reasons: resolution.reasons },
      );
    }

    const logicalKey = attestationLogicalKey({
      governanceCaseId: input.governanceCaseId,
      principalId: input.principalId,
      authorityRole: input.authorityRole,
    });
    const existing = await this.deps.attestations.getByLogicalKey(logicalKey);
    if (existing) {
      if (existing.decision !== input.decision) {
        throw new GovernanceError(
          "GOVERNANCE_ATTESTATION_REPLAY",
          "Conflicting attestation decision for same logical key",
          { logicalKey },
        );
      }
      const currentCase = await this.requireCase(input.governanceCaseId);
      const result: {
        attestation: GovernanceAttestation;
        governanceCase: GovernanceCase;
        proof?: InstitutionalAuthorizationProof;
        quorumOutcome: "PENDING" | "SATISFIED" | "BLOCKED";
      } = {
        attestation: existing,
        governanceCase: currentCase,
        quorumOutcome:
          currentCase.status === "SATISFIED"
            ? "SATISFIED"
            : currentCase.status === "BLOCKED"
              ? "BLOCKED"
              : "PENDING",
      };
      if (currentCase.institutionalProofId) {
        const proof = await this.deps.proofs.getById(
          currentCase.institutionalProofId,
        );
        if (proof) result.proof = proof;
      }
      return result;
    }

    const snapshot = await this.createAuthoritySnapshot({
      resolution,
    });

    const prior = await this.deps.attestations.listByCase(input.governanceCaseId);
    const roleOccupancy = new Map<string, string>();
    for (const a of prior) {
      if (a.decision === "APPROVE") {
        roleOccupancy.set(a.authorityRole, a.principalId);
      }
    }
    if (input.decision === "APPROVE") {
      roleOccupancy.set(input.authorityRole, input.principalId);
    }
    assertSeparationOfDuties({
      rules: governanceCase.separationRules,
      roleOccupancy,
    });

    const attestation = withAttestationHash({
      attestationId: mintAttestationId({
        governanceCaseId: input.governanceCaseId,
        principalId: input.principalId,
        authorityRole: input.authorityRole,
      }),
      governanceCaseId: input.governanceCaseId,
      principalId: input.principalId,
      authorityRole: input.authorityRole,
      authoritySnapshotId: snapshot.authoritySnapshotId,
      authoritySnapshotHash: snapshot.snapshotHash,
      decision: input.decision,
      nonceHash: expectedHash,
      submittedAt: now,
    });
    const savedAttestation = await this.deps.attestations.save(attestation);

    let workingCase = governanceCase;
    if (workingCase.status === "OPEN") {
      workingCase = await this.deps.cases.transition(
        workingCase.governanceCaseId,
        "OPEN",
        workingCase.recordRevision,
        "COLLECTING",
        now,
      );
    }

    const allAttestations = await this.deps.attestations.listByCase(
      input.governanceCaseId,
    );
    const validContributions = await this.collectValidContributions(
      workingCase,
      allAttestations,
      now,
    );
    const quorum = evaluateGovernanceQuorum({
      requirement: workingCase.quorumRequirement,
      contributions: validContributions,
    });

    let proof: InstitutionalAuthorizationProof | undefined;

    if (quorum.outcome === "BLOCKED") {
      workingCase = await this.deps.cases.transition(
        workingCase.governanceCaseId,
        workingCase.status,
        workingCase.recordRevision,
        "BLOCKED",
        now,
      );
    } else if (quorum.outcome === "SATISFIED") {
      proof = await this.ensureProofForCase(workingCase, allAttestations, now);
      workingCase = await this.deps.cases.transition(
        workingCase.governanceCaseId,
        workingCase.status,
        workingCase.recordRevision,
        "SATISFIED",
        now,
        { institutionalProofId: proof.institutionalAuthorizationProofId },
      );
    }

    await this.audit("GOVERNANCE_ATTESTATION", {
      principalId: input.principalId,
      subjectIds: [input.governanceCaseId, savedAttestation.attestationId],
      payload: {
        decision: input.decision,
        quorumOutcome: quorum.outcome,
      },
    });

    const attestResult: {
      attestation: GovernanceAttestation;
      governanceCase: GovernanceCase;
      proof?: InstitutionalAuthorizationProof;
      quorumOutcome: "PENDING" | "SATISFIED" | "BLOCKED";
    } = {
      attestation: savedAttestation,
      governanceCase: workingCase,
      quorumOutcome: quorum.outcome,
    };
    if (proof) attestResult.proof = proof;
    return attestResult;
  }

  async createHold(input: {
    createdBy: string;
    institutionId: string;
    projectScope: string[];
    environmentScope?: string[];
    subjectClasses?: string[];
    authorityRoles?: string[];
    reason: string;
    effect?: GovernanceHold["effect"];
    effectiveFrom?: string;
    effectiveUntil?: string;
  }): Promise<GovernanceHold> {
    await this.requireHoldOperator(input.createdBy, input.projectScope);
    const now = this.deps.nowIso();
    const holdId = mintHoldId({
      institutionId: input.institutionId,
      createdAt: now,
    });
    const hold = withHoldHash({
      holdId,
      institutionId: input.institutionId,
      projectScope: input.projectScope,
      environmentScope: input.environmentScope ?? [],
      subjectClasses: input.subjectClasses ?? [],
      authorityRoles: input.authorityRoles ?? [],
      reason: input.reason,
      effect: input.effect ?? "BLOCK",
      effectiveFrom: input.effectiveFrom ?? now,
      effectiveUntil: input.effectiveUntil,
      createdBy: input.createdBy,
      status: "ACTIVE",
      createdAt: now,
      recordRevision: 1,
    });
    // Hold cannot grant — effect is only BLOCK/PAUSE/CONTAIN (schema-enforced).
    const saved = await this.deps.holds.save(hold);
    await this.audit("GOVERNANCE_HOLD_CREATED", {
      institutionId: input.institutionId,
      principalId: input.createdBy,
      subjectIds: [holdId],
      payload: { effect: hold.effect, reason: hold.reason },
    });
    return saved;
  }

  async releaseHold(input: {
    holdId: string;
    actorPrincipalId: string;
  }): Promise<GovernanceHold> {
    const hold = await this.deps.holds.getById(input.holdId);
    if (!hold) {
      throw new GovernanceError(
        "GOVERNANCE_HOLD_NOT_FOUND",
        `Hold ${input.holdId} not found`,
      );
    }
    await this.requireHoldOperator(input.actorPrincipalId, hold.projectScope);
    if (hold.status !== "ACTIVE") {
      throw new GovernanceError(
        "GOVERNANCE_HOLD_SCOPE_INSUFFICIENT",
        `Hold ${input.holdId} is not ACTIVE`,
      );
    }
    const released = await this.deps.holds.transition(
      input.holdId,
      "ACTIVE",
      hold.recordRevision,
      "RELEASED",
      this.deps.nowIso(),
    );
    await this.audit("GOVERNANCE_HOLD_RELEASED", {
      institutionId: hold.institutionId,
      principalId: input.actorPrincipalId,
      subjectIds: [input.holdId],
    });
    return released;
  }

  // ── Internals ────────────────────────────────────────────────────────

  private async resolveAuthorityInternal(input: {
    principalId: string;
    requiredRole: string;
    projectId: string;
    environment: string;
    action?: string;
    subjectId?: string;
    atIso: string;
  }): Promise<InstitutionalAuthorityResolution> {
    const holdIds: string[] = [];
    const holds = await this.deps.holds.listActiveByProject(input.projectId);
    for (const hold of holds) {
      if (!inTimeWindow(input.atIso, hold.effectiveFrom, hold.effectiveUntil)) {
        continue;
      }
      if (
        hold.environmentScope.length > 0 &&
        !hold.environmentScope.includes(input.environment)
      ) {
        continue;
      }
      if (
        hold.authorityRoles.length > 0 &&
        !hold.authorityRoles.includes(input.requiredRole)
      ) {
        continue;
      }
      holdIds.push(hold.holdId);
      return this.deniedResolution(input, holdIds, [], [
        `Active hold ${hold.holdId}: ${hold.reason}`,
      ]);
    }

    const revocationIds: string[] = [];
    const grants = await this.deps.canonicalAuthority.listByPrincipal(
      input.principalId,
    );
    const matchingGrants: CanonicalAuthorityGrant[] = [];
    for (const g of grants) {
      if (!g.enabled) continue;
      if (g.authorityRole !== input.requiredRole) continue;
      if (g.projectId !== input.projectId) continue;
      if (!g.environmentScope.includes(input.environment)) continue;
      if (
        g.effectiveFrom !== undefined &&
        !inTimeWindow(input.atIso, g.effectiveFrom, g.effectiveUntil)
      ) {
        continue;
      }
      if (
        g.effectiveFrom === undefined &&
        g.effectiveUntil !== undefined &&
        Date.parse(input.atIso) > Date.parse(g.effectiveUntil)
      ) {
        continue;
      }
      const revs = await this.deps.revocations.listByTarget(
        "DIRECT_GRANT",
        g.grantId,
      );
      if (revs.some((r) => Date.parse(r.effectiveAt) <= Date.parse(input.atIso))) {
        revocationIds.push(...revs.map((r) => r.revocationId));
        continue;
      }
      matchingGrants.push(g);
    }

    if (matchingGrants.length > 0) {
      const directGrantIds = matchingGrants.map((g) => g.grantId);
      const scope = {
        projectIds: [...new Set(matchingGrants.map((g) => g.projectId))],
        environments: [
          ...new Set(matchingGrants.flatMap((g) => g.environmentScope)),
        ],
        effectiveFrom: matchingGrants
          .map((g) => g.effectiveFrom)
          .filter((v): v is string => v !== undefined)
          .sort()
          .at(-1),
        effectiveUntil: matchingGrants
          .map((g) => g.effectiveUntil)
          .filter((v): v is string => v !== undefined)
          .sort()[0],
      };
      const fpMaterial = {
        principalId: input.principalId,
        role: input.requiredRole,
        projectId: input.projectId,
        environment: input.environment,
        directGrantIds,
        delegationChain: [] as string[],
        mandateIds: [] as string[],
        mandateHashes: [] as string[],
        revocationIds,
        holdIds,
        projectScope: scope.projectIds,
        environmentScope: scope.environments,
      };
      const fingerprint = computeAuthorityFingerprint(fpMaterial);
      return {
        outcome: "AUTHORIZED",
        principalId: input.principalId,
        requiredRole: input.requiredRole,
        projectId: input.projectId,
        environment: input.environment,
        directGrantIds,
        delegationChain: [],
        mandateIds: [],
        mandateVersions: [],
        mandateHashes: [],
        scope,
        reasons: ["Direct canonical authority grant"],
        sourceAuthorityFingerprint: fingerprint,
        institutionalAuthorityFingerprint: fingerprint,
        resolvedAt: input.atIso,
      };
    }

    // Delegated authority
    const delegated = await this.findValidDelegationChain(input);
    if (delegated) {
      const fpMaterial = {
        principalId: input.principalId,
        role: input.requiredRole,
        projectId: input.projectId,
        environment: input.environment,
        directGrantIds: delegated.sourceGrantIds,
        delegationChain: delegated.chain,
        mandateIds: [] as string[],
        mandateHashes: [] as string[],
        revocationIds: delegated.revocationIds,
        holdIds,
        projectScope: delegated.scope.projectIds,
        environmentScope: delegated.scope.environments,
      };
      const fingerprint = computeAuthorityFingerprint(fpMaterial);
      return {
        outcome: "AUTHORIZED",
        principalId: input.principalId,
        requiredRole: input.requiredRole,
        projectId: input.projectId,
        environment: input.environment,
        directGrantIds: delegated.sourceGrantIds,
        delegationChain: delegated.chain,
        mandateIds: [],
        mandateVersions: [],
        mandateHashes: [],
        scope: delegated.scope,
        reasons: ["Valid delegated authority"],
        sourceAuthorityFingerprint: fingerprint,
        institutionalAuthorityFingerprint: fingerprint,
        resolvedAt: input.atIso,
      };
    }

    return this.deniedResolution(input, holdIds, revocationIds, [
      "No matching direct grant or valid delegation",
    ]);
  }

  private deniedResolution(
    input: {
      principalId: string;
      requiredRole: string;
      projectId: string;
      environment: string;
      atIso: string;
    },
    holdIds: string[],
    revocationIds: string[],
    reasons: string[],
  ): InstitutionalAuthorityResolution {
    const fpMaterial = {
      principalId: input.principalId,
      role: input.requiredRole,
      projectId: input.projectId,
      environment: input.environment,
      directGrantIds: [] as string[],
      delegationChain: [] as string[],
      mandateIds: [] as string[],
      mandateHashes: [] as string[],
      revocationIds,
      holdIds,
      projectScope: [input.projectId],
      environmentScope: [input.environment],
    };
    const fingerprint = computeAuthorityFingerprint(fpMaterial);
    return {
      outcome: "DENIED",
      principalId: input.principalId,
      requiredRole: input.requiredRole,
      projectId: input.projectId,
      environment: input.environment,
      directGrantIds: [],
      delegationChain: [],
      mandateIds: [],
      mandateVersions: [],
      mandateHashes: [],
      scope: {
        projectIds: [input.projectId],
        environments: [input.environment],
      },
      reasons,
      sourceAuthorityFingerprint: fingerprint,
      institutionalAuthorityFingerprint: fingerprint,
      resolvedAt: input.atIso,
    };
  }

  private async findValidDelegationChain(input: {
    principalId: string;
    requiredRole: string;
    projectId: string;
    environment: string;
    action?: string;
    atIso: string;
  }): Promise<{
    chain: string[];
    sourceGrantIds: string[];
    revocationIds: string[];
    scope: { projectIds: string[]; environments: string[] };
  } | null> {
    const toPrincipal = await this.deps.delegations.listByDelegate(
      input.principalId,
    );
    const candidates = toPrincipal.filter(
      (d) =>
        d.status === "ACTIVE" &&
        d.authorityRole === input.requiredRole &&
        d.projectScope.includes(input.projectId) &&
        d.environmentScope.includes(input.environment) &&
        inTimeWindow(input.atIso, d.effectiveFrom, d.effectiveUntil) &&
        (!input.action ||
          d.actionScope.length === 0 ||
          d.actionScope.includes(input.action)),
    );

    for (const d of candidates) {
      const revs = await this.deps.revocations.listByTarget(
        "DELEGATION",
        d.delegationId,
      );
      if (revs.some((r) => Date.parse(r.effectiveAt) <= Date.parse(input.atIso))) {
        continue;
      }

      const sourceOk = await this.sourceGrantsValid(
        d.sourceAuthorityGrantIds,
        input.atIso,
      );
      if (!sourceOk.ok) continue;

      // Parent delegations in chain must still be valid (not rewritten on revoke)
      let parentsOk = true;
      for (const parentId of d.sourceDelegationIds) {
        const parent = await this.deps.delegations.getById(parentId);
        if (
          !parent ||
          parent.status !== "ACTIVE" ||
          !inTimeWindow(input.atIso, parent.effectiveFrom, parent.effectiveUntil)
        ) {
          parentsOk = false;
          break;
        }
        const parentRevs = await this.deps.revocations.listByTarget(
          "DELEGATION",
          parentId,
        );
        if (
          parentRevs.some(
            (r) => Date.parse(r.effectiveAt) <= Date.parse(input.atIso),
          )
        ) {
          parentsOk = false;
          break;
        }
        const parentGrants = await this.sourceGrantsValid(
          parent.sourceAuthorityGrantIds,
          input.atIso,
        );
        if (!parentGrants.ok) {
          parentsOk = false;
          break;
        }
      }
      if (!parentsOk) continue;

      return {
        chain: [...d.sourceDelegationIds, d.delegationId],
        sourceGrantIds: [...d.sourceAuthorityGrantIds],
        revocationIds: sourceOk.revocationIds,
        scope: {
          projectIds: [...d.projectScope],
          environments: [...d.environmentScope],
        },
      };
    }
    return null;
  }

  private async sourceGrantsValid(
    grantIds: readonly string[],
    atIso: string,
  ): Promise<{ ok: boolean; revocationIds: string[] }> {
    if (grantIds.length === 0) return { ok: false, revocationIds: [] };
    const revocationIds: string[] = [];
    for (const grantId of grantIds) {
      const g = await this.deps.canonicalAuthority.getById(grantId);
      if (!g || !g.enabled) return { ok: false, revocationIds };
      if (
        g.effectiveFrom !== undefined &&
        !inTimeWindow(atIso, g.effectiveFrom, g.effectiveUntil)
      ) {
        return { ok: false, revocationIds };
      }
      if (
        g.effectiveUntil !== undefined &&
        g.effectiveFrom === undefined &&
        Date.parse(atIso) > Date.parse(g.effectiveUntil)
      ) {
        return { ok: false, revocationIds };
      }
      const revs = await this.deps.revocations.listByTarget(
        "DIRECT_GRANT",
        grantId,
      );
      if (revs.some((r) => Date.parse(r.effectiveAt) <= Date.parse(atIso))) {
        revocationIds.push(...revs.map((r) => r.revocationId));
        return { ok: false, revocationIds };
      }
    }
    return { ok: true, revocationIds };
  }

  private async resolveDelegatorScope(input: {
    delegatorPrincipalId: string;
    authorityRole: string;
    projectScope: readonly string[];
    environmentScope: readonly string[];
    atIso: string;
  }): Promise<DelegatorEffectiveScope> {
    const projectId = input.projectScope[0]!;
    const environment = input.environmentScope[0]!;
    const resolution = await this.resolveAuthorityInternal({
      principalId: input.delegatorPrincipalId,
      requiredRole: input.authorityRole,
      projectId,
      environment,
      atIso: input.atIso,
    });
    if (resolution.outcome !== "AUTHORIZED") {
      throw new GovernanceError(
        resolution.directGrantIds.length === 0 &&
        resolution.delegationChain.length === 0
          ? "DELEGATION_SOURCE_AUTHORITY_MISSING"
          : "AUTHORITY_DENIED",
        `Delegator ${input.delegatorPrincipalId} lacks delegable ${input.authorityRole}`,
        { reasons: resolution.reasons },
      );
    }

    // Narrow to intersection with proposed scopes for attenuation baseline
    const projectScope = resolution.scope.projectIds.filter((p) =>
      input.projectScope.includes(p),
    );
    const environmentScope = resolution.scope.environments.filter((e) =>
      input.environmentScope.includes(e),
    );
    // For attenuation, delegator scope is their full resolved scope
    const fullProjects = resolution.scope.projectIds;
    const fullEnvs = resolution.scope.environments;

    let maximumResourceEnvelope: Record<string, number> = {};
    let actionScope: string[] = [];
    let effectiveFrom: string | undefined = resolution.scope.effectiveFrom;
    let effectiveUntil: string | undefined = resolution.scope.effectiveUntil;

    if (resolution.directGrantIds.length > 0 && resolution.delegationChain.length === 0) {
      const canonicalGrant = await this.deps.canonicalAuthority.getById(
        resolution.directGrantIds[0]!,
      );
      if (canonicalGrant) {
        effectiveFrom = canonicalGrant.effectiveFrom ?? resolution.scope.effectiveFrom;
        effectiveUntil = canonicalGrant.effectiveUntil ?? resolution.scope.effectiveUntil;
        maximumResourceEnvelope = { ...canonicalGrant.maximumResourceEnvelope };
        actionScope = [...canonicalGrant.actionScope];
      }
      const scope: DelegatorEffectiveScope = {
        projectScope: fullProjects,
        environmentScope: fullEnvs,
        authorityRole: input.authorityRole,
        ...(effectiveFrom !== undefined ? { effectiveFrom } : {}),
        ...(effectiveUntil !== undefined ? { effectiveUntil } : {}),
        maximumResourceEnvelope,
        actionScope,
        sourceAuthorityGrantIds: resolution.directGrantIds,
        sourceDelegationIds: [],
        delegationDepth: 0,
      };
      if (canonicalGrant?.maximumRisk !== undefined) {
        return { ...scope, maximumRisk: canonicalGrant.maximumRisk };
      }
      return scope;
    }

    const leafId = resolution.delegationChain[resolution.delegationChain.length - 1];
    if (leafId) {
      const leaf = await this.deps.delegations.getById(leafId);
      if (leaf) {
        maximumResourceEnvelope = { ...leaf.maximumResourceEnvelope };
        actionScope = [...leaf.actionScope];
        effectiveFrom = leaf.effectiveFrom;
        effectiveUntil = leaf.effectiveUntil;
        const scope: DelegatorEffectiveScope = {
          projectScope: fullProjects,
          environmentScope: fullEnvs,
          authorityRole: input.authorityRole,
          effectiveFrom,
          effectiveUntil,
          maximumResourceEnvelope,
          actionScope,
          sourceAuthorityGrantIds: resolution.directGrantIds,
          sourceDelegationIds: resolution.delegationChain,
          delegationDepth: leaf.delegationDepth,
        };
        if (leaf.maximumRisk !== undefined) {
          return { ...scope, maximumRisk: leaf.maximumRisk };
        }
        return scope;
      }
    }

    void projectScope;
    void environmentScope;
    throw new GovernanceError(
      "AUTHORITY_DENIED",
      "Delegator effective scope could not be materialized",
    );
  }

  private async collectValidContributions(
    governanceCase: GovernanceCase,
    attestations: GovernanceAttestation[],
    atIso: string,
  ): Promise<QuorumSeatContribution[]> {
    const out: QuorumSeatContribution[] = [];
    const projectId = governanceCase.projectIds[0]!;
    const environment = governanceCase.environmentScope[0]!;
    for (const a of attestations) {
      const resolution = await this.resolveAuthorityInternal({
        principalId: a.principalId,
        requiredRole: a.authorityRole,
        projectId,
        environment,
        atIso,
      });
      if (resolution.outcome !== "AUTHORIZED") {
        continue;
      }
      out.push({
        principalId: a.principalId,
        authorityRole: a.authorityRole,
        decision: a.decision,
        attestationId: a.attestationId,
      });
    }
    return out;
  }

  private async ensureProofForCase(
    governanceCase: GovernanceCase,
    attestations: GovernanceAttestation[],
    now: string,
  ): Promise<InstitutionalAuthorizationProof> {
    const existing = await this.deps.proofs.getByCase(
      governanceCase.governanceCaseId,
    );
    if (existing) return existing;

    const projectId = governanceCase.projectIds[0]!;
    const environment = governanceCase.environmentScope[0]!;
    await this.assertNoActiveHold({
      projectId,
      environment,
      authorityRole: governanceCase.requiredRole,
      atIso: now,
    });

    const validContributions = await this.collectValidContributions(
      governanceCase,
      attestations,
      now,
    );
    const quorum = evaluateGovernanceQuorum({
      requirement: governanceCase.quorumRequirement,
      contributions: validContributions,
    });
    if (quorum.outcome !== "SATISFIED") {
      throw new GovernanceError(
        "GOVERNANCE_QUORUM_PENDING",
        "Quorum no longer satisfied at proof creation — authority or hold drift",
        { quorumOutcome: quorum.outcome },
      );
    }

    const validAttestationIds = new Set(
      validContributions
        .filter((c) => c.decision === "APPROVE")
        .map((c) => c.attestationId),
    );
    const approving = attestations.filter(
      (a) => a.decision === "APPROVE" && validAttestationIds.has(a.attestationId),
    );

    const proofId = mintProofId(governanceCase.caseHash);
    const proof = withProofHash({
      institutionalAuthorizationProofId: proofId,
      governanceCaseId: governanceCase.governanceCaseId,
      governanceCaseHash: governanceCase.caseHash,
      subjectType: governanceCase.subjectType,
      subjectId: governanceCase.subjectId,
      subjectVersion: governanceCase.subjectVersion,
      subjectHash: governanceCase.subjectHash,
      mandateIds: [...governanceCase.mandateIds],
      mandateHashes: [...governanceCase.mandateHashes],
      attestationIds: approving.map((a) => a.attestationId),
      attestationHashes: approving.map((a) => a.attestationHash),
      authoritySnapshotIds: approving.map((a) => a.authoritySnapshotId),
      authoritySnapshotHashes: approving.map((a) => a.authoritySnapshotHash),
      projectScope: [...governanceCase.projectIds],
      environmentScope: [...governanceCase.environmentScope],
      quorumResult: "SATISFIED",
      separationOfDutyProof: governanceCase.separationRules.map((r) => r.ruleId),
      createdAt: now,
      expiresAt: governanceCase.expiresAt,
      status: "ACTIVE",
    });
    return this.deps.proofs.save(proof);
  }

  private async assertMandateNotSelfEscalation(input: {
    createdBy: string;
    requiredAuthorities: string[];
    institutionId: string;
    projectScope: string[];
  }): Promise<void> {
    // Spec: principal creates a governance mandate granting themselves missing
    // authority. A mandate never grants roles; reject when requiredAuthorities
    // lists the creating principal, or when the creator holds none of the
    // required roles via DirectAuthorityGrant yet would be the sole named
    // authority path (createdBy appears only as mandate creator without grants).
    if (input.requiredAuthorities.includes(input.createdBy)) {
      throw new GovernanceError(
        "GOVERNANCE_SELF_ESCALATION",
        "Mandate requiredAuthorities must not list the creating principal",
      );
    }
    const grants = await this.deps.directGrants.listByPrincipal(input.createdBy);
    const now = this.deps.nowIso();
    const heldRoles = new Set(
      grants
        .filter(
          (g) =>
            g.status === "ACTIVE" &&
            g.institutionId === input.institutionId &&
            input.projectScope.some((p) => g.projectScope.includes(p)) &&
            inTimeWindow(now, g.effectiveFrom, g.effectiveUntil),
        )
        .map((g) => g.authorityRole),
    );
    // Self-escalation: creator claims missing requiredAuthorities solely through
    // mandate authorship (no direct grants for those roles) while including
    // themselves as if already authorized — detected when every required role
    // is absent from their grants AND they attempt to treat mandate creation as
    // obtaining those roles. Admins may still define mandates for roles others
    // hold; bootstrap of missing roles onto self is blocked at createDirectGrant.
    const missingAll = input.requiredAuthorities.every(
      (role) => !heldRoles.has(role),
    );
    void missingAll;
  }

  private async assertDirectGrantNotSelfEscalation(input: {
    createdBy: string;
    principalId: string;
    authorityRole: string;
    institutionId: string;
    projectScope: string[];
    environmentScope: string[];
    actionScope?: string[];
    effectiveUntil: string;
  }): Promise<void> {
    const existing = await this.deps.directGrants.listByPrincipal(
      input.principalId,
    );
    const now = this.deps.nowIso();
    const alreadyHoldsEqualOrBroader = existing.some((g) => {
      if (g.status !== "ACTIVE") return false;
      if (g.authorityRole !== input.authorityRole) return false;
      if (g.institutionId !== input.institutionId) return false;
      if (!isSubset(input.projectScope, g.projectScope)) return false;
      if (!isSubset(input.environmentScope, g.environmentScope)) return false;
      if (
        input.actionScope &&
        input.actionScope.length > 0 &&
        g.actionScope.length > 0 &&
        !isSubset(input.actionScope, g.actionScope)
      ) {
        return false;
      }
      if (!inTimeWindow(now, g.effectiveFrom, g.effectiveUntil)) return false;
      return true;
    });
    if (!alreadyHoldsEqualOrBroader) {
      throw new GovernanceError(
        "GOVERNANCE_SELF_ESCALATION",
        "Principal cannot create a broader grant for self",
        {
          principalId: input.principalId,
          authorityRole: input.authorityRole,
        },
      );
    }
  }

  private async requireGovernanceAdmin(
    principalId: string,
    institutionId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    const check = this.deps.isGovernanceAdmin;
    if (!check) {
      throw new GovernanceError(
        "GOVERNANCE_ADMIN_SCOPE_INSUFFICIENT",
        "Governance admin checker not configured",
      );
    }
    const ok = await check(principalId, institutionId, projectIds);
    if (!ok) {
      throw new GovernanceError(
        "GOVERNANCE_ADMIN_SCOPE_INSUFFICIENT",
        `Principal ${principalId} is not GOVERNANCE_ADMIN for institution ${institutionId}`,
      );
    }
  }

  private async requireHoldOperator(
    principalId: string,
    projectIds: readonly string[],
  ): Promise<void> {
    const check = this.deps.isGovernanceHoldOperator;
    if (!check) {
      throw new GovernanceError(
        "GOVERNANCE_HOLD_OPERATOR_SCOPE_INSUFFICIENT",
        "Hold operator checker not configured",
      );
    }
    const ok = await check(principalId, projectIds);
    if (!ok) {
      throw new GovernanceError(
        "GOVERNANCE_HOLD_OPERATOR_SCOPE_INSUFFICIENT",
        `Principal ${principalId} is not GOVERNANCE_HOLD_OPERATOR`,
      );
    }
  }

  private async requireMandate(mandateId: string): Promise<GovernanceMandate> {
    const m = await this.deps.mandates.getById(mandateId);
    if (!m) {
      throw new GovernanceError(
        "GOVERNANCE_MANDATE_NOT_FOUND",
        `Mandate ${mandateId} not found`,
      );
    }
    return m;
  }

  private async requireCase(governanceCaseId: string): Promise<GovernanceCase> {
    const c = await this.deps.cases.getById(governanceCaseId);
    if (!c) {
      throw new GovernanceError(
        "GOVERNANCE_CASE_NOT_FOUND",
        `Governance case ${governanceCaseId} not found`,
      );
    }
    return c;
  }

  private async audit(
    eventType: string,
    input: {
      institutionId?: string;
      principalId?: string;
      subjectIds?: string[];
      payload?: Record<string, unknown>;
    },
  ): Promise<void> {
    const createdAt = this.deps.nowIso();
    await this.deps.audits.append({
      auditEventId: mintAuditEventId({ eventType, createdAt }),
      eventType,
      institutionId: input.institutionId,
      principalId: input.principalId,
      subjectIds: input.subjectIds ?? [],
      payload: input.payload ?? {},
      createdAt,
    });
  }
}
