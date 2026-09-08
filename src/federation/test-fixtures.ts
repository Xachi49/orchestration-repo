import {
  buildGovernanceService,
  GOV_ENV_STAGING,
  GOV_FAR_FUTURE,
  GOV_PROJECT_ID,
  GOV_TEST_NOW,
  PRINCIPALS,
  seedCanonicalAuthority,
  seedDefaultRoleGrants,
  type GovernanceTestStack,
} from "../governance/test-fixtures.js";
import type { AdmissionResult } from "../admission/result.js";
import {
  InMemoryFederationActivationRecordRepository,
  InMemoryFederationAgreementRepository,
  InMemoryFederationAuditRepository,
  InMemoryFederationParticipationChangeRepository,
  InMemoryFederationRatificationRepository,
  InMemoryFederatedEvidenceEnvelopeRepository,
  InMemoryFederatedMaterializationRepository,
  InMemoryFederatedWorkAcceptanceRepository,
  InMemoryFederatedWorkIntentRepository,
} from "./memory-repositories.js";
import {
  FederationOrchestrationService,
  type FederationOrchestrationDeps,
} from "./service.js";
import { createInMemoryFederationActivationRunner } from "./test-transaction.js";
import type { FederationScope } from "./scope.js";
import { compileRatificationSubjectBinding } from "./ratification.js";
import { compileWorkAcceptanceSubjectBinding } from "./work-acceptance.js";

export const FED_PRINCIPALS = {
  ...PRINCIPALS,
  negotiatorA: "fed_negotiator_a",
  ratifierA: "fed_ratifier_a",
  acceptorA: "fed_acceptor_a",
  acceptorB: "fed_acceptor_b",
  ratifierB: "fed_ratifier_b",
  evidenceA: "fed_evidence_a",
  requesterB: "fed_requester_b",
} as const;

export const FED_PROJECT_A = "proj_fed_a";
export const FED_PROJECT_B = "proj_fed_b";
export const FED_PROJECT_C = "proj_fed_c";

export const FEDERATION_ROLE_GRANTS = [
  {
    principalId: FED_PRINCIPALS.negotiatorA,
    authorityRole: "FEDERATION_NEGOTIATOR",
  },
  {
    principalId: FED_PRINCIPALS.ratifierA,
    authorityRole: "FEDERATION_RATIFIER",
  },
  {
    principalId: FED_PRINCIPALS.ratifierB,
    authorityRole: "FEDERATION_RATIFIER",
  },
  {
    principalId: FED_PRINCIPALS.acceptorB,
    authorityRole: "FEDERATION_WORK_ACCEPTOR",
  },
  {
    principalId: FED_PRINCIPALS.evidenceA,
    authorityRole: "FEDERATION_EVIDENCE_SHARER",
  },
] as const;

export const FED_CASE_EXPIRES = "2026-06-01T00:00:00.000Z";

export interface FederationTestStack extends GovernanceTestStack {
  federation: FederationOrchestrationService;
  federationDeps: FederationOrchestrationDeps;
  admitCalls: unknown[];
}

export function buildFederationService(options?: {
  mutableClock?: boolean;
  transactionalActivation?: boolean;
  admit?: (input: unknown) => Promise<AdmissionResult>;
}): FederationTestStack {
  const adminGrants = new Map<string, ReadonlySet<string>>([
    [
      PRINCIPALS.govAdmin,
      new Set([GOV_PROJECT_ID, FED_PROJECT_A, FED_PROJECT_B, FED_PROJECT_C]),
    ],
  ]);
  const gov = buildGovernanceService({
    mutableClock: options?.mutableClock !== false,
    adminGrants,
  });

  const agreements = new InMemoryFederationAgreementRepository();
  const ratifications = new InMemoryFederationRatificationRepository();
  const activationRecords = new InMemoryFederationActivationRecordRepository();
  const participationChanges =
    new InMemoryFederationParticipationChangeRepository();
  const intents = new InMemoryFederatedWorkIntentRepository();
  const acceptances = new InMemoryFederatedWorkAcceptanceRepository();
  const materializations = new InMemoryFederatedMaterializationRepository();
  const evidence = new InMemoryFederatedEvidenceEnvelopeRepository();
  const audits = new InMemoryFederationAuditRepository();
  const admitCalls: unknown[] = [];

  const federationDeps: FederationOrchestrationDeps = {
    nowIso: gov.nowIso,
    agreements,
    ratifications,
    activationRecords,
    participationChanges,
    intents,
    acceptances,
    materializations,
    evidence,
    audits,
    governance: gov.service,
    canonicalAuthority: gov.canonicalAuthority,
    admission: {
      admit: async (input: unknown) => {
        admitCalls.push(input);
        if (options?.admit) return options.admit(input);
        const req = input as {
          projectId: string;
          objectiveId: string;
        };
        return {
          outcome: "ADMITTED" as const,
          runId: `run_fed_${req.objectiveId}`,
          state: "ADMITTED" as const,
          eventEnvelope: {
            eventId: "evt_fed",
            eventType: "PROJECT_OBJECTIVE_SUBMITTED",
            eventVersion: "1",
            runId: `run_fed_${req.objectiveId}`,
            correlationId: "corr_fed",
            causationId: "cause_fed",
            idempotencyKey: `idem_${req.objectiveId}`,
            projectId: req.projectId,
            objectiveId: req.objectiveId,
            objectiveVersion: 1,
            traceId: "trace_fed",
            createdAt: gov.nowIso(),
            expiresAt: "2027-01-01T00:00:00.000Z",
            schemaVersion: "1",
            data: {},
          },
          controlContextReference: {
            projectId: req.projectId,
            environment: GOV_ENV_STAGING,
            policyBundleId: "pol_test",
            budgetProfileId: "bud_test",
            resolvedAt: gov.nowIso(),
          },
          idempotencyKey: `idem_${req.objectiveId}`,
          correlationId: "corr_fed",
          traceId: "trace_fed",
        } satisfies AdmissionResult;
      },
    },
  };

  const federation = new FederationOrchestrationService(federationDeps);
  const stack: FederationTestStack = {
    ...gov,
    federation,
    federationDeps,
    admitCalls,
  };

  if (options?.transactionalActivation !== false) {
    federationDeps.runFederationActivation =
      createInMemoryFederationActivationRunner(stack);
  }

  return stack;
}

export async function seedFederationAuthority(
  stack: FederationTestStack,
  projectIds: readonly string[] = [
    GOV_PROJECT_ID,
    FED_PROJECT_A,
    FED_PROJECT_B,
    FED_PROJECT_C,
  ],
): Promise<void> {
  await seedDefaultRoleGrants(stack.canonicalAuthority);
  await seedCanonicalAuthority(stack.canonicalAuthority, {
    principalId: PRINCIPALS.govAdmin,
    authorityRole: "GOVERNANCE_ADMIN",
  });
  for (const projectId of projectIds) {
    for (const g of FEDERATION_ROLE_GRANTS) {
      await seedCanonicalAuthority(stack.canonicalAuthority, {
        principalId: g.principalId,
        authorityRole: g.authorityRole,
        projectId,
        environmentScope: [GOV_ENV_STAGING],
      });
    }
  }
}

export async function seedBilateralInstitutions(
  stack: FederationTestStack,
): Promise<{
  institutionA: string;
  institutionB: string;
  projectA: string;
  projectB: string;
}> {
  await seedFederationAuthority(stack);
  const instA = await stack.service.createInstitution({
    name: "Federation Institution A",
    projectIds: [FED_PROJECT_A],
  });
  const instB = await stack.service.createInstitution({
    name: "Federation Institution B",
    projectIds: [FED_PROJECT_B],
  });
  return {
    institutionA: instA.institutionId,
    institutionB: instB.institutionId,
    projectA: FED_PROJECT_A,
    projectB: FED_PROJECT_B,
  };
}

export function bilateralScope(input: {
  institutionA: string;
  institutionB: string;
  projectA: string;
  projectB: string;
  effectiveFrom?: string;
}): FederationScope {
  return {
    participantInstitutionIds: [input.institutionA, input.institutionB],
    permittedPairs: [
      {
        sourceInstitutionId: input.institutionA,
        targetInstitutionId: input.institutionB,
      },
    ],
    permittedSourceProjectIds: [input.projectA],
    permittedTargetProjectIds: [input.projectB],
    permittedEnvironments: [GOV_ENV_STAGING],
    permittedIntentKinds: ["OBJECTIVE"],
    evidenceSharingClasses: ["INTERNAL"],
    maximumResourceRequest: { cpuMillis: 1000, memoryMb: 512 },
    effectiveFrom: input.effectiveFrom ?? GOV_TEST_NOW,
    effectiveUntil: GOV_FAR_FUTURE,
  };
}

export async function openFederationCaseAndProof(
  stack: FederationTestStack,
  input: {
    institutionId: string;
    projectId: string;
    requiredRole: string;
    action: string;
    subjectType: string;
    subjectId: string;
    subjectHash: string;
    subjectVersion?: number;
    attestorPrincipalId: string;
    nonce?: string;
  },
): Promise<{ proofId: string; proofHash: string; mandateId: string }> {
  if ("advanceMs" in stack.clock && typeof stack.clock.advanceMs === "function") {
    stack.clock.advanceMs(1_000);
  }
  const mandate = await stack.service.createMandate({
    institutionId: input.institutionId,
    createdBy: PRINCIPALS.govAdmin,
    subjectClasses: [input.subjectType],
    requiredAuthorities: [input.requiredRole],
    projectScope: [input.projectId],
    environmentScope: [GOV_ENV_STAGING],
    effectiveFrom: GOV_TEST_NOW,
  });
  await stack.service.activateMandate({
    mandateId: mandate.mandateId,
    actorPrincipalId: PRINCIPALS.govAdmin,
  });

  const opened = await stack.service.openGovernanceCase({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectHash: input.subjectHash,
    ...(input.subjectVersion !== undefined
      ? { subjectVersion: input.subjectVersion }
      : {}),
    requiredRole: input.requiredRole,
    action: input.action,
    projectIds: [input.projectId],
    environmentScope: [GOV_ENV_STAGING],
    mandateIds: [mandate.mandateId],
    expiresAt: FED_CASE_EXPIRES,
  });

  const attested = await stack.service.attest({
    governanceCaseId: opened.governanceCaseId,
    principalId: input.attestorPrincipalId,
    authorityRole: input.requiredRole,
    decision: "APPROVE",
    nonce: input.nonce ?? `nonce_${input.subjectId}_${input.attestorPrincipalId}`,
  });

  if (!attested.proof) {
    throw new Error("Expected proof from attestation");
  }
  return {
    proofId: attested.proof.institutionalAuthorizationProofId,
    proofHash: attested.proof.proofHash,
    mandateId: mandate.mandateId,
  };
}

export async function ratifyWithProof(
  stack: FederationTestStack,
  input: {
    agreementId: string;
    institutionId: string;
    projectId: string;
    ratifierPrincipalId: string;
  },
): Promise<{ proofId: string }> {
  const agreement = await stack.federation.getAgreement(input.agreementId);
  const subject = compileRatificationSubjectBinding({
    federationId: agreement.federationId,
    agreementId: agreement.agreementId,
    agreementVersion: agreement.agreementVersion,
    agreementHash: agreement.agreementHash,
    participantSetHash: agreement.participantSetHash,
    scopeHash: agreement.scopeHash,
    institutionId: input.institutionId,
  });
  const { proofId } = await openFederationCaseAndProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    subjectVersion: subject.subjectVersion,
    attestorPrincipalId: input.ratifierPrincipalId,
  });
  await stack.federation.ratify({
    agreementId: input.agreementId,
    institutionId: input.institutionId,
    ratifierPrincipalId: input.ratifierPrincipalId,
    institutionalAuthorizationProofId: proofId,
    projectId: input.projectId,
    environment: GOV_ENV_STAGING,
  });
  return { proofId };
}

export async function acceptWithProof(
  stack: FederationTestStack,
  input: {
    intentId: string;
    institutionId: string;
    projectId: string;
    acceptorPrincipalId: string;
  },
): Promise<void> {
  const intent = await stack.federationDeps.intents.getById(input.intentId);
  if (!intent) throw new Error("intent missing");
  const agreement = await stack.federation.getAgreement(intent.agreementId);
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
  const { proofId } = await openFederationCaseAndProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    attestorPrincipalId: input.acceptorPrincipalId,
  });
  await stack.federation.acceptWork({
    intentId: input.intentId,
    actorPrincipalId: input.acceptorPrincipalId,
    institutionalAuthorizationProofId: proofId,
    projectId: input.projectId,
    environment: GOV_ENV_STAGING,
  });
}

export {
  GOV_ENV_STAGING,
  GOV_FAR_FUTURE,
  GOV_PROJECT_ID,
  GOV_TEST_NOW,
  PRINCIPALS,
};
