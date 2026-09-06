import { createHash, randomUUID } from "node:crypto";
import { ConstitutionalError, isConstitutionalError } from "./errors.js";
import type { ConstitutionalChangeOperation } from "./operations.js";
import {
  computeGovernanceStateFingerprint,
  selectConstitutionalRoleGrants,
} from "./fingerprint.js";
import {
  analyzeConstitutionalImpact,
  type ConstitutionalImpactAnalysis,
} from "./impact-analysis.js";
import {
  computeProposalHash,
  isProposalMaterialImmutable,
  mintProposalId,
  withProposalHash,
  type ConstitutionalChangeProposal,
} from "./proposal.js";
import { assertConstitutionalSafetyFloor } from "./safety-floor.js";
import {
  compileActivationSubjectBinding,
  compileReviewSubjectBinding,
  mintReviewDecisionId,
  withReviewDecisionHash,
  type ConstitutionalReviewDecision,
} from "./review.js";
import {
  mintActivationRecordId,
  mintActivationIdempotencyKey,
  withActivationRecordHash,
  type ConstitutionalActivationRecord,
} from "./activation.js";
import { ConstitutionalActivationCapability } from "./activation-capability.js";
import { authorizedProtectedMutationsForOperations } from "./protected-mutations.js";
import type { GovernanceOrchestrationService } from "../governance/service.js";
import type { GovernanceMandate } from "../governance/mandate.js";
import type { Institution } from "../governance/institution.js";
import type { CanonicalAuthorityGrantPort } from "../governance/canonical-authority.js";
import type {
  ConstitutionalProposalRepository,
  ConstitutionalImpactAnalysisRepository,
  ConstitutionalReviewDecisionRepository,
  ConstitutionalActivationRecordRepository,
  ConstitutionalAuditRepository,
} from "./repositories.js";
import {
  assertAllOperationsExecutable,
  compileConstitutionalMutationPlan,
} from "./mutation-plan.js";
import { assertProjectedGovernanceContinuity } from "./continuity.js";
import { applyConstitutionalMutationPlan } from "./apply-mutations.js";
import { assertSeparationOfDuties } from "../governance/separation.js";

export interface ConstitutionalChangeOrchestrationDeps {
  nowIso: () => string;
  proposals: ConstitutionalProposalRepository;
  impactAnalyses: ConstitutionalImpactAnalysisRepository;
  reviewDecisions: ConstitutionalReviewDecisionRepository;
  activationRecords: ConstitutionalActivationRecordRepository;
  audits: ConstitutionalAuditRepository;
  governance: GovernanceOrchestrationService;
  canonicalAuthority: CanonicalAuthorityGrantPort;
  isGovernanceAdmin?: (
    principalId: string,
    institutionId: string,
    projectIds: readonly string[],
  ) => Promise<boolean>;
  /**
   * Serializes constitutional activation per institution.
   * Must recompute fingerprint inside the lock/transaction.
   */
  runInstitutionActivation?: <T>(
    institutionId: string,
    fn: () => Promise<T>,
  ) => Promise<T>;
  withTransaction?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Test-only: throws after material governance writes, before activation record. */
  activationFailpoint?: { name: string; trigger: () => void };
}

export class ConstitutionalChangeOrchestrationService {
  constructor(private readonly deps: ConstitutionalChangeOrchestrationDeps) {}

  async createProposal(input: {
    institutionId: string;
    title: string;
    rationale: string;
    changeOperations: ConstitutionalChangeOperation[];
    riskClass: ConstitutionalChangeProposal["riskClass"];
    proposedByPrincipalId: string;
    expiresAt?: string;
  }): Promise<ConstitutionalChangeProposal> {
    assertAllOperationsExecutable(input.changeOperations);
    const institution = await this.requireInstitution(input.institutionId);
    await this.requireGovernanceAdmin(
      input.proposedByPrincipalId,
      institution,
    );

    const now = this.deps.nowIso();
    const fingerprint = await this.computeCurrentFingerprint(institution);
    const proposalId = mintProposalId({
      institutionId: input.institutionId,
      createdAt: now,
      title: input.title,
    });

    const draft = withProposalHash({
      constitutionalChangeProposalId: proposalId,
      institutionId: input.institutionId,
      proposalVersion: 1,
      title: input.title,
      rationale: input.rationale,
      changeOperations: input.changeOperations,
      riskClass: input.riskClass,
      proposedByPrincipalId: input.proposedByPrincipalId,
      baseGovernanceFingerprint: fingerprint,
      status: "DRAFT",
      createdAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      recordRevision: 1,
    });

    const saved = await this.deps.proposals.save(draft);
    await this.audit("PROPOSAL_CREATED", institution.institutionId, proposalId, {
      status: "DRAFT",
    });
    return saved;
  }

  async getProposal(
    proposalId: string,
  ): Promise<ConstitutionalChangeProposal> {
    return this.requireProposal(proposalId);
  }

  async submitProposal(input: {
    proposalId: string;
    actorPrincipalId: string;
  }): Promise<ConstitutionalChangeProposal> {
    const proposal = await this.requireProposal(input.proposalId);
    const institution = await this.requireInstitution(proposal.institutionId);
    await this.requireGovernanceAdmin(input.actorPrincipalId, institution);

    if (proposal.status !== "DRAFT") {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROPOSAL_STATE_CONFLICT",
        `Proposal ${input.proposalId} cannot submit from ${proposal.status}`,
      );
    }

    assertConstitutionalSafetyFloor(proposal.changeOperations);
    assertAllOperationsExecutable(proposal.changeOperations);
    await this.assertFingerprintFresh(proposal, institution);

    const submitted = await this.deps.proposals.transition(
      input.proposalId,
      "DRAFT",
      proposal.recordRevision,
      "SUBMITTED",
      this.deps.nowIso(),
      { submittedAt: this.deps.nowIso() },
    );
    await this.audit(
      "PROPOSAL_SUBMITTED",
      institution.institutionId,
      proposal.constitutionalChangeProposalId,
      {},
    );
    return submitted;
  }

  async analyzeProposal(input: {
    proposalId: string;
    actorPrincipalId: string;
  }): Promise<ConstitutionalImpactAnalysis> {
    const proposal = await this.requireProposal(input.proposalId);
    const institution = await this.requireInstitution(proposal.institutionId);
    await this.requireGovernanceAdmin(input.actorPrincipalId, institution);

    if (proposal.status !== "SUBMITTED" && proposal.status !== "VALIDATED") {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROPOSAL_STATE_CONFLICT",
        `Proposal ${input.proposalId} cannot analyze from ${proposal.status}`,
      );
    }

    const mandates = await this.listMandatesForInstitution(institution);
    const now = this.deps.nowIso();
    const analysis = analyzeConstitutionalImpact({
      operations: proposal.changeOperations,
      currentMandates: mandates,
      proposalId: proposal.constitutionalChangeProposalId,
      proposalHash: proposal.proposalHash,
      proposalVersion: proposal.proposalVersion,
      baseGovernanceFingerprint: proposal.baseGovernanceFingerprint,
      createdAt: now,
    });

    assertConstitutionalSafetyFloor(proposal.changeOperations);
    const saved = await this.deps.impactAnalyses.save(analysis);
    if (proposal.status === "SUBMITTED") {
      await this.deps.proposals.transition(
        input.proposalId,
        "SUBMITTED",
        proposal.recordRevision,
        "VALIDATED",
        now,
      );
    }
    await this.audit(
      "IMPACT_ANALYZED",
      institution.institutionId,
      proposal.constitutionalChangeProposalId,
      { classification: analysis.overallClassification },
    );
    return saved;
  }

  async recordReviewDecision(input: {
    proposalId: string;
    reviewerPrincipalId: string;
    institutionalAuthorizationProofId: string;
    decision: "APPROVE" | "REJECT";
    reason?: string;
    projectId: string;
    environment: string;
    atIso?: string;
  }): Promise<ConstitutionalReviewDecision> {
    const proposal = await this.requireProposal(input.proposalId);
    const institution = await this.requireInstitution(proposal.institutionId);
    const atIso = input.atIso ?? this.deps.nowIso();

    if (
      proposal.status !== "VALIDATED" &&
      proposal.status !== "AWAITING_REVIEW" &&
      proposal.status !== "AUTHORIZED"
    ) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROPOSAL_STATE_CONFLICT",
        `Proposal ${input.proposalId} cannot review from ${proposal.status}`,
      );
    }

    const analysis = await this.deps.impactAnalyses.getLatestByProposal(
      input.proposalId,
    );
    if (!analysis) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_IMPACT_ANALYSIS_REQUIRED",
        "Impact analysis required before review",
      );
    }

    await this.validateReviewProof(proposal, input, atIso);
    await this.assertPreChangeSeparation(proposal, input.reviewerPrincipalId);
    this.assertSelfEscalationBlocked({
      proposal,
      analysis,
      actorPrincipalId: input.reviewerPrincipalId,
      role: "REVIEWER",
    });

    if (analysis.relaxationDetected) {
      if (input.reviewerPrincipalId === proposal.proposedByPrincipalId) {
        throw new ConstitutionalError(
          "CONSTITUTIONAL_SELF_ESCALATION",
          "Proposer cannot review relaxing constitutional change",
        );
      }
    }

    const now = this.deps.nowIso();
    const decision = withReviewDecisionHash({
      decisionId: mintReviewDecisionId({
        proposalId: proposal.constitutionalChangeProposalId,
        reviewerPrincipalId: input.reviewerPrincipalId,
        createdAt: now,
      }),
      proposalId: proposal.constitutionalChangeProposalId,
      proposalHash: proposal.proposalHash,
      proposalVersion: proposal.proposalVersion,
      baseGovernanceFingerprint: proposal.baseGovernanceFingerprint,
      reviewerPrincipalId: input.reviewerPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      decision: input.decision,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      createdAt: now,
    });

    const saved = await this.deps.reviewDecisions.save(decision);

    if (input.decision === "REJECT") {
      await this.deps.proposals.transition(
        input.proposalId,
        proposal.status,
        proposal.recordRevision,
        "REJECTED",
        now,
      );
      return saved;
    }

    const approvals = (
      await this.deps.reviewDecisions.listByProposal(input.proposalId)
    ).filter((d) => d.decision === "APPROVE");
    const requiredApprovals = this.requiredReviewApprovals(
      await this.listConstitutionalReviewMandates(institution),
    );

    if (approvals.length < requiredApprovals) {
      if (proposal.status === "VALIDATED") {
        await this.deps.proposals.transition(
          input.proposalId,
          "VALIDATED",
          proposal.recordRevision,
          "AWAITING_REVIEW",
          now,
        );
      }
      return saved;
    }

    if (proposal.status !== "AUTHORIZED") {
      await this.deps.proposals.transition(
        input.proposalId,
        proposal.status,
        proposal.recordRevision,
        "AUTHORIZED",
        now,
      );
    }
    return saved;
  }

  async stageActivation(input: {
    proposalId: string;
    activatorPrincipalId: string;
    institutionalAuthorizationProofId: string;
    reviewDecisionId: string;
    effectiveAt?: string;
    projectId: string;
    environment: string;
    atIso?: string;
  }): Promise<ConstitutionalActivationRecord> {
    const proposal = await this.requireProposal(input.proposalId);
    const institution = await this.requireInstitution(proposal.institutionId);
    const atIso = input.atIso ?? this.deps.nowIso();

    if (proposal.status !== "AUTHORIZED") {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ACTIVATION_REQUIRED",
        `Proposal must be AUTHORIZED (have ${proposal.status})`,
      );
    }

    const review = await this.requireApprovedReview(input, proposal);
    await this.validateReviewProofFresh(review, proposal, input, atIso);

    const analysis = await this.requireImpactAnalysis(input.proposalId);
    await this.validateActivationProof(proposal, input, atIso);
    this.assertSelfEscalationBlocked({
      proposal,
      analysis,
      actorPrincipalId: input.activatorPrincipalId,
      role: "ACTIVATOR",
    });
    if (
      analysis.relaxationDetected &&
      (input.activatorPrincipalId === review.reviewerPrincipalId ||
        input.activatorPrincipalId === proposal.proposedByPrincipalId)
    ) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_SEPARATION_VIOLATION",
        "Relaxing change requires distinct proposer/reviewer/activator",
      );
    }

    await this.preflightActivation(proposal, institution);

    const effectiveAt = input.effectiveAt ?? this.deps.nowIso();
    const now = this.deps.nowIso();
    const record = withActivationRecordHash({
      activationRecordId: mintActivationRecordId({
        proposalId: proposal.constitutionalChangeProposalId,
        effectiveAt,
      }),
      proposalId: proposal.constitutionalChangeProposalId,
      proposalHash: proposal.proposalHash,
      proposalVersion: proposal.proposalVersion,
      baseGovernanceFingerprint: proposal.baseGovernanceFingerprint,
      targetGovernanceFingerprint: proposal.baseGovernanceFingerprint,
      reviewDecisionId: review.decisionId,
      activatorPrincipalId: input.activatorPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      effectiveAt,
      status: "STAGED",
      createdAt: now,
      recordRevision: 1,
    });

    const saved = await this.deps.activationRecords.save(record);
    await this.deps.proposals.transition(
      input.proposalId,
      "AUTHORIZED",
      proposal.recordRevision,
      "STAGED",
      now,
    );
    return saved;
  }

  async activate(input: {
    proposalId: string;
    activatorPrincipalId: string;
    activationRecordId: string;
    institutionalAuthorizationProofId: string;
    reviewDecisionId: string;
    projectId: string;
    environment: string;
    atIso?: string;
  }): Promise<{
    record: ConstitutionalActivationRecord;
    capability: ConstitutionalActivationCapability;
  }> {
    const run = () => this.activateInternal(input);
    try {
      if (this.deps.runInstitutionActivation) {
        const proposal = await this.requireProposal(input.proposalId);
        return await this.deps.runInstitutionActivation(
          proposal.institutionId,
          run,
        );
      }
      if (this.deps.withTransaction) {
        return await this.deps.withTransaction(run);
      }
      return await run();
    } catch (error) {
      if (
        isConstitutionalError(error) &&
        error.code === "CONSTITUTIONAL_BASE_STATE_STALE"
      ) {
        const proposal = await this.requireProposal(input.proposalId);
        const institution = await this.requireInstitution(proposal.institutionId);
        await this.persistStaleProposalIfDrifted(proposal, institution);
      }
      throw error;
    }
  }

  private async activateInternal(input: {
    proposalId: string;
    activatorPrincipalId: string;
    activationRecordId: string;
    institutionalAuthorizationProofId: string;
    reviewDecisionId: string;
    projectId: string;
    environment: string;
    atIso?: string;
  }): Promise<{
    record: ConstitutionalActivationRecord;
    capability: ConstitutionalActivationCapability;
  }> {
    const proposal = await this.requireProposal(input.proposalId);
    const institution = await this.requireInstitution(proposal.institutionId);
    const atIso = input.atIso ?? this.deps.nowIso();

    const idempotencyKey = mintActivationIdempotencyKey({
      proposalId: proposal.constitutionalChangeProposalId,
      proposalVersion: proposal.proposalVersion,
      proposalHash: proposal.proposalHash,
    });
    const existingByKey =
      await this.deps.activationRecords.getByIdempotencyKey(idempotencyKey);
    if (existingByKey?.status === "ACTIVATED") {
      const plan = compileConstitutionalMutationPlan({ proposal });
      return {
        record: existingByKey,
        capability: ConstitutionalActivationCapability.mint({
          proposalId: proposal.constitutionalChangeProposalId,
          proposalHash: proposal.proposalHash,
          proposalVersion: proposal.proposalVersion,
          activationRecordId: existingByKey.activationRecordId,
          baseGovernanceFingerprint: existingByKey.baseGovernanceFingerprint,
          institutionId: institution.institutionId,
          activatedByPrincipalId: existingByKey.activatorPrincipalId,
          mutationPlanHash: plan.planHash,
          authorizedProtectedMutations: authorizedProtectedMutationsForOperations(
            plan.operations,
          ),
        }),
      };
    }
    if (
      existingByKey &&
      (existingByKey.proposalHash !== proposal.proposalHash ||
        existingByKey.proposalVersion !== proposal.proposalVersion)
    ) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ACTIVATION_CONFLICT",
        "Conflicting activation identity for proposal",
      );
    }

    if (proposal.status !== "STAGED" && proposal.status !== "ACTIVATED") {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ACTIVATION_REQUIRED",
        `Proposal must be STAGED (have ${proposal.status})`,
      );
    }

    const staged = await this.deps.activationRecords.getById(
      input.activationRecordId,
    );
    if (!staged || staged.proposalId !== proposal.constitutionalChangeProposalId) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ACTIVATION_REQUIRED",
        "Activation record not found",
      );
    }
    if (
      staged.proposalHash !== proposal.proposalHash ||
      staged.proposalVersion !== proposal.proposalVersion ||
      staged.baseGovernanceFingerprint !== proposal.baseGovernanceFingerprint
    ) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ACTIVATION_CONFLICT",
        "Activation record material identity does not match proposal",
      );
    }

    const review = await this.requireApprovedReview(input, proposal);
    await this.validateReviewProofFresh(review, proposal, input, atIso);
    await this.validateActivationProof(proposal, input, atIso);
    await this.preflightActivation(proposal, institution);

    const plan = compileConstitutionalMutationPlan({ proposal });
    const capability = ConstitutionalActivationCapability.mint({
      proposalId: proposal.constitutionalChangeProposalId,
      proposalHash: proposal.proposalHash,
      proposalVersion: proposal.proposalVersion,
      activationRecordId: staged.activationRecordId,
      baseGovernanceFingerprint: proposal.baseGovernanceFingerprint,
      institutionId: institution.institutionId,
      activatedByPrincipalId: input.activatorPrincipalId,
      mutationPlanHash: plan.planHash,
      authorizedProtectedMutations: authorizedProtectedMutationsForOperations(
        plan.operations,
      ),
    });

    await applyConstitutionalMutationPlan({
      operations: plan.operations,
      capability,
      activatedByPrincipalId: input.activatorPrincipalId,
      deps: { nowIso: () => this.deps.nowIso(), governance: this.deps.governance },
      afterMaterialWrites: () => this.deps.activationFailpoint?.trigger(),
    });

    const updatedInstitution = await this.requireInstitution(
      institution.institutionId,
    );
    const targetFingerprint =
      await this.computeCurrentFingerprint(updatedInstitution);

    if (targetFingerprint === proposal.baseGovernanceFingerprint) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_OPERATION_INVALID",
        "Activation produced no governance fingerprint change",
      );
    }

    const now = this.deps.nowIso();
    const activated = withActivationRecordHash({
      ...staged,
      targetGovernanceFingerprint: targetFingerprint,
      status: "ACTIVATED",
      activatedAt: now,
      recordRevision: staged.recordRevision + 1,
    });

    const saved = await this.deps.activationRecords.save(activated);
    if (proposal.status !== "ACTIVATED") {
      await this.deps.proposals.transition(
        input.proposalId,
        "STAGED",
        proposal.recordRevision,
        "ACTIVATED",
        now,
      );
    }
    await this.audit(
      "ACTIVATED",
      institution.institutionId,
      proposal.constitutionalChangeProposalId,
      { targetFingerprint, planHash: plan.planHash },
    );

    return { record: saved, capability };
  }

  async enableConstitutionalControl(input: {
    institutionId: string;
    actorPrincipalId: string;
  }): Promise<Institution> {
    const institution = await this.requireInstitution(input.institutionId);
    await this.requireGovernanceAdmin(input.actorPrincipalId, institution);
    return this.deps.governance.updateInstitution({
      institutionId: input.institutionId,
      patch: { constitutionalControlEnabled: true },
      expectedRevision: institution.recordRevision,
    });
  }

  private async preflightActivation(
    proposal: ConstitutionalChangeProposal,
    institution: Institution,
  ): Promise<void> {
    await this.verifyBaseFingerprintUnchanged(proposal, institution);
    assertConstitutionalSafetyFloor(proposal.changeOperations);
    assertAllOperationsExecutable(proposal.changeOperations);
    await this.assertProjectedContinuity(institution, proposal.changeOperations);
    this.assertOrgDagValid(proposal.changeOperations);
  }

  private async verifyBaseFingerprintUnchanged(
    proposal: ConstitutionalChangeProposal,
    institution: Institution,
  ): Promise<void> {
    const currentFingerprint = await this.computeCurrentFingerprint(institution);
    if (currentFingerprint !== proposal.baseGovernanceFingerprint) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_BASE_STATE_STALE",
        "Current governance fingerprint does not match proposal base",
        {
          expected: proposal.baseGovernanceFingerprint,
          current: currentFingerprint,
        },
      );
    }
  }

  private async persistStaleProposalIfDrifted(
    proposal: ConstitutionalChangeProposal,
    institution: Institution,
  ): Promise<void> {
    const currentFingerprint = await this.computeCurrentFingerprint(institution);
    if (currentFingerprint === proposal.baseGovernanceFingerprint) {
      return;
    }
    const latest = await this.requireProposal(
      proposal.constitutionalChangeProposalId,
    );
    if (latest.status === "STALE" || latest.status === "ACTIVATED") {
      return;
    }
    if (
      latest.proposalHash !== proposal.proposalHash ||
      latest.proposalVersion !== proposal.proposalVersion
    ) {
      return;
    }
    try {
      await this.deps.proposals.transition(
        latest.constitutionalChangeProposalId,
        latest.status,
        latest.recordRevision,
        "STALE",
        this.deps.nowIso(),
      );
    } catch (error) {
      if (
        isConstitutionalError(error) &&
        error.code === "CONSTITUTIONAL_CAS_CONFLICT"
      ) {
        return;
      }
      throw error;
    }
  }

  private async assertFingerprintFresh(
    proposal: ConstitutionalChangeProposal,
    institution: Institution,
  ): Promise<void> {
    const currentFingerprint = await this.computeCurrentFingerprint(institution);
    if (currentFingerprint !== proposal.baseGovernanceFingerprint) {
      if (proposal.status !== "STALE" && proposal.status !== "ACTIVATED") {
        await this.deps.proposals.transition(
          proposal.constitutionalChangeProposalId,
          proposal.status,
          proposal.recordRevision,
          "STALE",
          this.deps.nowIso(),
        );
      }
      throw new ConstitutionalError(
        "CONSTITUTIONAL_BASE_STATE_STALE",
        "Current governance fingerprint does not match proposal base",
        {
          expected: proposal.baseGovernanceFingerprint,
          current: currentFingerprint,
        },
      );
    }
  }

  private async assertProjectedContinuity(
    institution: Institution,
    operations: readonly ConstitutionalChangeOperation[],
  ): Promise<void> {
    const mandates = await this.listMandatesForInstitution(institution);
    const units = await this.deps.governance.listOrganizationalUnits(
      institution.institutionId,
    );
    const grants = await this.listAllGrantsForInstitution(institution);
    assertProjectedGovernanceContinuity({
      institution,
      mandates,
      units,
      grants,
      operations,
      nowIso: this.deps.nowIso(),
      actorPrincipalId: "continuity-check",
    });
  }

  private async computeCurrentFingerprint(
    institution: Institution,
  ): Promise<string> {
    const mandates = await this.listMandatesForInstitution(institution);
    const units = await this.deps.governance.listOrganizationalUnits(
      institution.institutionId,
    );
    const grants = await this.listAllGrantsForInstitution(institution);
    return computeGovernanceStateFingerprint({
      institutionId: institution.institutionId,
      mandates,
      organizationalUnits: units,
      constitutionalControlEnabled: institution.constitutionalControlEnabled,
      institutionProjectIds: institution.projectIds,
      constitutionalRoleGrants: selectConstitutionalRoleGrants(
        grants,
        institution.projectIds,
      ),
      constitutionalRevocationIds: [],
    });
  }

  private async listAllGrantsForInstitution(
    institution: Institution,
  ): Promise<import("../governance/canonical-authority.js").CanonicalAuthorityGrant[]> {
    if (!this.deps.canonicalAuthority.listByProject) return [];
    const all: import("../governance/canonical-authority.js").CanonicalAuthorityGrant[] =
      [];
    for (const projectId of institution.projectIds) {
      all.push(...(await this.deps.canonicalAuthority.listByProject(projectId)));
    }
    return all;
  }

  private async assertPreChangeSeparation(
    proposal: ConstitutionalChangeProposal,
    reviewerPrincipalId: string,
  ): Promise<void> {
    const hasSodChange = proposal.changeOperations.some(
      (op) => op.kind === "CHANGE_MANDATE_SEPARATION_OF_DUTIES",
    );
    if (!hasSodChange) return;

    for (const op of proposal.changeOperations) {
      if (op.kind !== "CHANGE_MANDATE_SEPARATION_OF_DUTIES") continue;
      const current = await this.deps.governance.getMandate(op.mandateId);
      if (!current?.separationOfDutyRules?.length) continue;
      try {
        assertSeparationOfDuties({
          rules: current.separationOfDutyRules,
          roleOccupancy: new Map([
            ["CONSTITUTIONAL_REVIEWER", reviewerPrincipalId],
            ["GOVERNANCE_ADMIN", proposal.proposedByPrincipalId],
            ["CONSTITUTIONAL_PROPOSER", proposal.proposedByPrincipalId],
          ]),
        });
      } catch {
        throw new ConstitutionalError(
          "CONSTITUTIONAL_SEPARATION_VIOLATION",
          "Old SoD governs SoD-removal proposal — same principal blocked",
        );
      }
    }
  }

  private async validateReviewProof(
    proposal: ConstitutionalChangeProposal,
    input: {
      institutionalAuthorizationProofId: string;
      projectId: string;
      environment: string;
      atIso?: string;
    },
    atIso: string,
  ): Promise<void> {
    const subject = compileReviewSubjectBinding({
      proposalId: proposal.constitutionalChangeProposalId,
      proposalVersion: proposal.proposalVersion,
      proposalHash: proposal.proposalHash,
    });
    await this.deps.governance.validateProof({
      proofId: input.institutionalAuthorizationProofId,
      ...subject,
      projectId: input.projectId,
      environment: input.environment,
      atIso,
    });
  }

  private async validateReviewProofFresh(
    review: ConstitutionalReviewDecision,
    proposal: ConstitutionalChangeProposal,
    input: { projectId: string; environment: string },
    atIso: string,
  ): Promise<void> {
    if (review.proposalHash !== proposal.proposalHash) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROOF_SUBJECT_MISMATCH",
        "Review decision hash mismatch",
      );
    }
    await this.validateReviewProof(
      proposal,
      {
        institutionalAuthorizationProofId:
          review.institutionalAuthorizationProofId,
        projectId: input.projectId,
        environment: input.environment,
      },
      atIso,
    );
  }

  private async validateActivationProof(
    proposal: ConstitutionalChangeProposal,
    input: {
      institutionalAuthorizationProofId: string;
      projectId: string;
      environment: string;
    },
    atIso: string,
  ): Promise<void> {
    const subject = compileActivationSubjectBinding({
      proposalId: proposal.constitutionalChangeProposalId,
      proposalVersion: proposal.proposalVersion,
      proposalHash: proposal.proposalHash,
    });
    await this.deps.governance.validateProof({
      proofId: input.institutionalAuthorizationProofId,
      ...subject,
      projectId: input.projectId,
      environment: input.environment,
      atIso,
    });
  }

  private async requireApprovedReview(
    input: { reviewDecisionId: string },
    proposal: ConstitutionalChangeProposal,
  ): Promise<ConstitutionalReviewDecision> {
    const review = await this.deps.reviewDecisions.getById(
      input.reviewDecisionId,
    );
    if (!review || review.decision !== "APPROVE") {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_REVIEW_REQUIRED",
        "Approved review decision required",
      );
    }
    if (review.proposalId !== proposal.constitutionalChangeProposalId) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROOF_SUBJECT_MISMATCH",
        "Review decision proposal mismatch",
      );
    }
    return review;
  }

  private async requireImpactAnalysis(
    proposalId: string,
  ): Promise<ConstitutionalImpactAnalysis> {
    const analysis =
      await this.deps.impactAnalyses.getLatestByProposal(proposalId);
    if (!analysis) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_IMPACT_ANALYSIS_REQUIRED",
        "Impact analysis required",
      );
    }
    return analysis;
  }

  private async listMandatesForInstitution(
    institution: Institution,
  ): Promise<GovernanceMandate[]> {
    const byId = new Map<string, GovernanceMandate>();
    for (const projectId of institution.projectIds) {
      const mandates =
        await this.deps.governance.listActiveMandatesByProject(projectId);
      for (const m of mandates) {
        if (m.institutionId === institution.institutionId) {
          byId.set(m.mandateId, m);
        }
      }
    }
    return [...byId.values()];
  }

  private async listConstitutionalReviewMandates(
    institution: Institution,
  ): Promise<GovernanceMandate[]> {
    return (await this.listMandatesForInstitution(institution)).filter((m) =>
      m.subjectClasses.includes("CONSTITUTIONAL_CHANGE"),
    );
  }

  /** Pre-change governance rule: current mandate quorum governs this proposal. */
  private requiredReviewApprovals(mandates: GovernanceMandate[]): number {
    let max = 1;
    for (const m of mandates) {
      const q = m.quorumRequirement;
      if (q?.kind === "K_OF_N") max = Math.max(max, q.k ?? 1);
      if (q?.kind === "ALL_OF") max = Math.max(max, q.roles.length || 1);
    }
    return max;
  }

  private assertSelfEscalationBlocked(input: {
    proposal: ConstitutionalChangeProposal;
    analysis: ConstitutionalImpactAnalysis;
    actorPrincipalId: string;
    role: "REVIEWER" | "ACTIVATOR";
  }): void {
    void input.analysis;
    void input.role;
    for (const op of input.proposal.changeOperations) {
      if (
        op.kind === "CREATE_MANDATE_VERSION" &&
        op.selfGrantOperationalAuthority &&
        input.actorPrincipalId === input.proposal.proposedByPrincipalId
      ) {
        throw new ConstitutionalError(
          "CONSTITUTIONAL_SELF_ESCALATION",
          "Cannot self-grant operational authority",
        );
      }
    }
  }

  private assertOrgDagValid(
    operations: readonly ConstitutionalChangeOperation[],
  ): void {
    const parent = new Map<string, string | undefined>();
    for (const op of operations) {
      if (op.kind === "CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP") {
        parent.set(op.organizationalUnitId, op.parentUnitId);
      }
    }
    for (const [unitId, p] of parent) {
      const visited = new Set<string>();
      let current: string | undefined = p;
      while (current) {
        if (current === unitId) {
          throw new ConstitutionalError(
            "CONSTITUTIONAL_ORG_CYCLE",
            `Cycle at ${unitId}`,
          );
        }
        if (visited.has(current)) break;
        visited.add(current);
        current = parent.get(current);
      }
    }
  }

  private async requireProposal(
    proposalId: string,
  ): Promise<ConstitutionalChangeProposal> {
    const proposal = await this.deps.proposals.getById(proposalId);
    if (!proposal) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_PROPOSAL_NOT_FOUND",
        `Proposal ${proposalId} not found`,
      );
    }
    return proposal;
  }

  private async requireInstitution(
    institutionId: string,
  ): Promise<Institution> {
    const institution = await this.deps.governance.getInstitution(institutionId);
    if (!institution) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ADMIN_INSUFFICIENT",
        `Institution ${institutionId} not found`,
      );
    }
    return institution;
  }

  private async requireGovernanceAdmin(
    principalId: string,
    institution: Institution,
  ): Promise<void> {
    if (!this.deps.isGovernanceAdmin) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ADMIN_INSUFFICIENT",
        "Governance admin checker not configured",
      );
    }
    const ok = await this.deps.isGovernanceAdmin(
      principalId,
      institution.institutionId,
      institution.projectIds,
    );
    if (!ok) {
      throw new ConstitutionalError(
        "CONSTITUTIONAL_ADMIN_INSUFFICIENT",
        `Principal ${principalId} is not GOVERNANCE_ADMIN`,
      );
    }
  }

  private async audit(
    eventType: string,
    institutionId: string,
    proposalId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.audits.append({
      auditEventId: randomUUID(),
      eventType,
      institutionId,
      proposalId,
      payload,
      createdAt: this.deps.nowIso(),
    });
  }
}

export function assertProposalImmutable(
  proposal: ConstitutionalChangeProposal,
): void {
  if (isProposalMaterialImmutable(proposal.status)) {
    throw new ConstitutionalError(
      "CONSTITUTIONAL_PROPOSAL_IMMUTABLE",
      `Proposal immutable in status ${proposal.status}`,
    );
  }
}

export function detectProposalMaterialChange(
  before: ConstitutionalChangeProposal,
  after: Omit<ConstitutionalChangeProposal, "proposalHash" | "recordRevision">,
): boolean {
  return computeProposalHash(before) !== computeProposalHash(after);
}

export { assertAllOperationsExecutable, assertExhaustiveOperationKind } from "./mutation-plan.js";
