import type { PostgresDatabase } from "./database.js";
import type { PostgresOrchestratorStack } from "./stack.js";
import { createPostgresOrchestratorStack } from "./stack.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { PostgresAuthorityDirectory } from "./repositories/authority-directory.js";
import {
  compileActivationSubjectBinding,
  compileReviewSubjectBinding,
} from "../../constitutional/review.js";
import {
  computeGovernanceStateFingerprint,
  selectConstitutionalRoleGrants,
} from "../../constitutional/fingerprint.js";
import type { AuthorityGrantSeed } from "./repositories/authority-directory.js";
import {
  CanonicalAuthorityGrantSchema,
  type CanonicalAuthorityGrant,
} from "../../governance/canonical-authority.js";
import type { GovernanceQuorumRequirement } from "../../governance/quorum.js";
import type { SeparationOfDutyRule } from "../../governance/separation.js";
import { isConstitutionalError } from "../../constitutional/errors.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import { buildServer } from "../../api/server.js";
import { FakeRequestAuthenticator } from "../../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../../runtime/access.js";
import { DrainController } from "../../runtime/startup.js";
import { OperationalMetrics } from "../../runtime/metrics.js";
import { MemoryStructuredLogger } from "../../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../../runtime/rate-limit.js";

export const P21_GOV_ADMIN = "gov_admin_p21";
export const P21_REVIEWER_A = "constitutional_reviewer_a_p21";
export const P21_REVIEWER_B = "constitutional_reviewer_b_p21";
export const P21_REVIEWER_C = "constitutional_reviewer_c_p21";
export const P21_ACTIVATOR = "constitutional_activator_p21";

export type P21TestEnv = {
  db: PostgresDatabase;
  stack: PostgresOrchestratorStack;
  close: () => Promise<void>;
};

export interface PreparedProposal {
  institutionId: string;
  projectId: string;
  mandateId: string;
  proposalId: string;
  proposalHash: string;
  proposalVersion: number;
  baseFingerprint: string;
  reviewDecisionId: string;
  activationRecordId: string;
  activationProofId: string;
  orgUnitName: string;
}

export async function seedP21Authority(
  db: PostgresDatabase,
  projectId: string,
  extraPrincipals: Array<{
    principalId: string;
    principalType: AuthorityGrantSeed["principalType"];
  }> = [],
): Promise<void> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const authority = new PostgresAuthorityDirectory(db);
  await authority.seed([
    {
      principalId: P21_GOV_ADMIN,
      principalType: "GOVERNANCE_ADMIN",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P21_REVIEWER_A,
      principalType: "CONSTITUTIONAL_REVIEWER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P21_REVIEWER_B,
      principalType: "CONSTITUTIONAL_REVIEWER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P21_REVIEWER_C,
      principalType: "CONSTITUTIONAL_REVIEWER",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    {
      principalId: P21_ACTIVATOR,
      principalType: "CONSTITUTIONAL_ACTIVATOR",
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    },
    ...extraPrincipals.map((p) => ({
      principalId: p.principalId,
      principalType: p.principalType,
      projectId,
      environments: [EXAMPLE_ENVIRONMENT],
    })),
  ]);
}

export async function createConcurrentStack(
  db: PostgresDatabase,
  suffix: string,
  opts?: {
    constitutionalActivationFailpoint?: {
      name: string;
      trigger: () => void;
    };
  },
): Promise<PostgresOrchestratorStack> {
  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId: uniquePostgresTestId(`p21-stack-${suffix}`),
    seedControlPlane: false,
    ...(opts?.constitutionalActivationFailpoint !== undefined
      ? {
          constitutionalActivationFailpoint:
            opts.constitutionalActivationFailpoint,
        }
      : {}),
  });
  return {
    ...stack,
    close: async () => undefined,
  };
}

async function loadCanonicalGrantsForProject(
  db: PostgresDatabase,
  projectId: string,
): Promise<CanonicalAuthorityGrant[]> {
  const rows = await db.query<{
    grant_id: string;
    principal_id: string;
    principal_type: string;
    project_id: string;
    authorized_environments: string[];
    enabled: boolean;
  }>(
    `SELECT grant_id, principal_id, principal_type, project_id,
            authorized_environments, enabled
     FROM authority_grants
     WHERE project_id = $1`,
    [projectId],
  );
  return rows.rows.map((row) =>
    CanonicalAuthorityGrantSchema.parse({
      grantId: row.grant_id,
      principalId: row.principal_id,
      authorityRole: row.principal_type,
      projectId: row.project_id,
      environmentScope: row.authorized_environments,
      enabled: row.enabled,
    }),
  );
}

export async function computeInstitutionFingerprint(
  stack: PostgresOrchestratorStack,
  institutionId: string,
  projectId: string,
): Promise<string> {
  const institution = await stack.governanceService.getInstitution(institutionId);
  if (!institution) {
    throw new Error(`Institution ${institutionId} not found`);
  }
  const mandates =
    await stack.governanceService.listActiveMandatesByProject(projectId);
  const units =
    await stack.governanceService.listOrganizationalUnits(institutionId);
  const grants = await loadCanonicalGrantsForProject(stack.db, projectId);
  return computeGovernanceStateFingerprint({
    institutionId,
    mandates: mandates.filter((m) => m.institutionId === institutionId),
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

export async function countOrgUnitsByName(
  db: PostgresDatabase,
  institutionId: string,
  name: string,
): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
     FROM organizational_units
     WHERE institution_id = $1
       AND payload->>'name' = $2
       AND payload->>'status' = 'ACTIVE'`,
    [institutionId, name],
  );
  return Number(rows.rows[0]?.c ?? 0);
}

export async function countActivatedRecordsForProposal(
  db: PostgresDatabase,
  proposalId: string,
): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
     FROM constitutional_activation_records
     WHERE proposal_id = $1 AND status = 'ACTIVATED'`,
    [proposalId],
  );
  return Number(rows.rows[0]?.c ?? 0);
}

export async function countAuditEventsForProposal(
  db: PostgresDatabase,
  proposalId: string,
  eventType: string,
): Promise<number> {
  const rows = await db.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c
     FROM constitutional_audit_events
     WHERE proposal_id = $1 AND event_type = $2`,
    [proposalId, eventType],
  );
  return Number(rows.rows[0]?.c ?? 0);
}

export function p21LifecycleFromAnchor(
  anchorIso: string,
  slot: number,
): {
  reviewAt: string;
  activationAuthorizationAt: string;
  activationAt: string;
  revocationEffectiveAt: string;
  postRevocationAt: string;
  retryAt: string;
  caseExpiresAt: string;
} {
  const anchor = Date.parse(anchorIso);
  const base = anchor + slot * 3600_000;
  return {
    reviewAt: new Date(base + 60_000).toISOString(),
    activationAuthorizationAt: new Date(base + 120_000).toISOString(),
    activationAt: new Date(base + 180_000).toISOString(),
    revocationEffectiveAt: new Date(base + 240_000).toISOString(),
    postRevocationAt: new Date(base + 300_000).toISOString(),
    retryAt: new Date(base + 360_000).toISOString(),
    caseExpiresAt: new Date(base + 3600_000 * 24 * 20).toISOString(),
  };
}

function governanceCaseExpiresAt(reviewAt: string): string {
  return new Date(Date.parse(reviewAt) + 3600_000 * 24 * 20).toISOString();
}

export async function setupConstitutionalInstitution(input: {
  stack: PostgresOrchestratorStack;
  projectId: string;
  quorumRequirement?: GovernanceQuorumRequirement;
  separationOfDutyRules?: SeparationOfDutyRule[];
  enableControl?: boolean;
}): Promise<{
  institutionId: string;
  mandateId: string;
}> {
  const governance = input.stack.governanceService;
  const anchorMs = Date.parse(input.stack.clock.nowIso());
  const mandateEffectiveFrom = new Date(anchorMs - 3600_000).toISOString();
  const mandateEffectiveUntil = new Date(
    anchorMs + 3600_000 * 24 * 90,
  ).toISOString();
  const institution = await governance.createInstitution({
    name: `P21 ${input.projectId}`,
    projectIds: [input.projectId],
  });
  const draft = await governance.createMandate({
    institutionId: institution.institutionId,
    createdBy: P21_GOV_ADMIN,
    subjectClasses: ["CONSTITUTIONAL_CHANGE"],
    requiredAuthorities: ["CONSTITUTIONAL_REVIEWER", "CONSTITUTIONAL_ACTIVATOR"],
    projectScope: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    quorumRequirement: input.quorumRequirement ?? {
      kind: "K_OF_N",
      k: 1,
      n: 3,
      roles: ["CONSTITUTIONAL_REVIEWER"],
      rejectBlocksImmediately: false,
    },
    ...(input.separationOfDutyRules !== undefined
      ? { separationOfDutyRules: input.separationOfDutyRules }
      : {}),
    effectiveFrom: mandateEffectiveFrom,
    effectiveUntil: mandateEffectiveUntil,
  });
  const active = await governance.activateMandate({
    mandateId: draft.mandateId,
    actorPrincipalId: P21_GOV_ADMIN,
  });
  if (input.enableControl !== false) {
    await input.stack.constitutionalService.enableConstitutionalControl({
      institutionId: institution.institutionId,
      actorPrincipalId: P21_GOV_ADMIN,
    });
  }
  return {
    institutionId: institution.institutionId,
    mandateId: active.mandateId,
  };
}

export async function authorizeExistingProposal(input: {
  stack: PostgresOrchestratorStack;
  proposalId: string;
  proposalHash: string;
  proposalVersion: number;
  institutionId: string;
  projectId: string;
  mandateId: string;
  reviewAt: string;
  activationAuthorizationAt: string;
  requiredReviewCount?: number;
  requiredActivationCount?: number;
}): Promise<Omit<PreparedProposal, "orgUnitName" | "title" | "baseFingerprint">> {
  const constitutional = input.stack.constitutionalService;
  const governance = input.stack.governanceService;

  const reviewBinding = compileReviewSubjectBinding({
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    proposalHash: input.proposalHash,
  });
  const reviewCase = await governance.openGovernanceCase({
    ...reviewBinding,
    action: "CONSTITUTIONAL_REVIEW",
    projectIds: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    mandateIds: [input.mandateId],
    expiresAt: governanceCaseExpiresAt(input.reviewAt),
  });

  const reviewers = [P21_REVIEWER_A, P21_REVIEWER_B, P21_REVIEWER_C];
  const required = input.requiredReviewCount ?? 1;
  let sharedProofId = "";

  for (let i = 0; i < required; i += 1) {
    const attest = await governance.attest({
      governanceCaseId: reviewCase.governanceCaseId,
      principalId: reviewers[i]!,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: `nonce-review-${input.proposalId}-${i}`,
    });
    if (attest.proof) {
      sharedProofId = attest.proof.institutionalAuthorizationProofId;
    }
  }
  if (!sharedProofId) {
    throw new Error("Review quorum proof not created");
  }

  let reviewDecisionId = "";
  for (let i = 0; i < required; i += 1) {
    const decision = await constitutional.recordReviewDecision({
      proposalId: input.proposalId,
      reviewerPrincipalId: reviewers[i]!,
      institutionalAuthorizationProofId: sharedProofId,
      decision: "APPROVE",
      projectId: input.projectId,
      environment: EXAMPLE_ENVIRONMENT,
      atIso: input.reviewAt,
    });
    reviewDecisionId = decision.decisionId;
  }

  const activationBinding = compileActivationSubjectBinding({
    proposalId: input.proposalId,
    proposalVersion: input.proposalVersion,
    proposalHash: input.proposalHash,
  });
  const activationCase = await governance.openGovernanceCase({
    ...activationBinding,
    action: "CONSTITUTIONAL_ACTIVATION",
    projectIds: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    mandateIds: [input.mandateId],
    expiresAt: governanceCaseExpiresAt(input.activationAuthorizationAt),
  });
  const activationAttest = await governance.attest({
    governanceCaseId: activationCase.governanceCaseId,
    principalId: P21_ACTIVATOR,
    authorityRole: "CONSTITUTIONAL_ACTIVATOR",
    decision: "APPROVE",
    nonce: `nonce-activation-${input.proposalId}`,
  });
  let activationProofId =
    activationAttest.proof?.institutionalAuthorizationProofId ?? "";
  const activationRequired = input.requiredActivationCount ?? 1;
  const activators = [
    P21_ACTIVATOR,
    `${P21_ACTIVATOR}_b`,
    `${P21_ACTIVATOR}_c`,
  ];
  if (activationRequired > 1) {
    for (let i = 1; i < activationRequired; i += 1) {
      const attest = await governance.attest({
        governanceCaseId: activationCase.governanceCaseId,
        principalId: activators[i]!,
        authorityRole: "CONSTITUTIONAL_ACTIVATOR",
        decision: "APPROVE",
        nonce: `nonce-activation-${input.proposalId}-${i}`,
      });
      if (attest.proof) {
        activationProofId = attest.proof.institutionalAuthorizationProofId;
      }
    }
  }
  if (!activationProofId) {
    throw new Error("Activation quorum proof not created");
  }
  const staged = await constitutional.stageActivation({
    proposalId: input.proposalId,
    activatorPrincipalId: P21_ACTIVATOR,
    institutionalAuthorizationProofId: activationProofId,
    reviewDecisionId,
    projectId: input.projectId,
    environment: EXAMPLE_ENVIRONMENT,
    atIso: input.activationAuthorizationAt,
  });

  return {
    institutionId: input.institutionId,
    projectId: input.projectId,
    mandateId: input.mandateId,
    proposalId: input.proposalId,
    proposalHash: input.proposalHash,
    proposalVersion: input.proposalVersion,
    reviewDecisionId,
    activationRecordId: staged.activationRecordId,
    activationProofId,
  };
}

export async function createAuthorizedProposal(input: {
  stack: PostgresOrchestratorStack;
  institutionId: string;
  projectId: string;
  mandateId: string;
  orgUnitName: string;
  title: string;
  reviewAt: string;
  activationAuthorizationAt: string;
  requiredReviewCount?: number;
  requiredActivationCount?: number;
  stage?: boolean;
  changeOperations?: import("../../constitutional/operations.js").ConstitutionalChangeOperation[];
}): Promise<PreparedProposal> {
  const constitutional = input.stack.constitutionalService;
  const governance = input.stack.governanceService;
  const proposal = await constitutional.createProposal({
    institutionId: input.institutionId,
    title: input.title,
    rationale: "postgres phase21 acceptance",
    changeOperations: input.changeOperations ?? [
      {
        kind: "CREATE_ORGANIZATIONAL_UNIT",
        institutionId: input.institutionId,
        name: input.orgUnitName,
        description: "",
        projectScope: [input.projectId],
      },
    ],
    riskClass: "LOW",
    proposedByPrincipalId: P21_GOV_ADMIN,
  });
  await constitutional.submitProposal({
    proposalId: proposal.constitutionalChangeProposalId,
    actorPrincipalId: P21_GOV_ADMIN,
  });
  await constitutional.analyzeProposal({
    proposalId: proposal.constitutionalChangeProposalId,
    actorPrincipalId: P21_GOV_ADMIN,
  });

  const reviewBinding = compileReviewSubjectBinding({
    proposalId: proposal.constitutionalChangeProposalId,
    proposalVersion: proposal.proposalVersion,
    proposalHash: proposal.proposalHash,
  });
  const reviewCase = await governance.openGovernanceCase({
    ...reviewBinding,
    action: "CONSTITUTIONAL_REVIEW",
    projectIds: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    mandateIds: [input.mandateId],
    expiresAt: governanceCaseExpiresAt(input.reviewAt),
  });

  const reviewers = [P21_REVIEWER_A, P21_REVIEWER_B, P21_REVIEWER_C];
  const required = input.requiredReviewCount ?? 1;
  let sharedProofId = "";

  for (let i = 0; i < required; i += 1) {
    const attest = await governance.attest({
      governanceCaseId: reviewCase.governanceCaseId,
      principalId: reviewers[i]!,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: `nonce-review-${proposal.constitutionalChangeProposalId}-${i}`,
    });
    if (attest.proof) {
      sharedProofId = attest.proof.institutionalAuthorizationProofId;
    }
  }
  if (!sharedProofId) {
    throw new Error("Review quorum proof not created");
  }

  let reviewDecisionId = "";
  for (let i = 0; i < required; i += 1) {
    const decision = await constitutional.recordReviewDecision({
      proposalId: proposal.constitutionalChangeProposalId,
      reviewerPrincipalId: reviewers[i]!,
      institutionalAuthorizationProofId: sharedProofId,
      decision: "APPROVE",
      projectId: input.projectId,
      environment: EXAMPLE_ENVIRONMENT,
      atIso: input.reviewAt,
    });
    reviewDecisionId = decision.decisionId;
  }

  const activationBinding = compileActivationSubjectBinding({
    proposalId: proposal.constitutionalChangeProposalId,
    proposalVersion: proposal.proposalVersion,
    proposalHash: proposal.proposalHash,
  });
  const activationCase = await governance.openGovernanceCase({
    ...activationBinding,
    action: "CONSTITUTIONAL_ACTIVATION",
    projectIds: [input.projectId],
    environmentScope: [EXAMPLE_ENVIRONMENT],
    mandateIds: [input.mandateId],
    expiresAt: governanceCaseExpiresAt(input.activationAuthorizationAt),
  });
  const activationAttest = await governance.attest({
    governanceCaseId: activationCase.governanceCaseId,
    principalId: P21_ACTIVATOR,
    authorityRole: "CONSTITUTIONAL_ACTIVATOR",
    decision: "APPROVE",
    nonce: `nonce-activation-${proposal.constitutionalChangeProposalId}`,
  });
  let activationProofId =
    activationAttest.proof?.institutionalAuthorizationProofId ?? "";
  const activationRequired = input.requiredActivationCount ?? 1;
  const activators = [
    P21_ACTIVATOR,
    `${P21_ACTIVATOR}_b`,
    `${P21_ACTIVATOR}_c`,
  ];
  if (activationRequired > 1) {
    for (let i = 1; i < activationRequired; i += 1) {
      const attest = await governance.attest({
        governanceCaseId: activationCase.governanceCaseId,
        principalId: activators[i]!,
        authorityRole: "CONSTITUTIONAL_ACTIVATOR",
        decision: "APPROVE",
        nonce: `nonce-activation-${proposal.constitutionalChangeProposalId}-${i}`,
      });
      if (attest.proof) {
        activationProofId = attest.proof.institutionalAuthorizationProofId;
      }
    }
  }
  if (!activationProofId) {
    throw new Error("Activation quorum proof not created");
  }

  let activationRecordId = "";
  if (input.stage !== false) {
    const staged = await constitutional.stageActivation({
      proposalId: proposal.constitutionalChangeProposalId,
      activatorPrincipalId: P21_ACTIVATOR,
      institutionalAuthorizationProofId: activationProofId,
      reviewDecisionId,
      projectId: input.projectId,
      environment: EXAMPLE_ENVIRONMENT,
      atIso: input.activationAuthorizationAt,
    });
    activationRecordId = staged.activationRecordId;
  }

  return {
    institutionId: input.institutionId,
    projectId: input.projectId,
    mandateId: input.mandateId,
    proposalId: proposal.constitutionalChangeProposalId,
    proposalHash: proposal.proposalHash,
    proposalVersion: proposal.proposalVersion,
    baseFingerprint: proposal.baseGovernanceFingerprint,
    reviewDecisionId,
    activationRecordId,
    activationProofId,
    orgUnitName: input.orgUnitName,
  };
}

export async function activatePreparedProposal(input: {
  stack: PostgresOrchestratorStack;
  prepared: PreparedProposal;
  activationAt: string;
}): Promise<
  Awaited<ReturnType<import("../../constitutional/service.js").ConstitutionalChangeOrchestrationService["activate"]>>
> {
  return input.stack.constitutionalService.activate({
    proposalId: input.prepared.proposalId,
    activatorPrincipalId: P21_ACTIVATOR,
    activationRecordId: input.prepared.activationRecordId,
    institutionalAuthorizationProofId: input.prepared.activationProofId,
    reviewDecisionId: input.prepared.reviewDecisionId,
    projectId: input.prepared.projectId,
    environment: EXAMPLE_ENVIRONMENT,
    atIso: input.activationAt,
  });
}

export function isStaleBaseError(error: unknown): boolean {
  if (
    isConstitutionalError(error) &&
    error.code === "CONSTITUTIONAL_BASE_STATE_STALE"
  ) {
    return true;
  }
  if (
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "CONSTITUTIONAL_BASE_STATE_STALE"
  ) {
    return true;
  }
  return false;
}

export async function createP21ApiServer(
  stack: PostgresOrchestratorStack,
  projectId: string,
) {
  return buildServer({
    governanceService: stack.governanceService,
    governanceProofs: stack.governanceProofs,
    constitutionalService: stack.constitutionalService,
    storageMode: "postgres",
    perimeter: {
      authenticator: new FakeRequestAuthenticator({
        principalId: P21_GOV_ADMIN,
        authenticationMode: "HEADER_PRINCIPAL",
      }),
      access: new InMemoryProjectAccessDirectory([
        { principalId: P21_GOV_ADMIN, projectIds: [projectId] },
      ]),
      drain: new DrainController(),
      metrics: new OperationalMetrics(),
      logger: new MemoryStructuredLogger("p21-api", () => undefined),
      rateLimiter: new SlidingWindowRateLimiter(100, 60_000),
      authenticationMode: "HEADER_PRINCIPAL",
    },
  });
}

export async function lookupGrantId(
  db: PostgresDatabase,
  projectId: string,
  principalId: string,
  principalType: string,
): Promise<string> {
  const rows = await db.query<{ grant_id: string }>(
    `SELECT grant_id FROM authority_grants
     WHERE principal_id = $1 AND principal_type = $2 AND project_id = $3
     LIMIT 1`,
    [principalId, principalType, projectId],
  );
  const grantId = rows.rows[0]?.grant_id;
  if (!grantId) {
    throw new Error(
      `Grant not found for ${principalId}/${principalType}/${projectId}`,
    );
  }
  return grantId;
}
