import { describe, expect, it } from "vitest";
import {
  assertAllOperationsExecutable,
  assertExhaustiveOperationKind,
  computeGovernanceStateFingerprint,
  ConstitutionalActivationCapability,
  isConstitutionalError,
  type ConstitutionalChangeOperation,
  type ConstitutionalError,
} from "./index.js";
import {
  buildConstitutionalService,
  CONST_PRINCIPALS,
  GOV_ENV_STAGING,
  GOV_PROJECT_ID,
  PRINCIPALS,
  seedConstitutionalAuthority,
  seedConstitutionalInstitution,
  seedInstitution,
  seedHighQuorumConstitutionalMandate,
  attestConstitutionalReview,
  stageConstitutionalActivation,
  seedCanonicalAuthority,
} from "./test-fixtures.js";
import { selectConstitutionalRoleGrants } from "./fingerprint.js";
import { assertProjectedGovernanceContinuity } from "./continuity.js";
import { isGovernanceError } from "../governance/errors.js";
import { ConstitutionalChangeOperationSchema } from "./operations.js";

function expectConstitutionalError(
  err: unknown,
  code: ConstitutionalError["code"],
): asserts err is ConstitutionalError {
  expect(isConstitutionalError(err)).toBe(true);
  expect((err as ConstitutionalError).code).toBe(code);
}

const ALL_OPERATION_KINDS: ConstitutionalChangeOperation[] = [
  {
    kind: "CREATE_MANDATE_VERSION",
    institutionId: "inst_x",
    subjectClasses: ["CONSTITUTIONAL_CHANGE"],
    requiredAuthorities: ["CONSTITUTIONAL_REVIEWER"],
    projectScope: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
  },
  {
    kind: "SUPERSEDE_MANDATE_VERSION",
    mandateId: "gmd_x",
    newMandateVersion: 2,
    subjectClasses: ["CONSTITUTIONAL_CHANGE"],
    requiredAuthorities: ["CONSTITUTIONAL_REVIEWER"],
    projectScope: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
  },
  {
    kind: "CHANGE_MANDATE_QUORUM",
    mandateId: "gmd_x",
    quorumRequirement: {
      kind: "K_OF_N",
      k: 2,
      n: 3,
      roles: ["CONSTITUTIONAL_REVIEWER"],
      rejectBlocksImmediately: false,
    },
  },
  {
    kind: "CHANGE_MANDATE_SEPARATION_OF_DUTIES",
    mandateId: "gmd_x",
    separationOfDutyRules: [],
  },
  {
    kind: "CHANGE_MANDATE_SCOPE",
    mandateId: "gmd_x",
    projectScope: [GOV_PROJECT_ID],
    environmentScope: [GOV_ENV_STAGING],
  },
  {
    kind: "CHANGE_DELEGATION_LIMITS",
    mandateId: "gmd_x",
    maximumDelegationDepth: 2,
  },
  {
    kind: "CHANGE_GOVERNANCE_ADMIN_SCOPE",
    institutionId: "inst_x",
    projectScope: [GOV_PROJECT_ID],
  },
  {
    kind: "CREATE_ORGANIZATIONAL_UNIT",
    institutionId: "inst_x",
    name: "Desk",
    description: "",
    projectScope: [GOV_PROJECT_ID],
  },
  {
    kind: "CHANGE_ORGANIZATIONAL_UNIT_RELATIONSHIP",
    organizationalUnitId: "ou_x",
    parentUnitId: "ou_parent",
  },
  {
    kind: "RETIRE_ORGANIZATIONAL_UNIT",
    organizationalUnitId: "ou_x",
  },
];

describe("Phase 21 pre-Postgres closure", () => {
  it("accepts every DSL operation kind in exhaustive compiler", () => {
    for (const op of ALL_OPERATION_KINDS) {
      expect(() => ConstitutionalChangeOperationSchema.parse(op)).not.toThrow();
      expect(() => assertExhaustiveOperationKind(op)).not.toThrow();
    }
    expect(() => assertAllOperationsExecutable(ALL_OPERATION_KINDS)).not.toThrow();
  });

  it("CHANGE_GOVERNANCE_ADMIN_SCOPE does not grant operational authority", () => {
    const op = ConstitutionalChangeOperationSchema.parse({
      kind: "CHANGE_GOVERNANCE_ADMIN_SCOPE",
      institutionId: "inst_x",
      projectScope: [GOV_PROJECT_ID],
    });
    expect(op).not.toHaveProperty("grantsOperationalAuthority");
    expect(op).not.toHaveProperty("scopeExpansion");
  });

  it("old quorum (3-of-5) governs quorum relaxation review", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const institution = await seedInstitution(stack.service);
    await stack.service.createMandate({
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
    }).then((m) =>
      stack.service.activateMandate({
        mandateId: m.mandateId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      }),
    );
    const mandateId = await seedHighQuorumConstitutionalMandate(
      stack,
      institution.institutionId,
    );
    await stack.constitutional.enableConstitutionalControl({
      institutionId: institution.institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });

    const proposal = await stack.constitutional.createProposal({
      institutionId: institution.institutionId,
      title: "Relax quorum",
      rationale: "1-of-1",
      changeOperations: [
        {
          kind: "CHANGE_MANDATE_QUORUM",
          mandateId,
          quorumRequirement: {
            kind: "K_OF_N",
            k: 1,
            n: 1,
            roles: ["CONSTITUTIONAL_REVIEWER"],
            rejectBlocksImmediately: false,
          },
        },
      ],
      riskClass: "HIGH",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.analyzeProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });

    const reviewCase = await stack.service.openGovernanceCase({
      subjectType: "CONSTITUTIONAL_CHANGE_REVIEW",
      subjectId: proposal.constitutionalChangeProposalId,
      subjectVersion: proposal.proposalVersion,
      subjectHash: proposal.proposalHash,
      requiredRole: "CONSTITUTIONAL_REVIEWER",
      action: "CONSTITUTIONAL_REVIEW",
      projectIds: [GOV_PROJECT_ID],
      environmentScope: [GOV_ENV_STAGING],
      mandateIds: [mandateId],
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
    await stack.service.attest({
      governanceCaseId: reviewCase.governanceCaseId,
      principalId: CONST_PRINCIPALS.constitutionalReviewer,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: "quorum-shared-1",
    });
    await stack.service.attest({
      governanceCaseId: reviewCase.governanceCaseId,
      principalId: CONST_PRINCIPALS.constitutionalReviewerB,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: "quorum-shared-2",
    });
    const third = await stack.service.attest({
      governanceCaseId: reviewCase.governanceCaseId,
      principalId: CONST_PRINCIPALS.constitutionalReviewerC,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: "quorum-shared-3",
    });
    const sharedProofId = third.proof!.institutionalAuthorizationProofId;

    await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId: mandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewer,
      nonce: "quorum-decision-1",
      governanceCaseId: reviewCase.governanceCaseId,
      sharedProofId,
    });
    expect(
      (await stack.constitutional.getProposal(proposal.constitutionalChangeProposalId))
        .status,
    ).toBe("AWAITING_REVIEW");

    await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId: mandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewerB,
      nonce: "quorum-decision-2",
      governanceCaseId: reviewCase.governanceCaseId,
      sharedProofId,
    });
    expect(
      (await stack.constitutional.getProposal(proposal.constitutionalChangeProposalId))
        .status,
    ).toBe("AWAITING_REVIEW");

    await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId: mandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewerC,
      nonce: "quorum-decision-3",
      governanceCaseId: reviewCase.governanceCaseId,
      sharedProofId,
    });
    expect(
      (await stack.constitutional.getProposal(proposal.constitutionalChangeProposalId))
        .status,
    ).toBe("AUTHORIZED");
  });

  it("old SoD governs SoD-removal when proposer attempts review", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const institution = await seedInstitution(stack.service);
    const draft = await stack.service.createMandate({
      institutionId: institution.institutionId,
      createdBy: PRINCIPALS.govAdmin,
      subjectClasses: ["CONSTITUTIONAL_CHANGE"],
      requiredAuthorities: ["CONSTITUTIONAL_REVIEWER", "CONSTITUTIONAL_ACTIVATOR"],
      projectScope: [GOV_PROJECT_ID],
      environmentScope: [GOV_ENV_STAGING],
      quorumRequirement: {
        kind: "K_OF_N",
        k: 1,
        n: 1,
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
    const mandateId = (
      await stack.service.activateMandate({
        mandateId: draft.mandateId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      })
    ).mandateId;
    await stack.canonicalAuthority.seed({
      principalId: PRINCIPALS.govAdmin,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      projectId: GOV_PROJECT_ID,
      environmentScope: [GOV_ENV_STAGING],
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      grantId: "grant_gov_admin_dual_reviewer",
    });
    await stack.constitutional.enableConstitutionalControl({
      institutionId: institution.institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });

    const proposal = await stack.constitutional.createProposal({
      institutionId: institution.institutionId,
      title: "Remove SoD",
      rationale: "relax",
      changeOperations: [
        {
          kind: "CHANGE_MANDATE_SEPARATION_OF_DUTIES",
          mandateId,
          separationOfDutyRules: [],
        },
      ],
      riskClass: "HIGH",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.analyzeProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });

    const reviewCase = await stack.service.openGovernanceCase({
      subjectType: "CONSTITUTIONAL_CHANGE_REVIEW",
      subjectId: proposal.constitutionalChangeProposalId,
      subjectVersion: proposal.proposalVersion,
      subjectHash: proposal.proposalHash,
      requiredRole: "CONSTITUTIONAL_REVIEWER",
      action: "CONSTITUTIONAL_REVIEW",
      projectIds: [GOV_PROJECT_ID],
      environmentScope: [GOV_ENV_STAGING],
      mandateIds: [mandateId],
      expiresAt: "2026-06-01T00:00:00.000Z",
    });
    const reviewAttest = await stack.service.attest({
      governanceCaseId: reviewCase.governanceCaseId,
      principalId: PRINCIPALS.govAdmin,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      decision: "APPROVE",
      nonce: "sod-self-review",
    });

    await expect(
      stack.constitutional.recordReviewDecision({
        proposalId: proposal.constitutionalChangeProposalId,
        reviewerPrincipalId: PRINCIPALS.govAdmin,
        institutionalAuthorizationProofId:
          reviewAttest.proof!.institutionalAuthorizationProofId,
        decision: "APPROVE",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
      }),
    ).rejects.toMatchObject({ code: "CONSTITUTIONAL_SEPARATION_VIOLATION" });
  });

  it("rejects projected reviewer lockout", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const institution = (await stack.service.getInstitution(institutionId))!;
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const units = await stack.service.listOrganizationalUnits(institutionId);
    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);

    expect(() =>
      assertProjectedGovernanceContinuity({
        institution,
        mandates: mandates.filter((m) => m.institutionId === institutionId),
        units,
        grants,
        operations: [
          {
            kind: "CHANGE_GOVERNANCE_ADMIN_SCOPE",
            institutionId,
            projectScope: ["proj_without_reviewers"],
          },
        ],
        nowIso: stack.nowIso(),
        actorPrincipalId: PRINCIPALS.govAdmin,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "CONSTITUTIONAL_GOVERNANCE_LOCKOUT" }),
    );
  });

  it("rejects projected activator lockout", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const institution = (await stack.service.getInstitution(institutionId))!;
    const gapProject = "proj_activator_gap";
    await stack.canonicalAuthority.seed({
      principalId: PRINCIPALS.govAdmin,
      authorityRole: "GOVERNANCE_ADMIN",
      projectId: gapProject,
      environmentScope: [GOV_ENV_STAGING],
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      grantId: "grant_admin_gap",
    });
    await stack.canonicalAuthority.seed({
      principalId: CONST_PRINCIPALS.constitutionalReviewer,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      projectId: gapProject,
      environmentScope: [GOV_ENV_STAGING],
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      grantId: "grant_reviewer_gap",
    });
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const units = await stack.service.listOrganizationalUnits(institutionId);
    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const gapGrants = await stack.canonicalAuthority.listByProject!(gapProject);

    expect(() =>
      assertProjectedGovernanceContinuity({
        institution,
        mandates: mandates.filter((m) => m.institutionId === institutionId),
        units,
        grants: [...grants, ...gapGrants],
        operations: [
          {
            kind: "CHANGE_GOVERNANCE_ADMIN_SCOPE",
            institutionId,
            projectScope: [gapProject],
          },
        ],
        nowIso: stack.nowIso(),
        actorPrincipalId: PRINCIPALS.govAdmin,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONSTITUTIONAL_GOVERNANCE_LOCKOUT",
        details: expect.objectContaining({ role: "CONSTITUTIONAL_ACTIVATOR" }),
      }),
    );
  });

  it("rejects projected admin lockout", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const institution = (await stack.service.getInstitution(institutionId))!;
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const units = await stack.service.listOrganizationalUnits(institutionId);
    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);

    expect(() =>
      assertProjectedGovernanceContinuity({
        institution,
        mandates: mandates.filter((m) => m.institutionId === institutionId),
        units,
        grants,
        operations: [
          {
            kind: "CHANGE_GOVERNANCE_ADMIN_SCOPE",
            institutionId,
            projectScope: ["proj_without_admins"],
          },
        ],
        nowIso: stack.nowIso(),
        actorPrincipalId: PRINCIPALS.govAdmin,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "CONSTITUTIONAL_GOVERNANCE_LOCKOUT",
        details: expect.objectContaining({ role: "GOVERNANCE_ADMIN" }),
      }),
    );
  });

  it("fingerprint binds grant material identity not principal names alone", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const institution = (await stack.service.getInstitution(institutionId))!;
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const units = await stack.service.listOrganizationalUnits(institutionId);
    const grantsA = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const fpA = computeGovernanceStateFingerprint({
      institutionId,
      mandates: mandates.filter((m) => m.institutionId === institutionId),
      organizationalUnits: units,
      constitutionalControlEnabled: true,
      institutionProjectIds: institution.projectIds,
      constitutionalRoleGrants: selectConstitutionalRoleGrants(
        grantsA,
        institution.projectIds,
      ),
      constitutionalRevocationIds: [],
    });

    const reviewerGrant = grantsA.find(
      (g) =>
        g.principalId === CONST_PRINCIPALS.constitutionalReviewer &&
        g.authorityRole === "CONSTITUTIONAL_REVIEWER",
    );
    expect(reviewerGrant).toBeDefined();
    await stack.canonicalAuthority.seed({
      principalId: CONST_PRINCIPALS.constitutionalReviewer,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      projectId: GOV_PROJECT_ID,
      environmentScope: [GOV_ENV_STAGING],
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      grantId: `${reviewerGrant!.grantId}_replacement`,
    });

    const grantsB = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const fpB = computeGovernanceStateFingerprint({
      institutionId,
      mandates: mandates.filter((m) => m.institutionId === institutionId),
      organizationalUnits: units,
      constitutionalControlEnabled: true,
      institutionProjectIds: institution.projectIds,
      constitutionalRoleGrants: selectConstitutionalRoleGrants(
        grantsB,
        institution.projectIds,
      ),
      constitutionalRevocationIds: [],
    });

    expect(fpA).not.toBe(fpB);
  });

  it("activation capability cannot be fabricated", async () => {
    const fake = {
      payload: {
        proposalId: "ccp_fake",
        proposalHash: "hash",
        proposalVersion: 1,
        activationRecordId: "car_fake",
        baseGovernanceFingerprint: "fp",
        institutionId: "inst",
        activatedByPrincipalId: PRINCIPALS.govAdmin,
        mutationPlanHash: "plan",
        authorizedProtectedMutations: ["createMandate"],
      },
    };
    expect(ConstitutionalActivationCapability.isCapability(fake)).toBe(false);

    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    await stack.constitutional.enableConstitutionalControl({
      institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    try {
      await stack.service.createMandate(
        {
          institutionId,
          createdBy: PRINCIPALS.govAdmin,
          subjectClasses: ["PORTFOLIO_PLAN"],
          requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
        },
        {
          activationCapability: fake as unknown as ConstitutionalActivationCapability,
        },
      );
      expect.fail("expected bypass denial");
    } catch (error) {
      expect(isGovernanceError(error)).toBe(true);
      expect((error as { code: string }).code).toBe(
        "CONSTITUTIONAL_MUTATION_BYPASS_DENIED",
      );
    }
  });

  it("activation capability for institution A cannot mutate institution B", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const a = await seedConstitutionalInstitution(stack);
    const b = await seedInstitution(stack.service, "Institution B");
    await stack.constitutional.enableConstitutionalControl({
      institutionId: a.institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.enableConstitutionalControl({
      institutionId: b.institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });

    const capability = ConstitutionalActivationCapability.mint({
      proposalId: "ccp_inst_a",
      proposalHash: "hash_a",
      proposalVersion: 1,
      activationRecordId: "car_a",
      baseGovernanceFingerprint: "fp_a",
      institutionId: a.institutionId,
      activatedByPrincipalId: CONST_PRINCIPALS.constitutionalActivator,
      mutationPlanHash: "plan_a",
      authorizedProtectedMutations: [
        "createOrganizationalUnit",
        "createMandate",
        "activateMandate",
      ],
    });

    await expect(
      stack.service.createOrganizationalUnit(
        {
          institutionId: b.institutionId,
          name: "Cross Institution OU",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
        { activationCapability: capability },
      ),
    ).rejects.toMatchObject({ code: "CONSTITUTIONAL_MUTATION_BYPASS_DENIED" });

    await expect(
      stack.service.createMandate(
        {
          institutionId: b.institutionId,
          createdBy: PRINCIPALS.govAdmin,
          subjectClasses: ["PORTFOLIO_PLAN"],
          requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
        },
        { activationCapability: capability },
      ),
    ).rejects.toMatchObject({ code: "CONSTITUTIONAL_MUTATION_BYPASS_DENIED" });
  });

  it("activation capability for operation X rejects unrelated protected operation Y", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    await stack.constitutional.enableConstitutionalControl({
      institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });

    const capability = ConstitutionalActivationCapability.mint({
      proposalId: "ccp_ou_only",
      proposalHash: "hash_ou",
      proposalVersion: 1,
      activationRecordId: "car_ou",
      baseGovernanceFingerprint: "fp_ou",
      institutionId,
      activatedByPrincipalId: CONST_PRINCIPALS.constitutionalActivator,
      mutationPlanHash: "plan_ou_only",
      authorizedProtectedMutations: ["createOrganizationalUnit"],
    });

    await stack.service.createOrganizationalUnit(
      {
        institutionId,
        name: "Authorized Desk",
        description: "",
        projectScope: [GOV_PROJECT_ID],
      },
      { activationCapability: capability },
    );

    await expect(
      stack.service.createMandate(
        {
          institutionId,
          createdBy: PRINCIPALS.govAdmin,
          subjectClasses: ["PORTFOLIO_PLAN"],
          requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
          projectScope: [GOV_PROJECT_ID],
          environmentScope: [GOV_ENV_STAGING],
        },
        { activationCapability: capability },
      ),
    ).rejects.toMatchObject({
      code: "CONSTITUTIONAL_MUTATION_BYPASS_DENIED",
    });

    await expect(
      stack.service.updateInstitutionProjectScope(
        {
          institutionId,
          projectScope: [GOV_PROJECT_ID],
          actorPrincipalId: PRINCIPALS.govAdmin,
        },
        { activationCapability: capability },
      ),
    ).rejects.toMatchObject({
      code: "CONSTITUTIONAL_MUTATION_BYPASS_DENIED",
    });
  });

  it("capability payload binds proposal identity and mutation plan hash", () => {
    const capability = ConstitutionalActivationCapability.mint({
      proposalId: "ccp_bind",
      proposalHash: "ph_bind",
      proposalVersion: 3,
      activationRecordId: "car_bind",
      baseGovernanceFingerprint: "fp_bind",
      institutionId: "inst_bind",
      activatedByPrincipalId: "act",
      mutationPlanHash: "plan_bind",
      authorizedProtectedMutations: ["createOrganizationalUnit"],
    });
    expect(capability.payload.institutionId).toBe("inst_bind");
    expect(capability.payload.proposalId).toBe("ccp_bind");
    expect(capability.payload.proposalVersion).toBe(3);
    expect(capability.payload.proposalHash).toBe("ph_bind");
    expect(capability.payload.mutationPlanHash).toBe("plan_bind");
    expect(capability.authorizesProtectedMutation("createOrganizationalUnit")).toBe(
      true,
    );
    expect(capability.authorizesProtectedMutation("createMandate")).toBe(false);
  });

  it("activation failpoint rolls back material writes before activation record", async () => {
    let failpointFired = false;
    const stack = buildConstitutionalService(
      {
        activationFailpoint: {
          name: "AFTER_TARGET_GOVERNANCE_WRITE_BEFORE_ACTIVATION_RECORD",
          trigger: () => {
            if (failpointFired) return;
            failpointFired = true;
            throw new Error("activation failpoint");
          },
        },
      },
      { transactionalActivation: true },
    );
    await seedConstitutionalAuthority(stack);
    const { institutionId, constitutionalMandateId } =
      await seedConstitutionalInstitution(stack);

    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Org desk failpoint",
      rationale: "rollback proof",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId,
          name: "Failpoint Desk",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    const baseFingerprint = proposal.baseGovernanceFingerprint;
    await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.analyzeProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    const { decisionId } = await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewer,
      nonce: "failpoint-review",
    });
    const { activationRecordId, activationProofId } =
      await stageConstitutionalActivation({
        stack,
        proposal,
        constitutionalMandateId,
        reviewDecisionId: decisionId,
      });

    await expect(
      stack.constitutional.activate({
        proposalId: proposal.constitutionalChangeProposalId,
        activatorPrincipalId: CONST_PRINCIPALS.constitutionalActivator,
        activationRecordId,
        institutionalAuthorizationProofId: activationProofId,
        reviewDecisionId: decisionId,
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
      }),
    ).rejects.toThrow("activation failpoint");

    const units = await stack.service.listOrganizationalUnits(institutionId);
    expect(units.some((u) => u.name === "Failpoint Desk")).toBe(false);
    const record = await stack.constitutionalDeps.activationRecords.getById(
      activationRecordId,
    );
    expect(record?.status).toBe("STAGED");
    expect(
      (await stack.constitutional.getProposal(proposal.constitutionalChangeProposalId))
        .status,
    ).toBe("STAGED");

    const institution = (await stack.service.getInstitution(institutionId))!;
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const fpAfterFail = computeGovernanceStateFingerprint({
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
    expect(fpAfterFail).toBe(baseFingerprint);

    const activated = await stack.constitutional.activate({
      proposalId: proposal.constitutionalChangeProposalId,
      activatorPrincipalId: CONST_PRINCIPALS.constitutionalActivator,
      activationRecordId,
      institutionalAuthorizationProofId: activationProofId,
      reviewDecisionId: decisionId,
      projectId: GOV_PROJECT_ID,
      environment: GOV_ENV_STAGING,
    });
    expect(activated.record.status).toBe("ACTIVATED");
    expect(activated.record.targetGovernanceFingerprint).not.toBe(baseFingerprint);
    const unitsAfter = await stack.service.listOrganizationalUnits(institutionId);
    expect(unitsAfter.some((u) => u.name === "Failpoint Desk")).toBe(true);
  });

  it("binds target fingerprint on successful activation", async () => {
    const stack = buildConstitutionalService({}, { transactionalActivation: true });
    await seedConstitutionalAuthority(stack);
    const { institutionId, constitutionalMandateId } =
      await seedConstitutionalInstitution(stack);

    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Target fp",
      rationale: "bind",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId,
          name: "Target FP Desk",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.analyzeProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    const { decisionId } = await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewer,
      nonce: "target-fp-review",
    });
    const { activationRecordId, activationProofId } =
      await stageConstitutionalActivation({
        stack,
        proposal,
        constitutionalMandateId,
        reviewDecisionId: decisionId,
      });
    const { record } = await stack.constitutional.activate({
      proposalId: proposal.constitutionalChangeProposalId,
      activatorPrincipalId: CONST_PRINCIPALS.constitutionalActivator,
      activationRecordId,
      institutionalAuthorizationProofId: activationProofId,
      reviewDecisionId: decisionId,
      projectId: GOV_PROJECT_ID,
      environment: GOV_ENV_STAGING,
    });

    const institution = (await stack.service.getInstitution(institutionId))!;
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const units = await stack.service.listOrganizationalUnits(institutionId);
    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const recomputed = computeGovernanceStateFingerprint({
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
    expect(record.targetGovernanceFingerprint).toBe(recomputed);
    expect(record.baseGovernanceFingerprint).toBe(proposal.baseGovernanceFingerprint);
  });

  it("detects material activation idempotency conflict", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId, constitutionalMandateId } =
      await seedConstitutionalInstitution(stack);

    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Idempotency",
      rationale: "conflict",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId,
          name: "Idempotent Desk",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.analyzeProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    const { decisionId } = await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewer,
      nonce: "idempotency-review",
    });
    const { activationRecordId, activationProofId } =
      await stageConstitutionalActivation({
        stack,
        proposal,
        constitutionalMandateId,
        reviewDecisionId: decisionId,
      });

    await stack.constitutionalDeps.proposals.save({
      ...(await stack.constitutional.getProposal(
        proposal.constitutionalChangeProposalId,
      )),
      proposalHash: `${proposal.proposalHash}_tampered`,
    });

    await expect(
      stack.constitutional.activate({
        proposalId: proposal.constitutionalChangeProposalId,
        activatorPrincipalId: CONST_PRINCIPALS.constitutionalActivator,
        activationRecordId,
        institutionalAuthorizationProofId: activationProofId,
        reviewDecisionId: decisionId,
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expectConstitutionalError(error, "CONSTITUTIONAL_ACTIVATION_CONFLICT");
      return true;
    });
  });

  it("reviewer proof stale after grant revocation blocks activation", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId, constitutionalMandateId } =
      await seedConstitutionalInstitution(stack);

    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Revoke reviewer",
      rationale: "stale proof",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId,
          name: "Revoke Desk",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.analyzeProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    const { decisionId } = await attestConstitutionalReview({
      stack,
      proposal,
      constitutionalMandateId,
      reviewerPrincipalId: CONST_PRINCIPALS.constitutionalReviewer,
      nonce: "revoke-reviewer",
    });

    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const reviewerGrant = grants.find(
      (g) =>
        g.principalId === CONST_PRINCIPALS.constitutionalReviewer &&
        g.authorityRole === "CONSTITUTIONAL_REVIEWER",
    );
    expect(reviewerGrant).toBeDefined();
    await stack.service.revokeTarget({
      targetType: "DIRECT_GRANT",
      targetId: reviewerGrant!.grantId,
      reason: "revoke for stale review",
      principalId: PRINCIPALS.govAdmin,
    });
    await stack.canonicalAuthority.seed({
      principalId: CONST_PRINCIPALS.constitutionalReviewer,
      authorityRole: "CONSTITUTIONAL_REVIEWER",
      projectId: GOV_PROJECT_ID,
      environmentScope: [GOV_ENV_STAGING],
      effectiveUntil: "2027-01-01T00:00:00.000Z",
      grantId: `${reviewerGrant!.grantId}_g2`,
    });

    await expect(
      stageConstitutionalActivation({
        stack,
        proposal,
        constitutionalMandateId,
        reviewDecisionId: decisionId,
        nonce: "revoke-activator",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      expect(isGovernanceError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("GOVERNANCE_PROOF_STALE");
      return true;
    });
  });
});
