import {
  buildGovernanceService,
  DEFAULT_ROLE_GRANTS,
  GOV_ENV_STAGING,
  GOV_PROJECT_ID,
  GOV_TEST_NOW,
  PRINCIPALS,
  seedCanonicalAuthority,
  seedDefaultRoleGrants,
  seedInstitution,
  type GovernanceTestStack,
} from "../governance/test-fixtures.js";
import {
  ConstitutionalChangeOrchestrationService,
  InMemoryConstitutionalActivationRecordRepository,
  InMemoryConstitutionalAuditRepository,
  InMemoryConstitutionalImpactAnalysisRepository,
  InMemoryConstitutionalProposalRepository,
  InMemoryConstitutionalReviewDecisionRepository,
  type ConstitutionalChangeOrchestrationDeps,
} from "./index.js";
import { compileReviewSubjectBinding, compileActivationSubjectBinding } from "./review.js";
import { createInMemoryInstitutionActivationRunner } from "./test-transaction.js";

export const CONST_PRINCIPALS = {
  ...PRINCIPALS,
  constitutionalReviewer: "constitutional_reviewer",
  constitutionalReviewerB: "constitutional_reviewer_b",
  constitutionalReviewerC: "constitutional_reviewer_c",
  constitutionalActivator: "constitutional_activator",
} as const;

export const EXTRA_CONSTITUTIONAL_ROLE_GRANTS = [
  {
    principalId: CONST_PRINCIPALS.constitutionalReviewer,
    authorityRole: "CONSTITUTIONAL_REVIEWER",
  },
  {
    principalId: CONST_PRINCIPALS.constitutionalReviewerB,
    authorityRole: "CONSTITUTIONAL_REVIEWER",
  },
  {
    principalId: CONST_PRINCIPALS.constitutionalReviewerC,
    authorityRole: "CONSTITUTIONAL_REVIEWER",
  },
  {
    principalId: CONST_PRINCIPALS.constitutionalActivator,
    authorityRole: "CONSTITUTIONAL_ACTIVATOR",
  },
] as const;

export interface ConstitutionalTestStack extends GovernanceTestStack {
  constitutional: ConstitutionalChangeOrchestrationService;
  constitutionalDeps: ConstitutionalChangeOrchestrationDeps;
}

export function buildConstitutionalService(
  overrides: Partial<ConstitutionalChangeOrchestrationDeps> = {},
  options?: { mutableClock?: boolean; transactionalActivation?: boolean },
): ConstitutionalTestStack {
  const gov = buildGovernanceService(
    options?.mutableClock ? { mutableClock: true } : undefined,
  );
  const proposals = new InMemoryConstitutionalProposalRepository();
  const impactAnalyses = new InMemoryConstitutionalImpactAnalysisRepository();
  const reviewDecisions = new InMemoryConstitutionalReviewDecisionRepository();
  const activationRecords = new InMemoryConstitutionalActivationRecordRepository();
  const audits = new InMemoryConstitutionalAuditRepository();
  const stackRef: { current?: ConstitutionalTestStack } = {};
  const constitutionalDeps: ConstitutionalChangeOrchestrationDeps = {
    nowIso: gov.nowIso,
    proposals,
    impactAnalyses,
    reviewDecisions,
    activationRecords,
    audits,
    governance: gov.service,
    canonicalAuthority: gov.canonicalAuthority,
    isGovernanceAdmin: async (principalId, _institutionId, projectIds) => {
      const held = new Set([GOV_PROJECT_ID]);
      return (
        principalId === PRINCIPALS.govAdmin &&
        projectIds.every((p) => held.has(p))
      );
    },
    ...overrides,
  };
  const constitutional = new ConstitutionalChangeOrchestrationService(
    constitutionalDeps,
  );
  const stack: ConstitutionalTestStack = { ...gov, constitutional, constitutionalDeps };
  stackRef.current = stack;
  if (options?.transactionalActivation && !overrides.runInstitutionActivation) {
    constitutionalDeps.runInstitutionActivation =
      createInMemoryInstitutionActivationRunner(stack);
  }
  return stack;
}

export async function seedConstitutionalInstitution(
  stack: ConstitutionalTestStack,
): Promise<{
  institutionId: string;
  constitutionalMandateId: string;
}> {
  const institution = await seedInstitution(stack.service);
  const constitutionalMandate = await stack.service.createMandate({
    institutionId: institution.institutionId,
    createdBy: PRINCIPALS.govAdmin,
    subjectClasses: ["CONSTITUTIONAL_CHANGE"],
    requiredAuthorities: ["CONSTITUTIONAL_REVIEWER", "CONSTITUTIONAL_ACTIVATOR"],
    projectScope: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
    quorumRequirement: {
      kind: "K_OF_N",
      k: 1,
      n: 3,
      roles: ["CONSTITUTIONAL_REVIEWER"],
      rejectBlocksImmediately: false,
    },
  });
  const activeConstitutionalMandate = await stack.service.activateMandate({
    mandateId: constitutionalMandate.mandateId,
    actorPrincipalId: PRINCIPALS.govAdmin,
  });
  await stack.constitutional.enableConstitutionalControl({
    institutionId: institution.institutionId,
    actorPrincipalId: PRINCIPALS.govAdmin,
  });
  return {
    institutionId: institution.institutionId,
    constitutionalMandateId: activeConstitutionalMandate.mandateId,
  };
}

export async function seedConstitutionalAuthority(
  stack: ConstitutionalTestStack,
): Promise<void> {
  await seedDefaultRoleGrants(stack.canonicalAuthority);
  await seedCanonicalAuthority(stack.canonicalAuthority, {
    principalId: PRINCIPALS.govAdmin,
    authorityRole: "GOVERNANCE_ADMIN",
  });
  for (const row of EXTRA_CONSTITUTIONAL_ROLE_GRANTS) {
    if (
      !DEFAULT_ROLE_GRANTS.some(
        (d) =>
          d.principalId === row.principalId &&
          d.authorityRole === row.authorityRole,
      )
    ) {
      await seedCanonicalAuthority(stack.canonicalAuthority, row);
    }
  }
}

export const CONST_CASE_EXPIRES = "2026-06-01T00:00:00.000Z";

export async function seedHighQuorumConstitutionalMandate(
  stack: ConstitutionalTestStack,
  institutionId: string,
): Promise<string> {
  const draft = await stack.service.createMandate({
    institutionId,
    createdBy: PRINCIPALS.govAdmin,
    subjectClasses: ["CONSTITUTIONAL_CHANGE"],
    requiredAuthorities: ["CONSTITUTIONAL_REVIEWER", "CONSTITUTIONAL_ACTIVATOR"],
    projectScope: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
    quorumRequirement: {
      kind: "K_OF_N",
      k: 3,
      n: 5,
      roles: ["CONSTITUTIONAL_REVIEWER"],
      rejectBlocksImmediately: false,
    },
    separationOfDutyRules: [
      {
        ruleId: "sod_reviewer_admin",
        kind: "FORBID_SAME_PRINCIPAL",
        roleA: "CONSTITUTIONAL_REVIEWER",
        roleB: "GOVERNANCE_ADMIN",
        notes: "Reviewer cannot be proposer admin",
      },
    ],
  });
  const active = await stack.service.activateMandate({
    mandateId: draft.mandateId,
    actorPrincipalId: PRINCIPALS.govAdmin,
  });
  return active.mandateId;
}

export async function attestConstitutionalReview(input: {
  stack: ConstitutionalTestStack;
  proposal: {
    constitutionalChangeProposalId: string;
    proposalVersion: number;
    proposalHash: string;
  };
  constitutionalMandateId: string;
  reviewerPrincipalId: string;
  nonce: string;
  governanceCaseId?: string;
  sharedProofId?: string;
}): Promise<{
  proofId: string;
  decisionId: string;
  governanceCaseId: string;
}> {
  let governanceCaseId = input.governanceCaseId;
  let proofId = input.sharedProofId;

  if (!proofId) {
    const reviewBinding = compileReviewSubjectBinding({
      proposalId: input.proposal.constitutionalChangeProposalId,
      proposalVersion: input.proposal.proposalVersion,
      proposalHash: input.proposal.proposalHash,
    });
    if (!governanceCaseId) {
      const reviewCase = await input.stack.service.openGovernanceCase({
        ...reviewBinding,
        action: "CONSTITUTIONAL_REVIEW",
        projectIds: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
        mandateIds: [input.constitutionalMandateId],
        expiresAt: CONST_CASE_EXPIRES,
      });
      governanceCaseId = reviewCase.governanceCaseId;
    }
    const reviewAttest = await input.stack.service.attest({
      governanceCaseId: governanceCaseId!,
      principalId: input.reviewerPrincipalId,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: input.nonce,
    });
    if (reviewAttest.proof) {
      proofId = reviewAttest.proof.institutionalAuthorizationProofId;
    }
  }

  if (!proofId) {
    return {
      proofId: "",
      decisionId: "",
      governanceCaseId: governanceCaseId!,
    };
  }

  const decision = await input.stack.constitutional.recordReviewDecision({
    proposalId: input.proposal.constitutionalChangeProposalId,
    reviewerPrincipalId: input.reviewerPrincipalId,
    institutionalAuthorizationProofId: proofId,
    decision: "APPROVE",
    projectId: GOV_PROJECT_ID,
    environment: GOV_ENV_STAGING,
  });
  return {
    proofId,
    decisionId: decision.decisionId,
    governanceCaseId: governanceCaseId!,
  };
}

export async function stageConstitutionalActivation(input: {
  stack: ConstitutionalTestStack;
  proposal: {
    constitutionalChangeProposalId: string;
    proposalVersion: number;
    proposalHash: string;
  };
  constitutionalMandateId: string;
  reviewDecisionId: string;
  activatorPrincipalId?: string;
  nonce?: string;
}): Promise<{
  activationRecordId: string;
  activationProofId: string;
}> {
  const activator =
    input.activatorPrincipalId ?? CONST_PRINCIPALS.constitutionalActivator;
  const activationBinding = compileActivationSubjectBinding({
    proposalId: input.proposal.constitutionalChangeProposalId,
    proposalVersion: input.proposal.proposalVersion,
    proposalHash: input.proposal.proposalHash,
  });
  const activationCase = await input.stack.service.openGovernanceCase({
    ...activationBinding,
    action: "CONSTITUTIONAL_ACTIVATION",
    projectIds: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
    mandateIds: [input.constitutionalMandateId],
    expiresAt: CONST_CASE_EXPIRES,
  });
  const activationAttest = await input.stack.service.attest({
    governanceCaseId: activationCase.governanceCaseId,
    principalId: activator,
    authorityRole: "CONSTITUTIONAL_ACTIVATOR",
    decision: "APPROVE",
    nonce:
      input.nonce ??
      `nonce-activation-${input.proposal.constitutionalChangeProposalId}`,
  });
  const staged = await input.stack.constitutional.stageActivation({
    proposalId: input.proposal.constitutionalChangeProposalId,
    activatorPrincipalId: activator,
    institutionalAuthorizationProofId:
      activationAttest.proof!.institutionalAuthorizationProofId,
    reviewDecisionId: input.reviewDecisionId,
    projectId: GOV_PROJECT_ID,
    environment: GOV_ENV_STAGING,
  });
  return {
    activationRecordId: staged.activationRecordId,
    activationProofId: activationAttest.proof!.institutionalAuthorizationProofId,
  };
}

export {
  GOV_ENV_STAGING,
  GOV_PROJECT_ID,
  GOV_TEST_NOW,
  PRINCIPALS,
  seedCanonicalAuthority,
  seedInstitution,
} from "../governance/test-fixtures.js";

export function anchorIso(): string {
  return GOV_TEST_NOW;
}
