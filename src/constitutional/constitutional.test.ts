import { describe, expect, it } from "vitest";
import {
  assertConstitutionalSafetyFloor,
  computeGovernanceStateFingerprint,
  computeProposalHash,
  detectProposalMaterialChange,
  isConstitutionalError,
  isProposalMaterialImmutable,
  type ConstitutionalError,
} from "./index.js";
import {
  buildConstitutionalService,
  CONST_CASE_EXPIRES,
  CONST_PRINCIPALS,
  GOV_ENV_STAGING,
  GOV_PROJECT_ID,
  PRINCIPALS,
  seedConstitutionalAuthority,
  seedConstitutionalInstitution,
} from "./test-fixtures.js";
import { selectConstitutionalRoleGrants } from "./fingerprint.js";
import { isGovernanceError } from "../governance/errors.js";
import { compileReviewSubjectBinding } from "./review.js";

function expectConstitutionalError(
  err: unknown,
  code: ConstitutionalError["code"],
): asserts err is ConstitutionalError {
  expect(isConstitutionalError(err)).toBe(true);
  expect((err as ConstitutionalError).code).toBe(code);
}

describe("Phase 21 constitutional change control", () => {
  it("A: governance admin creates proposal without activation authority", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Quorum tightening",
      rationale: "Increase review bar",
      changeOperations: [
        {
          kind: "CHANGE_MANDATE_QUORUM",
          mandateId: "gmd_placeholder",
          quorumRequirement: {
            kind: "K_OF_N",
            k: 2,
            n: 3,
            roles: ["CONSTITUTIONAL_REVIEWER"],
            rejectBlocksImmediately: false,
          },
        },
      ],
      riskClass: "MEDIUM",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    expect(proposal.status).toBe("DRAFT");
    await expect(
      stack.constitutional.activate({
        proposalId: proposal.constitutionalChangeProposalId,
        activatorPrincipalId: PRINCIPALS.govAdmin,
        activationRecordId: "missing",
        institutionalAuthorizationProofId: "missing",
        reviewDecisionId: "missing",
        projectId: GOV_PROJECT_ID,
        environment: GOV_ENV_STAGING,
      }),
    ).rejects.toMatchObject({ code: "CONSTITUTIONAL_ACTIVATION_REQUIRED" });
  });

  it("B: proposal material is immutable after submission", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId, constitutionalMandateId } =
      await seedConstitutionalInstitution(stack);
    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Org unit",
      rationale: "Add desk",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId,
          name: "Risk Desk",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    const submitted = await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    expect(isProposalMaterialImmutable(submitted.status)).toBe(true);
    expect(submitted.changeOperations[0]?.kind).toBe("CREATE_ORGANIZATIONAL_UNIT");
    void constitutionalMandateId;
  });

  it("C: proposal hash changes when material operation changes", () => {
    const base = {
      constitutionalChangeProposalId: "ccp_test",
      institutionId: "inst_test",
      proposalVersion: 1,
      title: "t",
      rationale: "r",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT" as const,
          institutionId: "inst_test",
          name: "A",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW" as const,
      proposedByPrincipalId: PRINCIPALS.govAdmin,
      baseGovernanceFingerprint: "fp1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const h1 = computeProposalHash(base);
    const h2 = computeProposalHash({
      ...base,
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId: "inst_test",
          name: "B",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
    });
    expect(h1).not.toBe(h2);
    expect(
      detectProposalMaterialChange(
        { ...base, proposalHash: h1, status: "DRAFT", recordRevision: 1 },
        { ...base, status: "DRAFT" },
      ),
    ).toBe(false);
  });

  it("D: base governance fingerprint is deterministic", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const institution = await stack.service.getInstitution(institutionId);
    expect(institution).not.toBeNull();
    const mandates = await stack.service.listActiveMandatesByProject(GOV_PROJECT_ID);
    const units = await stack.service.listOrganizationalUnits(institutionId);
    const grants = await stack.canonicalAuthority.listByProject!(GOV_PROJECT_ID);
    const fpInput = {
      institutionId,
      mandates: mandates.filter((m) => m.institutionId === institutionId),
      organizationalUnits: units,
      constitutionalControlEnabled: true,
      institutionProjectIds: institution!.projectIds,
      constitutionalRoleGrants: selectConstitutionalRoleGrants(
        grants,
        institution!.projectIds,
      ),
      constitutionalRevocationIds: [] as string[],
    };
    const fp1 = computeGovernanceStateFingerprint(fpInput);
    const fp2 = computeGovernanceStateFingerprint(fpInput);
    expect(fp1).toBe(fp2);
  });

  it("E: safety-floor violating proposal rejected", () => {
    expect(() =>
      assertConstitutionalSafetyFloor([
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
          deleteHistoricalRecords: true,
        },
      ]),
    ).toThrowError(
      expect.objectContaining({ code: "CONSTITUTIONAL_SAFETY_FLOOR_VIOLATION" }),
    );
  });

  it("M: governance admin scope change is constitutional binding only", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const proposal = await stack.constitutional.createProposal({
      institutionId,
      title: "Admin scope binding",
      rationale: "constitutional institution project scope",
      changeOperations: [
        {
          kind: "CHANGE_GOVERNANCE_ADMIN_SCOPE",
          institutionId,
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "MEDIUM",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    const submitted = await stack.constitutional.submitProposal({
      proposalId: proposal.constitutionalChangeProposalId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    expect(submitted.status).toBe("SUBMITTED");
  });

  it("O: stale base fingerprint blocks submit after governance drift", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const institution = await stack.service.createInstitution({
      name: "Drift Test",
      projectIds: [GOV_PROJECT_ID],
    });
    const proposal = await stack.constitutional.createProposal({
      institutionId: institution.institutionId,
      title: "Stale",
      rationale: "drift",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId: institution.institutionId,
          name: "Desk",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    await stack.constitutional.enableConstitutionalControl({
      institutionId: institution.institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    await expect(
      stack.constitutional.submitProposal({
        proposalId: proposal.constitutionalChangeProposalId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      }),
    ).rejects.toMatchObject({ code: "CONSTITUTIONAL_BASE_STATE_STALE" });
  });

  it("protected mandate mutation denied when constitutional control enabled", async () => {
    const stack = buildConstitutionalService();
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    await stack.constitutional.enableConstitutionalControl({
      institutionId,
      actorPrincipalId: PRINCIPALS.govAdmin,
    });
    try {
      await stack.service.createMandate({
        institutionId,
        createdBy: PRINCIPALS.govAdmin,
        subjectClasses: ["PORTFOLIO_PLAN"],
        requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
        projectScope: [GOV_PROJECT_ID],
        environmentScope: [GOV_ENV_STAGING],
      });
      expect.fail("expected bypass denial");
    } catch (error) {
      expect(isGovernanceError(error)).toBe(true);
      expect((error as { code: string }).code).toBe(
        "CONSTITUTIONAL_MUTATION_BYPASS_DENIED",
      );
    }
  });

  it("review subject binding is exact", () => {
    const binding = compileReviewSubjectBinding({
      proposalId: "ccp_1",
      proposalVersion: 1,
      proposalHash: "hash_1",
    });
    expect(binding).toEqual({
      subjectType: "CONSTITUTIONAL_CHANGE_REVIEW",
      subjectId: "ccp_1",
      subjectVersion: 1,
      subjectHash: "hash_1",
      requiredRole: "CONSTITUTIONAL_REVIEWER",
    });
  });

  it("S: reversal requires a new proposal version", async () => {
    const stack = buildConstitutionalService({}, { mutableClock: true });
    await seedConstitutionalAuthority(stack);
    const { institutionId } = await seedConstitutionalInstitution(stack);
    const p1 = await stack.constitutional.createProposal({
      institutionId,
      title: "Forward",
      rationale: "change",
      changeOperations: [
        {
          kind: "CREATE_ORGANIZATIONAL_UNIT",
          institutionId,
          name: "Desk A",
          description: "",
          projectScope: [GOV_PROJECT_ID],
        },
      ],
      riskClass: "LOW",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    if ("advance" in stack.clock) {
      stack.clock.advance(1_000);
    }
    const p2 = await stack.constitutional.createProposal({
      institutionId,
      title: "Reversal",
      rationale: "undo via new proposal",
      changeOperations: [
        {
          kind: "RETIRE_ORGANIZATIONAL_UNIT",
          organizationalUnitId: "ou_future",
        },
      ],
      riskClass: "MEDIUM",
      proposedByPrincipalId: PRINCIPALS.govAdmin,
    });
    expect(p2.proposalVersion).toBe(1);
    expect(p2.constitutionalChangeProposalId).not.toBe(
      p1.constitutionalChangeProposalId,
    );
    void CONST_CASE_EXPIRES;
  });
});
