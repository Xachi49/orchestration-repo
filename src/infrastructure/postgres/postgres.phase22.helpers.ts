import type { PostgresDatabase } from "./database.js";
import type { PostgresOrchestratorStack } from "./stack.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import type { AuthorityGrantSeed } from "./repositories/authority-directory.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import { compileRatificationSubjectBinding } from "../../federation/ratification.js";
import { compileWorkAcceptanceSubjectBinding } from "../../federation/work-acceptance.js";
import { compileWithdrawalSubjectBinding } from "../../federation/participation.js";
import type { FederationScope } from "../../federation/scope.js";

export const P22_NEGOTIATOR_A = "fed_negotiator_a_p22";
export const P22_RATIFIER_A = "fed_ratifier_a_p22";
export const P22_RATIFIER_B = "fed_ratifier_b_p22";
export const P22_RATIFIER_C = "fed_ratifier_c_p22";
export const P22_ACCEPTOR_B = "fed_acceptor_b_p22";
export const P22_EVIDENCE_A = "fed_evidence_a_p22";
export const P22_REQUESTER_B = "fed_requester_b_p22";
export const P22_GOV_ADMIN = "gov_admin_p22";

export type P22TestEnv = {
  db: PostgresDatabase;
  stack: PostgresOrchestratorStack;
  close: () => Promise<void>;
};

export async function seedP22Authority(
  db: PostgresDatabase,
  projectId: string,
  extra: Array<{
    principalId: string;
    principalType: AuthorityGrantSeed["principalType"];
  }> = [],
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  await authority.seed([
    {
      principalId: P22_GOV_ADMIN,
      principalType: "GOVERNANCE_ADMIN",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_NEGOTIATOR_A,
      principalType: "FEDERATION_NEGOTIATOR",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_RATIFIER_A,
      principalType: "FEDERATION_RATIFIER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_RATIFIER_B,
      principalType: "FEDERATION_RATIFIER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_RATIFIER_C,
      principalType: "FEDERATION_RATIFIER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_ACCEPTOR_B,
      principalType: "FEDERATION_WORK_ACCEPTOR",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_EVIDENCE_A,
      principalType: "FEDERATION_EVIDENCE_SHARER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P22_REQUESTER_B,
      principalType: "REQUESTER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    ...extra.map((p) => ({
      principalId: p.principalId,
      principalType: p.principalType,
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    })),
  ]);
}

export async function createP22ConcurrentStack(
  db: PostgresDatabase,
  suffix: string,
  opts?: {
    federationActivationFailpoint?: {
      name: string;
      trigger: () => void;
    };
  },
): Promise<PostgresOrchestratorStack> {
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId: uniquePostgresTestId(`p22-stack-${suffix}`),
    seedControlPlane: false,
    ...(opts?.federationActivationFailpoint !== undefined
      ? {
          federationActivationFailpoint: opts.federationActivationFailpoint,
        }
      : {}),
  });
  return {
    ...stack,
    close: async () => undefined,
  };
}

export async function createP22Env(
  suffix: string,
  opts?: {
    federationActivationFailpoint?: {
      name: string;
      trigger: () => void;
    };
  },
): Promise<P22TestEnv> {
  const { createTestDatabase } = await import("./test-helpers.js");
  const db = await createTestDatabase(uniquePostgresTestId(`p22-${suffix}`));
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId: uniquePostgresTestId(`p22-main-${suffix}`),
    seedControlPlane: false,
    ...(opts?.federationActivationFailpoint !== undefined
      ? {
          federationActivationFailpoint: opts.federationActivationFailpoint,
        }
      : {}),
  });
  return {
    db,
    stack,
    close: async () => {
      await stack.close();
    },
  };
}

export function p22BilateralScope(input: {
  institutionA: string;
  institutionB: string;
  projectA: string;
  projectB: string;
  environment?: string;
  effectiveFrom: string;
  effectiveUntil?: string;
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
    permittedEnvironments: [input.environment ?? EXAMPLE_ENVIRONMENT],
    permittedIntentKinds: ["OBJECTIVE"],
    evidenceSharingClasses: ["INTERNAL"],
    maximumResourceRequest: { cpuMillis: 5000, memoryMb: 1024 },
    effectiveFrom: input.effectiveFrom,
    ...(input.effectiveUntil !== undefined
      ? { effectiveUntil: input.effectiveUntil }
      : {}),
  };
}

export async function p22OpenProof(
  stack: PostgresOrchestratorStack,
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
    expiresAt: string;
    effectiveFrom: string;
  },
): Promise<string> {
  const mandate = await stack.governanceService.createMandate({
    institutionId: input.institutionId,
    createdBy: P22_GOV_ADMIN,
    subjectClasses: [input.subjectType],
    requiredAuthorities: [input.requiredRole],
    projectScope: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    effectiveFrom: input.effectiveFrom,
  });
  await stack.governanceService.activateMandate({
    mandateId: mandate.mandateId,
    actorPrincipalId: P22_GOV_ADMIN,
  });
  const opened = await stack.governanceService.openGovernanceCase({
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    subjectHash: input.subjectHash,
    ...(input.subjectVersion !== undefined
      ? { subjectVersion: input.subjectVersion }
      : {}),
    requiredRole: input.requiredRole,
    action: input.action,
    projectIds: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    mandateIds: [mandate.mandateId],
    expiresAt: input.expiresAt,
  });
  const attested = await stack.governanceService.attest({
    governanceCaseId: opened.governanceCaseId,
    principalId: input.attestorPrincipalId,
    authorityRole: input.requiredRole,
    decision: "APPROVE",
    nonce: `p22_${input.subjectId}_${input.attestorPrincipalId}_${Date.now()}`,
  });
  if (!attested.proof) {
    throw new Error("Expected institutional proof");
  }
  return attested.proof.institutionalAuthorizationProofId;
}

export async function p22Ratify(
  stack: PostgresOrchestratorStack,
  input: {
    agreementId: string;
    institutionId: string;
    projectId: string;
    ratifierPrincipalId: string;
    effectiveFrom: string;
    expiresAt: string;
  },
): Promise<void> {
  const agreement = await stack.federationService.getAgreement(input.agreementId);
  const subject = compileRatificationSubjectBinding({
    federationId: agreement.federationId,
    agreementId: agreement.agreementId,
    agreementVersion: agreement.agreementVersion,
    agreementHash: agreement.agreementHash,
    participantSetHash: agreement.participantSetHash,
    scopeHash: agreement.scopeHash,
    institutionId: input.institutionId,
  });
  const proofId = await p22OpenProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    subjectVersion: subject.subjectVersion,
    attestorPrincipalId: input.ratifierPrincipalId,
    effectiveFrom: input.effectiveFrom,
    expiresAt: input.expiresAt,
  });
  await stack.federationService.ratify({
    agreementId: input.agreementId,
    institutionId: input.institutionId,
    ratifierPrincipalId: input.ratifierPrincipalId,
    institutionalAuthorizationProofId: proofId,
    projectId: input.projectId,
    environment: EXAMPLE_ENVIRONMENT,
  });
}

export async function p22Accept(
  stack: PostgresOrchestratorStack,
  input: {
    intentId: string;
    institutionId: string;
    projectId: string;
    acceptorPrincipalId: string;
    effectiveFrom: string;
    expiresAt: string;
  },
): Promise<void> {
  const intentRow = await stack.db.query<{ payload: unknown }>(
    `SELECT payload FROM federated_work_intents WHERE intent_id = $1`,
    [input.intentId],
  );
  const intent = intentRow.rows[0]?.payload as {
    intentId: string;
    intentHash: string;
    agreementId: string;
    targetInstitutionId: string;
    targetProjectId: string;
    requestedEnvironment: string;
    federationId: string;
  };
  if (!intent) throw new Error("intent missing");
  const agreement = await stack.federationService.getAgreement(intent.agreementId);
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
  const proofId = await p22OpenProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    attestorPrincipalId: input.acceptorPrincipalId,
    effectiveFrom: input.effectiveFrom,
    expiresAt: input.expiresAt,
  });
  await stack.federationService.acceptWork({
    intentId: input.intentId,
    actorPrincipalId: input.acceptorPrincipalId,
    institutionalAuthorizationProofId: proofId,
    projectId: input.projectId,
    environment: EXAMPLE_ENVIRONMENT,
  });
}

export async function p22Withdraw(
  stack: PostgresOrchestratorStack,
  input: {
    agreementId: string;
    institutionId: string;
    projectId: string;
    actorPrincipalId: string;
    effectiveFrom: string;
    expiresAt: string;
  },
): Promise<void> {
  const agreement = await stack.federationService.getAgreement(input.agreementId);
  const subject = compileWithdrawalSubjectBinding({
    federationId: agreement.federationId,
    agreementId: agreement.agreementId,
    agreementVersion: agreement.agreementVersion,
    agreementHash: agreement.agreementHash,
    institutionId: input.institutionId,
  });
  const proofId = await p22OpenProof(stack, {
    institutionId: input.institutionId,
    projectId: input.projectId,
    requiredRole: subject.requiredRole,
    action: subject.action,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
    subjectHash: subject.subjectHash,
    subjectVersion: subject.subjectVersion,
    attestorPrincipalId: input.actorPrincipalId,
    effectiveFrom: input.effectiveFrom,
    expiresAt: input.expiresAt,
  });
  await stack.federationService.withdraw({
    agreementId: input.agreementId,
    institutionId: input.institutionId,
    actorPrincipalId: input.actorPrincipalId,
    institutionalAuthorizationProofId: proofId,
    projectId: input.projectId,
    environment: EXAMPLE_ENVIRONMENT,
  });
}

export function p22LifecycleFromAnchor(anchorIso: string): {
  proposedAt: string;
  ratifiedAAt: string;
  ratifiedBAt: string;
  activationAt: string;
  intentCreatedAt: string;
  acceptedAt: string;
  materializedAt: string;
  withdrawalEffectiveAt: string;
  caseExpiresAt: string;
  farFuture: string;
} {
  const t0 = Date.parse(anchorIso);
  const at = (ms: number) => new Date(t0 + ms).toISOString();
  return {
    proposedAt: at(0),
    ratifiedAAt: at(60_000),
    ratifiedBAt: at(120_000),
    activationAt: at(180_000),
    intentCreatedAt: at(240_000),
    acceptedAt: at(300_000),
    materializedAt: at(360_000),
    withdrawalEffectiveAt: at(420_000),
    caseExpiresAt: at(86_400_000 * 30),
    farFuture: at(86_400_000 * 365),
  };
}
