import { createHash, randomUUID } from "node:crypto";
import type { AdmissionResult } from "../admission/result.js";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { CanonicalAuthorityGrantPort } from "../governance/canonical-authority.js";
import { isGovernanceError } from "../governance/errors.js";
import type { GovernanceOrchestrationService } from "../governance/service.js";
import {
  mintActivationRecordId,
  withActivationRecordHash,
  type FederationActivationRecord,
} from "./agreement-activation.js";
import {
  mintAgreementId,
  mintFederationId,
  withAgreementHash,
  type FederationAgreement,
} from "./agreement.js";
import type { FederationAuditEvent, FederationAuditEventType } from "./audit.js";
import { FEDERATION_ACTIONS, type FederationAction, type FederationRole } from "./doctrine.js";
import {
  mintEnvelopeId,
  withEnvelopeHash,
  type FederatedEvidenceEnvelope,
} from "./evidence-envelope.js";
import { FederationError, isFederationError } from "./errors.js";
import { computeFederationStateFingerprint } from "./fingerprint.js";
import {
  compileWithdrawalSubjectBinding,
  mintParticipationChangeId,
  withParticipationChangeHash,
  type FederationParticipationChange,
} from "./participation.js";
import {
  compileRatificationSubjectBinding,
  mintRatificationId,
  withRatificationHash,
  type FederationRatification,
} from "./ratification.js";
import type {
  FederationActivationRecordRepository,
  FederationAgreementRepository,
  FederationAuditRepository,
  FederationParticipationChangeRepository,
  FederationRatificationRepository,
  FederatedEvidenceEnvelopeRepository,
  FederatedMaterializationRepository,
  FederatedWorkAcceptanceRepository,
  FederatedWorkIntentRepository,
} from "./repositories.js";
import {
  assertAllowedActions,
  assertWorkIntentInScope,
  canonicalizeParticipantIds,
  computeParticipantSetHash,
  computeScopeHash,
  type FederationScope,
} from "./scope.js";
import {
  compileWorkAcceptanceSubjectBinding,
  mintAcceptanceId,
  withAcceptanceHash,
  type FederatedWorkAcceptance,
} from "./work-acceptance.js";
import {
  mintIntentId,
  withIntentHash,
  type FederatedWorkIntent,
} from "./work-intent.js";
import {
  materializationIdempotencyKey,
  mintMaterializationId,
  withMaterializationHash,
  type FederatedMaterializationRecord,
} from "./work-materialization.js";

export interface FederationOrchestrationDeps {
  nowIso: () => string;
  agreements: FederationAgreementRepository;
  ratifications: FederationRatificationRepository;
  activationRecords: FederationActivationRecordRepository;
  participationChanges: FederationParticipationChangeRepository;
  intents: FederatedWorkIntentRepository;
  acceptances: FederatedWorkAcceptanceRepository;
  materializations: FederatedMaterializationRepository;
  evidence: FederatedEvidenceEnvelopeRepository;
  audits: FederationAuditRepository;
  governance: GovernanceOrchestrationService;
  canonicalAuthority: CanonicalAuthorityGrantPort;
  /** Phase 2 admission — required for materialization. */
  admission?: Pick<ObjectiveAdmissionService, "admit">;
  /**
   * Serializes activation across participant institutions.
   * Must acquire locks in sorted institution-id order inside one transaction.
   */
  runFederationActivation?: <T>(
    participantInstitutionIds: readonly string[],
    fn: () => Promise<T>,
  ) => Promise<T>;
  /** Test-only: throws after material activation write, before activation record. */
  activationFailpoint?: { name: string; trigger: () => void };
}

export class FederationOrchestrationService {
  constructor(private readonly deps: FederationOrchestrationDeps) {}

  async proposeAgreement(input: {
    participantInstitutionIds: readonly string[];
    scope: Omit<FederationScope, "participantInstitutionIds"> & {
      participantInstitutionIds?: readonly string[];
    };
    allowedActions: readonly FederationAction[];
    proposingInstitutionId: string;
    proposedByPrincipalId: string;
    projectId: string;
    environment: string;
    federationId?: string;
    baseAgreementVersion?: number;
    baseAgreementHash?: string;
    effectiveUntil?: string;
    expiresAt?: string;
  }): Promise<FederationAgreement> {
    assertAllowedActions([...input.allowedActions]);
    const participants = canonicalizeParticipantIds(
      input.participantInstitutionIds,
    );
    if (!participants.includes(input.proposingInstitutionId)) {
      throw new FederationError(
        "FEDERATION_PARTICIPANT_INVALID",
        "Proposing institution must be a participant",
      );
    }
    for (const institutionId of participants) {
      await this.requireActiveInstitution(institutionId);
    }
    await this.requireFederationRole({
      principalId: input.proposedByPrincipalId,
      role: "FEDERATION_NEGOTIATOR",
      projectId: input.projectId,
      environment: input.environment,
      institutionId: input.proposingInstitutionId,
    });

    const scope: FederationScope = {
      ...input.scope,
      participantInstitutionIds: participants,
      permittedPairs: input.scope.permittedPairs,
    };
    for (const pair of scope.permittedPairs) {
      if (
        !participants.includes(pair.sourceInstitutionId) ||
        !participants.includes(pair.targetInstitutionId)
      ) {
        throw new FederationError(
          "FEDERATION_SCOPE_VIOLATION",
          "Permitted pair references non-participant",
        );
      }
    }

    const now = this.deps.nowIso();
    const federationId =
      input.federationId ??
      mintFederationId({
        participantInstitutionIds: participants,
        createdAt: now,
      });

    const active = await this.deps.agreements.getActiveByFederation(federationId);
    const existingVersions = await this.deps.agreements.listByFederation(
      federationId,
    );
    const maxVersion = existingVersions.reduce(
      (max, a) => Math.max(max, a.agreementVersion),
      0,
    );
    const baseFingerprint = await this.computeFingerprintForFederation(
      federationId,
      active,
    );

    const agreementVersion = maxVersion + 1;
    const agreementId = mintAgreementId({
      federationId,
      agreementVersion,
      createdAt: now,
    });

    const draft = withAgreementHash({
      federationId,
      agreementId,
      agreementVersion,
      ...(input.baseAgreementVersion !== undefined
        ? { baseAgreementVersion: input.baseAgreementVersion }
        : active
          ? { baseAgreementVersion: active.agreementVersion }
          : {}),
      ...(input.baseAgreementHash !== undefined
        ? { baseAgreementHash: input.baseAgreementHash }
        : active
          ? { baseAgreementHash: active.agreementHash }
          : {}),
      participantInstitutionIds: participants,
      participantSetHash: computeParticipantSetHash(participants),
      scope,
      scopeHash: computeScopeHash(scope),
      allowedActions: [...input.allowedActions],
      effectiveFrom: scope.effectiveFrom,
      ...(input.effectiveUntil !== undefined
        ? { effectiveUntil: input.effectiveUntil }
        : scope.effectiveUntil !== undefined
          ? { effectiveUntil: scope.effectiveUntil }
          : {}),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      createdAt: now,
      proposedAt: now,
      proposedByPrincipalId: input.proposedByPrincipalId,
      proposingInstitutionId: input.proposingInstitutionId,
      status: "PROPOSED",
      baseFederationStateFingerprint: baseFingerprint,
      recordRevision: 1,
    });

    const saved = await this.deps.agreements.save(draft);
    await this.audit("AGREEMENT_PROPOSED", {
      federationId,
      agreementId,
      institutionId: input.proposingInstitutionId,
      payload: {
        agreementVersion,
        agreementHash: saved.agreementHash,
        participants,
      },
    });
    return saved;
  }

  async getAgreement(agreementId: string): Promise<FederationAgreement> {
    return this.requireAgreement(agreementId);
  }

  async getFederation(
    federationId: string,
  ): Promise<FederationAgreement | null> {
    return this.deps.agreements.getByFederationId(federationId);
  }

  async ratify(input: {
    agreementId: string;
    institutionId: string;
    ratifierPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
  }): Promise<FederationRatification> {
    const agreement = await this.requireAgreement(input.agreementId);
    if (
      agreement.status !== "PROPOSED" &&
      agreement.status !== "RATIFYING"
    ) {
      throw new FederationError(
        "FEDERATION_STATE_CONFLICT",
        `Cannot ratify agreement in status ${agreement.status}`,
      );
    }
    if (!agreement.participantInstitutionIds.includes(input.institutionId)) {
      throw new FederationError(
        "FEDERATION_PARTICIPANT_INVALID",
        "Institution is not a participant",
      );
    }
    await this.requireActiveInstitution(input.institutionId);
    await this.assertNoFederationHold(
      input.projectId,
      input.environment,
      this.deps.nowIso(),
    );

    const existing =
      await this.deps.ratifications.getByAgreementAndInstitution(
        agreement.agreementId,
        input.institutionId,
      );
    if (existing) {
      return existing;
    }

    const proof = await this.validateRatificationProof(agreement, input);

    const now = this.deps.nowIso();
    const ratification = withRatificationHash({
      ratificationId: mintRatificationId({
        agreementId: agreement.agreementId,
        institutionId: input.institutionId,
        ratifiedAt: now,
      }),
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      institutionId: input.institutionId,
      ratifierPrincipalId: input.ratifierPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      proofHash: proof.proofHash,
      authoritySnapshotIds: [...proof.authoritySnapshotIds],
      authoritySnapshotHashes: [...proof.authoritySnapshotHashes],
      projectId: input.projectId,
      environment: input.environment,
      ratifiedAt: now,
    });

    const saved = await this.deps.ratifications.save(ratification);
    if (agreement.status === "PROPOSED") {
      await this.deps.agreements.transition(
        agreement.agreementId,
        "PROPOSED",
        agreement.recordRevision,
        "RATIFYING",
        now,
      );
    }
    await this.audit("PARTICIPANT_RATIFIED", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      institutionId: input.institutionId,
      payload: {
        ratificationId: saved.ratificationId,
        ratificationHash: saved.ratificationHash,
      },
    });
    return saved;
  }

  async activate(input: {
    agreementId: string;
    actorPrincipalId: string;
  }): Promise<{
    agreement: FederationAgreement;
    activation: FederationActivationRecord;
  }> {
    const agreement = await this.requireAgreement(input.agreementId);
    const participants = [...agreement.participantInstitutionIds].sort((a, b) =>
      a.localeCompare(b),
    );

    const run =
      this.deps.runFederationActivation ??
      (async (_ids, fn) => fn());

    try {
      return await run(participants, async () =>
        this.activateInsideLock(agreement.agreementId, input.actorPrincipalId),
      );
    } catch (error) {
      if (
        isFederationError(error) &&
        error.code === "FEDERATION_BASE_STATE_STALE"
      ) {
        await this.audit("AGREEMENT_STALE", {
          federationId: agreement.federationId,
          agreementId: agreement.agreementId,
          payload: { reason: error.message },
        });
      }
      throw error;
    }
  }

  async withdraw(input: {
    agreementId: string;
    institutionId: string;
    actorPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
    changeType?: "WITHDRAW" | "SUSPEND";
  }): Promise<FederationParticipationChange> {
    const agreement = await this.requireAgreement(input.agreementId);
    if (!agreement.participantInstitutionIds.includes(input.institutionId)) {
      throw new FederationError(
        "FEDERATION_PARTICIPANT_INVALID",
        "Institution is not a participant",
      );
    }
    if (agreement.status !== "ACTIVE" && agreement.status !== "SUSPENDED") {
      throw new FederationError(
        "FEDERATION_NOT_ACTIVE",
        "Withdrawal requires ACTIVE or SUSPENDED agreement",
      );
    }

    const subject = compileWithdrawalSubjectBinding({
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      institutionId: input.institutionId,
    });
    const now = this.deps.nowIso();
    let proof;
    try {
      proof = await this.deps.governance.validateProof({
        proofId: input.institutionalAuthorizationProofId,
        ...subject,
        projectId: input.projectId,
        environment: input.environment,
        atIso: now,
      });
    } catch (error) {
      this.rethrowProofAsFederation(error, "FEDERATION_AUTHORITY_REQUIRED");
    }

    const change = withParticipationChangeHash({
      changeId: mintParticipationChangeId({
        agreementId: agreement.agreementId,
        institutionId: input.institutionId,
        effectiveAt: now,
      }),
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      institutionId: input.institutionId,
      changeType: input.changeType ?? "WITHDRAW",
      actorPrincipalId: input.actorPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      proofHash: proof!.proofHash,
      effectiveAt: now,
    });

    const saved = await this.deps.participationChanges.save(change);
    if (agreement.status === "ACTIVE") {
      await this.deps.agreements.transition(
        agreement.agreementId,
        "ACTIVE",
        agreement.recordRevision,
        "SUSPENDED",
        now,
      );
    }
    await this.audit("PARTICIPATION_WITHDRAWN", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      institutionId: input.institutionId,
      payload: {
        changeId: saved.changeId,
        changeType: saved.changeType,
      },
    });
    await this.audit("AGREEMENT_SUSPENDED", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      institutionId: input.institutionId,
      payload: { reason: "participant_withdrawal" },
    });
    return saved;
  }

  async proposeWorkIntent(input: {
    agreementId: string;
    sourceInstitutionId: string;
    sourceProjectId: string;
    targetInstitutionId: string;
    targetProjectId: string;
    requestedEnvironment: string;
    requestedOutcome: string;
    acceptanceCriteria: readonly string[];
    constraints?: readonly string[];
    nonGoals?: readonly string[];
    priority?: FederatedWorkIntent["priority"];
    deadline?: string;
    resourceRequest?: FederatedWorkIntent["resourceRequest"];
    evidenceReferences?: readonly string[];
    proposedByPrincipalId: string;
    institutionalAuthorizationProofId?: string;
    projectId: string;
    environment: string;
    expiresAt?: string;
  }): Promise<FederatedWorkIntent> {
    const agreement = await this.requireActiveCoordinatingAgreement(
      input.agreementId,
    );
    if (!agreement.allowedActions.includes("PROPOSE_OBJECTIVE")) {
      throw new FederationError(
        "FEDERATION_ACTION_UNSUPPORTED",
        "PROPOSE_OBJECTIVE not allowed by agreement",
      );
    }
    assertWorkIntentInScope({
      scope: agreement.scope,
      sourceInstitutionId: input.sourceInstitutionId,
      targetInstitutionId: input.targetInstitutionId,
      sourceProjectId: input.sourceProjectId,
      targetProjectId: input.targetProjectId,
      environment: input.requestedEnvironment,
      intentKind: "OBJECTIVE",
      atIso: this.deps.nowIso(),
      ...(input.resourceRequest !== undefined
        ? { resourceRequest: input.resourceRequest }
        : {}),
    });

    await this.requireFederationRole({
      principalId: input.proposedByPrincipalId,
      role: "FEDERATION_NEGOTIATOR",
      projectId: input.projectId,
      environment: input.environment,
      institutionId: input.sourceInstitutionId,
    });

    if (input.institutionalAuthorizationProofId) {
      const subjectHash = createHash("sha256")
        .update(
          JSON.stringify({
            federationId: agreement.federationId,
            agreementId: agreement.agreementId,
            agreementHash: agreement.agreementHash,
            sourceInstitutionId: input.sourceInstitutionId,
            targetInstitutionId: input.targetInstitutionId,
          }),
          "utf8",
        )
        .digest("hex");
      try {
        await this.deps.governance.validateProof({
          proofId: input.institutionalAuthorizationProofId,
          subjectType: "FEDERATION_WORK_PROPOSAL",
          subjectId: `${agreement.agreementId}:propose`,
          subjectHash,
          requiredRole: "FEDERATION_NEGOTIATOR",
          action: "FEDERATION_WORK_PROPOSAL",
          projectId: input.projectId,
          environment: input.environment,
          atIso: this.deps.nowIso(),
        });
      } catch (error) {
        this.rethrowProofAsFederation(error, "FEDERATION_AUTHORITY_REQUIRED");
      }
    }

    const now = this.deps.nowIso();
    const intentId = mintIntentId({
      agreementId: agreement.agreementId,
      sourceInstitutionId: input.sourceInstitutionId,
      targetInstitutionId: input.targetInstitutionId,
      createdAt: now,
    });

    const intent = withIntentHash({
      intentId,
      intentVersion: 1,
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      sourceInstitutionId: input.sourceInstitutionId,
      sourceProjectId: input.sourceProjectId,
      targetInstitutionId: input.targetInstitutionId,
      targetProjectId: input.targetProjectId,
      requestedEnvironment: input.requestedEnvironment,
      intentKind: "OBJECTIVE",
      requestedOutcome: input.requestedOutcome,
      acceptanceCriteria: [...input.acceptanceCriteria],
      constraints: [...(input.constraints ?? [])],
      nonGoals: [...(input.nonGoals ?? [])],
      priority: input.priority ?? "MEDIUM",
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      ...(input.resourceRequest !== undefined
        ? { resourceRequest: input.resourceRequest }
        : {}),
      evidenceReferences: [...(input.evidenceReferences ?? [])],
      proposedByPrincipalId: input.proposedByPrincipalId,
      ...(input.institutionalAuthorizationProofId !== undefined
        ? {
            institutionalAuthorizationProofId:
              input.institutionalAuthorizationProofId,
          }
        : {}),
      createdAt: now,
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      status: "PROPOSED",
    });

    const saved = await this.deps.intents.save(intent);
    await this.audit("WORK_INTENT_CREATED", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      intentId: saved.intentId,
      institutionId: input.sourceInstitutionId,
      payload: {
        intentHash: saved.intentHash,
        targetInstitutionId: input.targetInstitutionId,
        resourceRequestIsNotReservation: true,
      },
    });
    return saved;
  }

  async acceptWork(input: {
    intentId: string;
    actorPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
    reason?: string;
  }): Promise<FederatedWorkAcceptance> {
    return this.decideWork({ ...input, decision: "ACCEPT" });
  }

  async rejectWork(input: {
    intentId: string;
    actorPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
    reason?: string;
  }): Promise<FederatedWorkAcceptance> {
    return this.decideWork({ ...input, decision: "REJECT" });
  }

  async materializeWork(input: {
    intentId: string;
    /** Target-local requester — never sourced from foreign intent authority. */
    targetLocalRequesterId: string;
    submittedAt?: string;
  }): Promise<{
    materialization: FederatedMaterializationRecord;
    admission: AdmissionResult;
  }> {
    if (!this.deps.admission) {
      throw new FederationError(
        "FEDERATED_MATERIALIZATION_FAILED",
        "Objective admission service not configured",
      );
    }
    if (!input.targetLocalRequesterId) {
      throw new FederationError(
        "FEDERATED_REQUESTER_AUTHORITY_REQUIRED",
        "Target-local requesterId is required; source cannot supply requester authority",
      );
    }

    const intent = await this.requireIntent(input.intentId);
    if (intent.status !== "ACCEPTED" && intent.status !== "MATERIALIZED") {
      throw new FederationError(
        "FEDERATED_INTENT_NOT_ACCEPTED",
        `Intent ${input.intentId} is ${intent.status}`,
      );
    }

    const acceptance = await this.deps.acceptances.getByIntent(intent.intentId);
    if (!acceptance || acceptance.decision !== "ACCEPT") {
      throw new FederationError(
        "FEDERATED_INTENT_NOT_ACCEPTED",
        "Accepted FederatedWorkAcceptance required",
      );
    }

    // Current-state preflight immediately before Phase 2 — no silent rebase.
    const agreement = await this.assertMaterializationAgreementCurrent(intent);

    if (
      intent.expiresAt !== undefined &&
      Date.parse(this.deps.nowIso()) > Date.parse(intent.expiresAt)
    ) {
      throw new FederationError(
        "FEDERATED_INTENT_STALE",
        "Intent expired before materialization",
      );
    }

    const idemKey = materializationIdempotencyKey({
      intentId: intent.intentId,
      intentHash: intent.intentHash,
      targetProjectId: intent.targetProjectId,
      environment: intent.requestedEnvironment,
    });
    const existing =
      await this.deps.materializations.getByIdempotencyKey(idemKey);
    if (existing) {
      if (
        existing.targetProjectId !== intent.targetProjectId ||
        existing.environment !== intent.requestedEnvironment ||
        existing.intentHash !== intent.intentHash ||
        existing.targetLocalRequesterId !== input.targetLocalRequesterId
      ) {
        throw new FederationError(
          "FEDERATED_MATERIALIZATION_CONFLICT",
          "Conflicting materialization identity",
        );
      }
      // Deterministic reuse — do not re-admit; lineage record is authoritative.
      return {
        materialization: existing,
        admission: {
          outcome: "ACTIVE_DUPLICATE",
          runId: existing.runId,
          state: "ADMITTED",
          idempotencyKey: idemKey,
        },
      };
    }

    const conflicting = await this.deps.materializations.getByIntent(
      intent.intentId,
    );
    if (conflicting) {
      throw new FederationError(
        "FEDERATED_MATERIALIZATION_CONFLICT",
        "Intent already materialized under different identity",
        {
          existingProjectId: conflicting.targetProjectId,
          requestedProjectId: intent.targetProjectId,
        },
      );
    }

    const submittedAt = input.submittedAt ?? this.deps.nowIso();
    const objectiveId = `obj_fed_${intent.intentId}`;
    const admission = await this.deps.admission.admit({
      projectId: intent.targetProjectId,
      objectiveId,
      objectiveVersion: 1,
      requestedOutcome: intent.requestedOutcome,
      acceptanceCriteria: intent.acceptanceCriteria,
      nonGoals: intent.nonGoals,
      constraints: [
        ...intent.constraints,
        `federationIntentId:${intent.intentId}`,
        `federationAgreementId:${intent.agreementId}`,
      ],
      priority: intent.priority,
      requesterId: input.targetLocalRequesterId,
      requestedEnvironment: intent.requestedEnvironment,
      submittedAt,
      ...(intent.deadline !== undefined ? { deadline: intent.deadline } : {}),
    });

    if (admission.outcome !== "ADMITTED") {
      const reason =
        admission.outcome === "REJECTED" || admission.outcome === "CONFLICT"
          ? admission.reasonCode
          : admission.outcome;
      throw new FederationError(
        "FEDERATED_MATERIALIZATION_FAILED",
        `Phase 2 admission rejected: ${reason}`,
        { admission },
      );
    }

    // Persist materialization only after canonical Phase 2 admission succeeds.
    const now = this.deps.nowIso();
    const materialization = withMaterializationHash({
      materializationId: mintMaterializationId({
        intentId: intent.intentId,
        targetProjectId: intent.targetProjectId,
        environment: intent.requestedEnvironment,
      }),
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      intentId: intent.intentId,
      intentHash: intent.intentHash,
      acceptanceId: acceptance.acceptanceId,
      acceptanceHash: acceptance.acceptanceHash,
      targetLocalRequesterId: input.targetLocalRequesterId,
      targetInstitutionId: intent.targetInstitutionId,
      targetProjectId: intent.targetProjectId,
      environment: intent.requestedEnvironment,
      objectiveId,
      objectiveVersion: 1,
      runId: admission.runId,
      materializedAt: now,
    });

    const saved = await this.deps.materializations.save(materialization);
    if (intent.status === "ACCEPTED") {
      await this.deps.intents.updateStatus(
        intent.intentId,
        "ACCEPTED",
        "MATERIALIZED",
      );
    }
    await this.audit("WORK_MATERIALIZED", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      intentId: intent.intentId,
      institutionId: intent.targetInstitutionId,
      payload: {
        materializationId: saved.materializationId,
        runId: saved.runId,
        targetLocalRequesterId: input.targetLocalRequesterId,
      },
    });
    return { materialization: saved, admission };
  }

  async shareEvidence(input: {
    agreementId: string;
    sourceInstitutionId: string;
    sourceProjectId: string;
    sourceEvidenceId: string;
    sourceVerificationId?: string;
    contentHash: string;
    destinationInstitutionId: string;
    destinationProjectId: string;
    dataClassification: string;
    provenance: string;
    sharedByPrincipalId: string;
    institutionalAuthorizationProofId?: string;
    intentId?: string;
    projectId: string;
    environment: string;
  }): Promise<FederatedEvidenceEnvelope> {
    const agreement = await this.requireActiveCoordinatingAgreement(
      input.agreementId,
    );
    if (!agreement.allowedActions.includes("SHARE_EVIDENCE")) {
      throw new FederationError(
        "FEDERATION_ACTION_UNSUPPORTED",
        "SHARE_EVIDENCE not allowed by agreement",
      );
    }
    if (
      !agreement.scope.evidenceSharingClasses.includes(
        input.dataClassification,
      ) &&
      agreement.scope.evidenceSharingClasses.length > 0
    ) {
      throw new FederationError(
        "FEDERATION_SCOPE_VIOLATION",
        "Evidence classification not permitted",
      );
    }
    await this.requireFederationRole({
      principalId: input.sharedByPrincipalId,
      role: "FEDERATION_EVIDENCE_SHARER",
      projectId: input.projectId,
      environment: input.environment,
      institutionId: input.sourceInstitutionId,
    });

    const now = this.deps.nowIso();
    const envelope = withEnvelopeHash({
      envelopeId: mintEnvelopeId({
        sourceEvidenceId: input.sourceEvidenceId,
        destinationInstitutionId: input.destinationInstitutionId,
        sharedAt: now,
      }),
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementHash: agreement.agreementHash,
      ...(input.intentId !== undefined ? { intentId: input.intentId } : {}),
      sourceInstitutionId: input.sourceInstitutionId,
      sourceProjectId: input.sourceProjectId,
      sourceEvidenceId: input.sourceEvidenceId,
      ...(input.sourceVerificationId !== undefined
        ? { sourceVerificationId: input.sourceVerificationId }
        : {}),
      contentHash: input.contentHash,
      destinationInstitutionId: input.destinationInstitutionId,
      destinationProjectId: input.destinationProjectId,
      dataClassification: input.dataClassification,
      provenance: input.provenance,
      receivingStatus: "EXTERNAL_UNVERIFIED",
      sharedByPrincipalId: input.sharedByPrincipalId,
      ...(input.institutionalAuthorizationProofId !== undefined
        ? {
            institutionalAuthorizationProofId:
              input.institutionalAuthorizationProofId,
          }
        : {}),
      sharedAt: now,
    });

    const saved = await this.deps.evidence.save(envelope);
    await this.audit("EVIDENCE_SHARED", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      ...(input.intentId !== undefined ? { intentId: input.intentId } : {}),
      institutionId: input.sourceInstitutionId,
      payload: {
        envelopeId: saved.envelopeId,
        receivingStatus: "EXTERNAL_UNVERIFIED",
        foreignEvidenceNotLocalTruth: true,
      },
    });
    return saved;
  }

  /** Resource requests on intents/agreements never touch local budget ledgers. */
  federationResourceRequestIsNotReservation(): true {
    return true;
  }

  private async activateInsideLock(
    agreementId: string,
    _actorPrincipalId: string,
  ): Promise<{
    agreement: FederationAgreement;
    activation: FederationActivationRecord;
  }> {
    const agreement = await this.requireAgreement(agreementId);

    const existingActivation =
      await this.deps.activationRecords.getByAgreement(agreementId);
    if (existingActivation && agreement.status === "ACTIVE") {
      return { agreement, activation: existingActivation };
    }

    if (
      agreement.status !== "PROPOSED" &&
      agreement.status !== "RATIFYING"
    ) {
      if (agreement.status === "ACTIVE" && existingActivation) {
        return { agreement, activation: existingActivation };
      }
      throw new FederationError(
        "FEDERATION_STATE_CONFLICT",
        `Cannot activate from ${agreement.status}`,
      );
    }

    const active = await this.deps.agreements.getActiveByFederation(
      agreement.federationId,
    );
    const currentFingerprint = await this.computeFingerprintForFederation(
      agreement.federationId,
      active,
    );
    if (currentFingerprint !== agreement.baseFederationStateFingerprint) {
      throw new FederationError(
        "FEDERATION_BASE_STATE_STALE",
        "Federation base state fingerprint mismatch",
        {
          expected: agreement.baseFederationStateFingerprint,
          current: currentFingerprint,
        },
      );
    }

    const ratifications = await this.deps.ratifications.listByAgreement(
      agreement.agreementId,
    );
    const byInstitution = new Map(
      ratifications.map((r) => [r.institutionId, r]),
    );
    for (const institutionId of agreement.participantInstitutionIds) {
      const ratification = byInstitution.get(institutionId);
      if (!ratification) {
        throw new FederationError(
          "FEDERATION_RATIFICATION_REQUIRED",
          `Missing ratification for institution ${institutionId}`,
        );
      }
      await this.requireActiveInstitution(institutionId);
      await this.assertNoFederationHold(
        ratification.projectId,
        ratification.environment,
        this.deps.nowIso(),
      );
      try {
        await this.validateRatificationProof(agreement, {
          institutionId: ratification.institutionId,
          institutionalAuthorizationProofId:
            ratification.institutionalAuthorizationProofId,
          projectId: ratification.projectId,
          environment: ratification.environment,
          ratifierPrincipalId: ratification.ratifierPrincipalId,
        });
      } catch (error) {
        if (
          isFederationError(error) &&
          (error.code === "FEDERATION_RATIFICATION_STALE" ||
            error.code === "FEDERATION_AUTHORITY_REQUIRED")
        ) {
          throw new FederationError(
            "FEDERATION_RATIFICATION_STALE",
            `Ratification for ${institutionId} failed provenance revalidation`,
            { cause: error.code },
          );
        }
        throw error;
      }
    }

    const now = this.deps.nowIso();

    if (active && active.agreementId !== agreement.agreementId) {
      await this.deps.agreements.transition(
        active.agreementId,
        "ACTIVE",
        active.recordRevision,
        "SUPERSEDED",
        now,
      );
    }

    const activated = await this.deps.agreements.transition(
      agreement.agreementId,
      agreement.status,
      agreement.recordRevision,
      "ACTIVE",
      now,
    );

    if (this.deps.activationFailpoint?.name === "after_material_before_record") {
      this.deps.activationFailpoint.trigger();
    }

    const targetFingerprint = await this.computeFingerprintForFederation(
      agreement.federationId,
      activated,
    );

    const activation = withActivationRecordHash({
      activationRecordId: mintActivationRecordId({
        agreementId: agreement.agreementId,
        agreementVersion: agreement.agreementVersion,
        activatedAt: now,
      }),
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      participantInstitutionIds: [...agreement.participantInstitutionIds].sort(
        (a, b) => a.localeCompare(b),
      ),
      ratificationIds: ratifications
        .map((r) => r.ratificationId)
        .sort((a, b) => a.localeCompare(b)),
      ratificationHashes: ratifications
        .map((r) => r.ratificationHash)
        .sort((a, b) => a.localeCompare(b)),
      baseFederationStateFingerprint: agreement.baseFederationStateFingerprint,
      targetFederationStateFingerprint: targetFingerprint,
      activatedAt: now,
      status: "ACTIVATED",
    });

    const savedActivation = await this.deps.activationRecords.save(activation);
    await this.audit("AGREEMENT_ACTIVATED", {
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      payload: {
        activationRecordId: savedActivation.activationRecordId,
        targetFingerprint,
        createsZeroOperationalAuthority: true,
      },
    });

    return { agreement: activated, activation: savedActivation };
  }

  private async decideWork(input: {
    intentId: string;
    actorPrincipalId: string;
    institutionalAuthorizationProofId: string;
    projectId: string;
    environment: string;
    decision: "ACCEPT" | "REJECT";
    reason?: string;
  }): Promise<FederatedWorkAcceptance> {
    const intent = await this.requireIntent(input.intentId);
    if (intent.status !== "PROPOSED") {
      throw new FederationError(
        "FEDERATION_STATE_CONFLICT",
        `Intent ${input.intentId} cannot be decided from ${intent.status}`,
      );
    }
    const agreement = await this.requireActiveCoordinatingAgreement(
      intent.agreementId,
    );

    const existing = await this.deps.acceptances.getByIntent(intent.intentId);
    if (existing) {
      return existing;
    }

    // Target institution owns ACCEPT/REJECT — source grants cannot satisfy.
    if (
      input.projectId !== intent.targetProjectId ||
      input.environment !== intent.requestedEnvironment
    ) {
      throw new FederationError(
        "FEDERATED_TARGET_SCOPE_DENIED",
        "Acceptance/rejection must bind exact target project/environment",
      );
    }
    const targetInstitution = await this.deps.governance.getInstitution(
      intent.targetInstitutionId,
    );
    if (!targetInstitution) {
      throw new FederationError(
        "FEDERATION_PARTICIPANT_INVALID",
        "Target institution not found",
      );
    }
    if (!targetInstitution.projectIds.includes(input.projectId)) {
      throw new FederationError(
        "FEDERATION_AUTHORITY_REQUIRED",
        "Accept/reject project must belong to target institution",
      );
    }
    await this.requireFederationRole({
      principalId: input.actorPrincipalId,
      role: "FEDERATION_WORK_ACCEPTOR",
      projectId: intent.targetProjectId,
      environment: intent.requestedEnvironment,
      institutionId: intent.targetInstitutionId,
    });
    await this.assertNoFederationHold(
      intent.targetProjectId,
      intent.requestedEnvironment,
      this.deps.nowIso(),
    );

    const subject = compileWorkAcceptanceSubjectBinding({
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementHash: agreement.agreementHash,
      intentId: intent.intentId,
      intentHash: intent.intentHash,
      targetInstitutionId: intent.targetInstitutionId,
      targetProjectId: intent.targetProjectId,
      environment: intent.requestedEnvironment,
    });

    const now = this.deps.nowIso();
    let proof;
    try {
      proof = await this.deps.governance.validateProof({
        proofId: input.institutionalAuthorizationProofId,
        ...subject,
        projectId: input.projectId,
        environment: input.environment,
        atIso: now,
      });
    } catch (error) {
      this.rethrowProofAsFederation(error, "FEDERATION_AUTHORITY_REQUIRED");
    }

    const acceptance = withAcceptanceHash({
      acceptanceId: mintAcceptanceId({
        intentId: intent.intentId,
        decision: input.decision,
        decidedAt: now,
      }),
      intentId: intent.intentId,
      intentVersion: intent.intentVersion,
      intentHash: intent.intentHash,
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      targetInstitutionId: intent.targetInstitutionId,
      targetProjectId: intent.targetProjectId,
      environment: intent.requestedEnvironment,
      decision: input.decision,
      actorPrincipalId: input.actorPrincipalId,
      institutionalAuthorizationProofId:
        input.institutionalAuthorizationProofId,
      proofHash: proof!.proofHash,
      decidedAt: now,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    const saved = await this.deps.acceptances.save(acceptance);
    await this.deps.intents.updateStatus(
      intent.intentId,
      "PROPOSED",
      input.decision === "ACCEPT" ? "ACCEPTED" : "REJECTED",
    );
    await this.audit(
      input.decision === "ACCEPT" ? "WORK_ACCEPTED" : "WORK_REJECTED",
      {
        federationId: agreement.federationId,
        agreementId: agreement.agreementId,
        intentId: intent.intentId,
        institutionId: intent.targetInstitutionId,
        payload: {
          acceptanceId: saved.acceptanceId,
          createsZeroRun: true,
          createsZeroApproval: true,
          createsZeroExecution: true,
        },
      },
    );
    return saved;
  }

  /**
   * Re-validate exact agreement identity/state/scope immediately before Phase 2.
   * Never rebases an intent onto a newer agreement version.
   */
  private async assertMaterializationAgreementCurrent(
    intent: FederatedWorkIntent,
  ): Promise<FederationAgreement> {
    const agreement = await this.requireActiveCoordinatingAgreement(
      intent.agreementId,
    );
    if (agreement.federationId !== intent.federationId) {
      throw new FederationError(
        "FEDERATED_INTENT_STALE",
        "Intent federationId does not match agreement",
      );
    }
    if (
      agreement.agreementId !== intent.agreementId ||
      agreement.agreementVersion !== intent.agreementVersion ||
      agreement.agreementHash !== intent.agreementHash
    ) {
      throw new FederationError(
        "FEDERATED_INTENT_STALE",
        "Intent agreement identity/hash no longer matches authoritative agreement — no silent rebase",
        {
          intentAgreementId: intent.agreementId,
          intentAgreementVersion: intent.agreementVersion,
          intentAgreementHash: intent.agreementHash,
          currentAgreementId: agreement.agreementId,
          currentAgreementVersion: agreement.agreementVersion,
          currentAgreementHash: agreement.agreementHash,
        },
      );
    }
    assertWorkIntentInScope({
      scope: agreement.scope,
      sourceInstitutionId: intent.sourceInstitutionId,
      targetInstitutionId: intent.targetInstitutionId,
      sourceProjectId: intent.sourceProjectId,
      targetProjectId: intent.targetProjectId,
      environment: intent.requestedEnvironment,
      intentKind: "OBJECTIVE",
      atIso: this.deps.nowIso(),
      ...(intent.resourceRequest !== undefined
        ? { resourceRequest: intent.resourceRequest }
        : {}),
    });
    const targetInstitution = await this.deps.governance.getInstitution(
      intent.targetInstitutionId,
    );
    if (
      !targetInstitution ||
      !targetInstitution.projectIds.includes(intent.targetProjectId)
    ) {
      throw new FederationError(
        "FEDERATED_TARGET_SCOPE_DENIED",
        "Target institution/project no longer valid for materialization",
      );
    }
    await this.assertNoFederationHold(
      intent.targetProjectId,
      intent.requestedEnvironment,
      this.deps.nowIso(),
    );
    return agreement;
  }

  private async validateRatificationProof(
    agreement: FederationAgreement,
    input: {
      institutionId: string;
      institutionalAuthorizationProofId: string;
      projectId: string;
      environment: string;
      ratifierPrincipalId: string;
    },
  ) {
    const subject = compileRatificationSubjectBinding({
      federationId: agreement.federationId,
      agreementId: agreement.agreementId,
      agreementVersion: agreement.agreementVersion,
      agreementHash: agreement.agreementHash,
      participantSetHash: agreement.participantSetHash,
      scopeHash: agreement.scopeHash,
      institutionId: input.institutionId,
    });
    try {
      return await this.deps.governance.validateProof({
        proofId: input.institutionalAuthorizationProofId,
        ...subject,
        projectId: input.projectId,
        environment: input.environment,
        atIso: this.deps.nowIso(),
      });
    } catch (error) {
      if (isGovernanceError(error) && error.code === "GOVERNANCE_PROOF_STALE") {
        throw new FederationError(
          "FEDERATION_RATIFICATION_STALE",
          "Ratification proof provenance is stale — fresh ratification required",
          { proofId: input.institutionalAuthorizationProofId },
        );
      }
      this.rethrowProofAsFederation(error, "FEDERATION_AUTHORITY_REQUIRED");
    }
  }

  private async requireActiveCoordinatingAgreement(
    agreementId: string,
  ): Promise<FederationAgreement> {
    const agreement = await this.requireAgreement(agreementId);
    if (agreement.status === "SUSPENDED") {
      throw new FederationError(
        "FEDERATION_SUSPENDED",
        "Agreement suspended — new federation activity denied",
      );
    }
    if (agreement.status === "REVOKED") {
      throw new FederationError(
        "FEDERATION_REVOKED",
        "Agreement revoked — new federation activity denied",
      );
    }
    if (agreement.status !== "ACTIVE") {
      throw new FederationError(
        "FEDERATION_NOT_ACTIVE",
        `Agreement ${agreementId} is ${agreement.status}`,
      );
    }
    const withdrawals =
      await this.deps.participationChanges.listByAgreement(agreementId);
    if (withdrawals.some((w) => w.changeType === "WITHDRAW" || w.changeType === "SUSPEND")) {
      throw new FederationError(
        "FEDERATION_SUSPENDED",
        "Required participant withdrawal blocks new federation activity",
      );
    }
    return agreement;
  }

  private async requireAgreement(
    agreementId: string,
  ): Promise<FederationAgreement> {
    const agreement = await this.deps.agreements.getById(agreementId);
    if (!agreement) {
      throw new FederationError(
        "FEDERATION_NOT_FOUND",
        `Agreement ${agreementId} not found`,
      );
    }
    return agreement;
  }

  private async requireIntent(intentId: string): Promise<FederatedWorkIntent> {
    const intent = await this.deps.intents.getById(intentId);
    if (!intent) {
      throw new FederationError(
        "FEDERATED_INTENT_INVALID",
        `Intent ${intentId} not found`,
      );
    }
    return intent;
  }

  private async requireActiveInstitution(institutionId: string): Promise<void> {
    const institution =
      await this.deps.governance.getInstitution(institutionId);
    if (!institution) {
      throw new FederationError(
        "FEDERATION_PARTICIPANT_INVALID",
        `Institution ${institutionId} not found`,
      );
    }
    if (institution.status !== "ACTIVE") {
      throw new FederationError(
        "FEDERATION_INSTITUTION_INACTIVE",
        `Institution ${institutionId} is ${institution.status}`,
      );
    }
  }

  private async requireFederationRole(input: {
    principalId: string;
    role: FederationRole;
    projectId: string;
    environment: string;
    institutionId: string;
  }): Promise<void> {
    const institution = await this.deps.governance.getInstitution(
      input.institutionId,
    );
    if (!institution?.projectIds.includes(input.projectId)) {
      throw new FederationError(
        "FEDERATION_AUTHORITY_REQUIRED",
        "Project does not belong to institution",
      );
    }
    const grants = await this.deps.canonicalAuthority.listByPrincipal(
      input.principalId,
    );
    const ok = grants.some(
      (g) =>
        g.authorityRole === input.role &&
        g.projectId === input.projectId &&
        g.enabled &&
        g.environmentScope.includes(input.environment),
    );
    if (!ok) {
      throw new FederationError(
        "FEDERATION_AUTHORITY_REQUIRED",
        `${input.role} grant required for ${input.principalId}`,
        { role: input.role, projectId: input.projectId },
      );
    }
  }

  private async assertNoFederationHold(
    projectId: string,
    environment: string,
    atIso: string,
  ): Promise<void> {
    try {
      await this.deps.governance.assertNoActiveHold({
        projectId,
        environment,
        atIso,
      });
    } catch (error) {
      if (isGovernanceError(error)) {
        throw new FederationError(
          "FEDERATION_HOLD_ACTIVE",
          "Local governance hold blocks federation action",
          { code: error.code },
        );
      }
      throw error;
    }
  }

  private async computeFingerprintForFederation(
    federationId: string,
    active: FederationAgreement | null,
  ): Promise<string> {
    if (!active) {
      return createHash("sha256")
        .update(JSON.stringify({ federationId, empty: true }), "utf8")
        .digest("hex");
    }
    const ratifications = await this.deps.ratifications.listByAgreement(
      active.agreementId,
    );
    const participationChanges =
      await this.deps.participationChanges.listByAgreement(active.agreementId);
    return computeFederationStateFingerprint({
      federationId,
      activeAgreement: {
        agreementId: active.agreementId,
        agreementVersion: active.agreementVersion,
        agreementHash: active.agreementHash,
        scopeHash: active.scopeHash,
        status: active.status,
      },
      agreement: active,
      ratifications,
      participationChanges,
    });
  }

  private async audit(
    eventType: FederationAuditEventType,
    input: {
      federationId: string;
      agreementId?: string;
      intentId?: string;
      institutionId?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    const event: FederationAuditEvent = {
      auditEventId: randomUUID(),
      eventType,
      federationId: input.federationId,
      ...(input.agreementId !== undefined
        ? { agreementId: input.agreementId }
        : {}),
      ...(input.intentId !== undefined ? { intentId: input.intentId } : {}),
      ...(input.institutionId !== undefined
        ? { institutionId: input.institutionId }
        : {}),
      payload: input.payload,
      createdAt: this.deps.nowIso(),
    };
    await this.deps.audits.append(event);
  }

  private rethrowProofAsFederation(
    error: unknown,
    code:
      | "FEDERATION_AUTHORITY_REQUIRED"
      | "FEDERATED_ACCEPTANCE_DENIED"
      | "FEDERATION_RATIFICATION_STALE",
  ): never {
    if (isGovernanceError(error)) {
      if (error.code === "GOVERNANCE_PROOF_STALE") {
        throw new FederationError(
          code === "FEDERATED_ACCEPTANCE_DENIED"
            ? "FEDERATED_ACCEPTANCE_DENIED"
            : "FEDERATION_RATIFICATION_STALE",
          error.message,
          { governanceCode: error.code },
        );
      }
      throw new FederationError(code, error.message, {
        governanceCode: error.code,
      });
    }
    throw error;
  }
}

/** Ensure FEDERATION_ACTIONS stays exhaustively handled in doctrine helpers. */
export function listSupportedFederationActions(): readonly FederationAction[] {
  return FEDERATION_ACTIONS;
}
