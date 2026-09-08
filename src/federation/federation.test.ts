import { describe, expect, it } from "vitest";
import {
  computeAgreementHash,
  withAgreementHash,
} from "./agreement.js";
import {
  assertExhaustiveFederationAction,
  describeFederationAction,
  FEDERATION_ACTIONS,
  FEDERATION_DOCTRINE,
} from "./doctrine.js";
import { FederationError, isFederationError } from "./errors.js";
import {
  canonicalizeParticipantIds,
  computeScopeHash,
} from "./scope.js";
import {
  acceptWithProof,
  bilateralScope,
  buildFederationService,
  FED_PRINCIPALS,
  FED_PROJECT_A,
  FED_PROJECT_B,
  FED_PROJECT_C,
  GOV_ENV_STAGING,
  GOV_TEST_NOW,
  PRINCIPALS,
  ratifyWithProof,
  seedBilateralInstitutions,
  seedFederationAuthority,
} from "./test-fixtures.js";
import { compileWithdrawalSubjectBinding } from "./participation.js";
import { openFederationCaseAndProof } from "./test-fixtures.js";

describe("Phase 22 federation", () => {
  describe("hashing and participants", () => {
    it("agreement hashing is deterministic", async () => {
      const stack = buildFederationService();
      const { institutionA, institutionB, projectA, projectB } =
        await seedBilateralInstitutions(stack);
      const a1 = await stack.federation.proposeAgreement({
        participantInstitutionIds: [institutionB, institutionA],
        scope: bilateralScope({
          institutionA,
          institutionB,
          projectA,
          projectB,
        }),
        allowedActions: ["PROPOSE_OBJECTIVE", "SHARE_EVIDENCE"],
        proposingInstitutionId: institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: projectA,
        environment: GOV_ENV_STAGING,
      });
      const recomputed = computeAgreementHash(a1);
      expect(recomputed).toBe(a1.agreementHash);
      const again = withAgreementHash({ ...a1, agreementHash: "x" });
      expect(again.agreementHash).toBe(a1.agreementHash);
    });

    it("participant ordering is canonical", () => {
      expect(canonicalizeParticipantIds(["z", "a", "m"])).toEqual([
        "a",
        "m",
        "z",
      ]);
    });

    it("rejects <2 participants", () => {
      expect(() => canonicalizeParticipantIds(["only"])).toThrow(
        FederationError,
      );
      try {
        canonicalizeParticipantIds(["only"]);
      } catch (e) {
        expect(isFederationError(e) && e.code).toBe(
          "FEDERATION_PARTICIPANT_INVALID",
        );
      }
    });

    it("rejects duplicate participants", () => {
      expect(() => canonicalizeParticipantIds(["a", "a"])).toThrow(
        FederationError,
      );
    });

    it("scope hash is stable under pair reorder", () => {
      const scope1 = {
        participantInstitutionIds: ["a", "b"],
        permittedPairs: [
          { sourceInstitutionId: "a", targetInstitutionId: "b" },
          { sourceInstitutionId: "b", targetInstitutionId: "a" },
        ],
        permittedSourceProjectIds: ["p1"],
        permittedTargetProjectIds: ["p2"],
        permittedEnvironments: ["staging"],
        permittedIntentKinds: ["OBJECTIVE" as const],
        evidenceSharingClasses: [],
        effectiveFrom: GOV_TEST_NOW,
      };
      const scope2 = {
        ...scope1,
        permittedPairs: [...scope1.permittedPairs].reverse(),
      };
      expect(computeScopeHash(scope1)).toBe(computeScopeHash(scope2));
    });
  });

  describe("ratification and activation", () => {
    it("requires all participants to ratify; A cannot satisfy B", async () => {
      const stack = buildFederationService();
      const ids = await seedBilateralInstitutions(stack);
      const agreement = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });
      await expect(
        stack.federation.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: PRINCIPALS.govAdmin,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_RATIFICATION_REQUIRED" });
    });

    it("G1 revoked + G2 equivalent cannot repair old ratification", async () => {
      const stack = buildFederationService({ mutableClock: true });
      const ids = await seedBilateralInstitutions(stack);
      const agreement = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });

      // Ratify B with G1
      const grantsBefore = await stack.canonicalAuthority.listByPrincipal(
        FED_PRINCIPALS.ratifierB,
      );
      const g1 = grantsBefore.find(
        (g) =>
          g.authorityRole === "FEDERATION_RATIFIER" &&
          g.projectId === ids.projectB,
      );
      expect(g1).toBeDefined();
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
      });

      // Revoke G1, create equivalent G2
      await stack.canonicalAuthority.markDisabled(g1!.grantId);
      await stack.canonicalAuthority.seed({
        principalId: FED_PRINCIPALS.ratifierB,
        authorityRole: "FEDERATION_RATIFIER",
        projectId: ids.projectB,
        environmentScope: [GOV_ENV_STAGING],
      });

      await expect(
        stack.federation.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: PRINCIPALS.govAdmin,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_RATIFICATION_STALE" });
    });

    it("activation creates zero operational authority", async () => {
      const stack = buildFederationService();
      const ids = await seedBilateralInstitutions(stack);
      const agreement = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      const { agreement: active, activation } = await stack.federation.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });
      expect(active.status).toBe("ACTIVE");
      expect(activation.status).toBe("ACTIVATED");
      expect(stack.admitCalls).toHaveLength(0);
      const audits = await stack.federationDeps.audits.listByAgreement(
        agreement.agreementId,
      );
      expect(
        audits.some(
          (a) =>
            a.eventType === "AGREEMENT_ACTIVATED" &&
            a.payload["createsZeroOperationalAuthority"] === true,
        ),
      ).toBe(true);
    });
  });

  describe("no transitive trust", () => {
    it("A↔B + B↔C does not authorize A→C", async () => {
      const stack = buildFederationService();
      await seedFederationAuthority(stack);
      const instA = await stack.service.createInstitution({
        name: "A",
        projectIds: [FED_PROJECT_A],
      });
      const instB = await stack.service.createInstitution({
        name: "B",
        projectIds: [FED_PROJECT_B],
      });
      const instC = await stack.service.createInstitution({
        name: "C",
        projectIds: [FED_PROJECT_C],
      });

      async function activatePair(
        source: { id: string; project: string; negotiator: string; ratifier: string },
        target: { id: string; project: string; ratifier: string },
      ) {
        const agreement = await stack.federation.proposeAgreement({
          participantInstitutionIds: [source.id, target.id],
          scope: {
            participantInstitutionIds: [source.id, target.id],
            permittedPairs: [
              {
                sourceInstitutionId: source.id,
                targetInstitutionId: target.id,
              },
            ],
            permittedSourceProjectIds: [source.project],
            permittedTargetProjectIds: [target.project],
            permittedEnvironments: [GOV_ENV_STAGING],
            permittedIntentKinds: ["OBJECTIVE"],
            evidenceSharingClasses: [],
            effectiveFrom: GOV_TEST_NOW,
          },
          allowedActions: ["PROPOSE_OBJECTIVE"],
          proposingInstitutionId: source.id,
          proposedByPrincipalId: source.negotiator,
          projectId: source.project,
          environment: GOV_ENV_STAGING,
        });
        await ratifyWithProof(stack, {
          agreementId: agreement.agreementId,
          institutionId: source.id,
          projectId: source.project,
          ratifierPrincipalId: source.ratifier,
        });
        await ratifyWithProof(stack, {
          agreementId: agreement.agreementId,
          institutionId: target.id,
          projectId: target.project,
          ratifierPrincipalId: target.ratifier,
        });
        await stack.federation.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: PRINCIPALS.govAdmin,
        });
        return agreement;
      }

      const ab = await activatePair(
        {
          id: instA.institutionId,
          project: FED_PROJECT_A,
          negotiator: FED_PRINCIPALS.negotiatorA,
          ratifier: FED_PRINCIPALS.ratifierA,
        },
        {
          id: instB.institutionId,
          project: FED_PROJECT_B,
          ratifier: FED_PRINCIPALS.ratifierB,
        },
      );
      await activatePair(
        {
          id: instB.institutionId,
          project: FED_PROJECT_B,
          negotiator: FED_PRINCIPALS.negotiatorA,
          ratifier: FED_PRINCIPALS.ratifierB,
        },
        {
          id: instC.institutionId,
          project: FED_PROJECT_C,
          ratifier: FED_PRINCIPALS.ratifierA,
        },
      );

      await expect(
        stack.federation.proposeWorkIntent({
          agreementId: ab.agreementId,
          sourceInstitutionId: instA.institutionId,
          sourceProjectId: FED_PROJECT_A,
          targetInstitutionId: instC.institutionId,
          targetProjectId: FED_PROJECT_C,
          requestedEnvironment: GOV_ENV_STAGING,
          requestedOutcome: "do work at C",
          acceptanceCriteria: ["done"],
          proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
          projectId: FED_PROJECT_A,
          environment: GOV_ENV_STAGING,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_TRANSITIVE_TRUST_DENIED" });
      expect(FEDERATION_DOCTRINE.noTransitiveTrust).toContain("A↔B + B↔C");
    });
  });

  describe("work lifecycle boundaries", () => {
    async function activeBilateral() {
      const stack = buildFederationService();
      const ids = await seedBilateralInstitutions(stack);
      const agreement = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE", "SHARE_EVIDENCE", "REQUEST_RESOURCES"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      await stack.federation.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });
      return { stack, ids, agreement };
    }

    it("acceptance creates zero Run; materialization requires target-local requester", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "federated objective",
        acceptanceCriteria: ["verified"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
        resourceRequest: { cpuMillis: 100 },
      });
      expect(stack.admitCalls).toHaveLength(0);
      await acceptWithProof(stack, {
        intentId: intent.intentId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        acceptorPrincipalId: FED_PRINCIPALS.acceptorB,
      });
      expect(stack.admitCalls).toHaveLength(0);

      await expect(
        stack.federation.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: "",
        }),
      ).rejects.toMatchObject({
        code: "FEDERATED_REQUESTER_AUTHORITY_REQUIRED",
      });

      const { materialization, admission } =
        await stack.federation.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: FED_PRINCIPALS.requesterB,
        });
      expect(admission.outcome).toBe("ADMITTED");
      expect(stack.admitCalls).toHaveLength(1);
      const admitArg = stack.admitCalls[0] as { requesterId: string; projectId: string };
      expect(admitArg.requesterId).toBe(FED_PRINCIPALS.requesterB);
      expect(admitArg.projectId).toBe(ids.projectB);
      expect(materialization.runId).toBeTruthy();

      // idempotency
      const again = await stack.federation.materializeWork({
        intentId: intent.intentId,
        targetLocalRequesterId: FED_PRINCIPALS.requesterB,
      });
      expect(again.materialization.materializationId).toBe(
        materialization.materializationId,
      );
      expect(stack.admitCalls).toHaveLength(1);
    });

    it("source cannot provide target requester authority via intent", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "x",
        acceptanceCriteria: ["y"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      // Intent schema has no requesterId field — source cannot bind target requester.
      expect(
        Object.prototype.hasOwnProperty.call(intent, "requesterId"),
      ).toBe(false);
    });

    it("project/environment containment rejects out-of-scope target", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      await expect(
        stack.federation.proposeWorkIntent({
          agreementId: agreement.agreementId,
          sourceInstitutionId: ids.institutionA,
          sourceProjectId: ids.projectA,
          targetInstitutionId: ids.institutionB,
          targetProjectId: "proj_not_permitted",
          requestedEnvironment: GOV_ENV_STAGING,
          requestedOutcome: "x",
          acceptanceCriteria: ["y"],
          proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
          projectId: ids.projectA,
          environment: GOV_ENV_STAGING,
        }),
      ).rejects.toMatchObject({ code: "FEDERATED_TARGET_SCOPE_DENIED" });
    });

    it("federation resource request != local reservation", async () => {
      const { stack } = await activeBilateral();
      expect(stack.federation.federationResourceRequestIsNotReservation()).toBe(
        true,
      );
      expect(FEDERATION_DOCTRINE.resourceLimitNotReservation).toContain(
        "LOCAL_BUDGET_RESERVATION",
      );
    });

    it("external evidence remains untrusted", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      const envelope = await stack.federation.shareEvidence({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        sourceEvidenceId: "ev_1",
        contentHash: "abc123",
        destinationInstitutionId: ids.institutionB,
        destinationProjectId: ids.projectB,
        dataClassification: "INTERNAL",
        provenance: "source-run",
        sharedByPrincipalId: FED_PRINCIPALS.evidenceA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      expect(envelope.receivingStatus).toBe("EXTERNAL_UNVERIFIED");
      expect(stack.admitCalls).toHaveLength(0);
    });

    it("withdrawal blocks new intents; historical materialization survives", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "keep me",
        acceptanceCriteria: ["ok"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await acceptWithProof(stack, {
        intentId: intent.intentId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        acceptorPrincipalId: FED_PRINCIPALS.acceptorB,
      });
      const { materialization } = await stack.federation.materializeWork({
        intentId: intent.intentId,
        targetLocalRequesterId: FED_PRINCIPALS.requesterB,
      });

      const subject = compileWithdrawalSubjectBinding({
        federationId: agreement.federationId,
        agreementId: agreement.agreementId,
        agreementVersion: agreement.agreementVersion,
        agreementHash: agreement.agreementHash,
        institutionId: ids.institutionB,
      });
      const { proofId } = await openFederationCaseAndProof(stack, {
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        requiredRole: subject.requiredRole,
        action: subject.action,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        subjectHash: subject.subjectHash,
        subjectVersion: subject.subjectVersion,
        attestorPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      await stack.federation.withdraw({
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        actorPrincipalId: FED_PRINCIPALS.ratifierB,
        institutionalAuthorizationProofId: proofId,
        projectId: ids.projectB,
        environment: GOV_ENV_STAGING,
      });

      await expect(
        stack.federation.proposeWorkIntent({
          agreementId: agreement.agreementId,
          sourceInstitutionId: ids.institutionA,
          sourceProjectId: ids.projectA,
          targetInstitutionId: ids.institutionB,
          targetProjectId: ids.projectB,
          requestedEnvironment: GOV_ENV_STAGING,
          requestedOutcome: "new after withdraw",
          acceptanceCriteria: ["no"],
          proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
          projectId: ids.projectA,
          environment: GOV_ENV_STAGING,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_SUSPENDED" });

      const kept = await stack.federationDeps.materializations.getByIntent(
        intent.intentId,
      );
      expect(kept?.runId).toBe(materialization.runId);
      const hist = await stack.federation.getAgreement(agreement.agreementId);
      expect(hist.agreementHash).toBe(agreement.agreementHash);
    });

    it("A. accepted intent cannot materialize after withdrawal", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "accepted then blocked",
        acceptanceCriteria: ["ok"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await acceptWithProof(stack, {
        intentId: intent.intentId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        acceptorPrincipalId: FED_PRINCIPALS.acceptorB,
      });
      expect(stack.admitCalls).toHaveLength(0);

      const subject = compileWithdrawalSubjectBinding({
        federationId: agreement.federationId,
        agreementId: agreement.agreementId,
        agreementVersion: agreement.agreementVersion,
        agreementHash: agreement.agreementHash,
        institutionId: ids.institutionB,
      });
      const { proofId } = await openFederationCaseAndProof(stack, {
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        requiredRole: subject.requiredRole,
        action: subject.action,
        subjectType: subject.subjectType,
        subjectId: subject.subjectId,
        subjectHash: subject.subjectHash,
        subjectVersion: subject.subjectVersion,
        attestorPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      await stack.federation.withdraw({
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        actorPrincipalId: FED_PRINCIPALS.ratifierB,
        institutionalAuthorizationProofId: proofId,
        projectId: ids.projectB,
        environment: GOV_ENV_STAGING,
      });

      await expect(
        stack.federation.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: FED_PRINCIPALS.requesterB,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_SUSPENDED" });
      expect(stack.admitCalls).toHaveLength(0);
      expect(
        await stack.federationDeps.materializations.getByIntent(intent.intentId),
      ).toBeNull();
    });

    it("C. superseded agreement cannot materialize old accepted intent", async () => {
      const { stack, ids, agreement: v1 } = await activeBilateral();
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: v1.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "bound to v1",
        acceptanceCriteria: ["ok"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await acceptWithProof(stack, {
        intentId: intent.intentId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        acceptorPrincipalId: FED_PRINCIPALS.acceptorB,
      });

      // v2: same federation, scope no longer permits A→B OBJECTIVE work.
      const v2 = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        federationId: v1.federationId,
        scope: {
          ...bilateralScope(ids),
          permittedPairs: [
            {
              sourceInstitutionId: ids.institutionB,
              targetInstitutionId: ids.institutionA,
            },
          ],
          permittedSourceProjectIds: [ids.projectB],
          permittedTargetProjectIds: [ids.projectA],
        },
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: v2.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });
      await ratifyWithProof(stack, {
        agreementId: v2.agreementId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      await stack.federation.activate({
        agreementId: v2.agreementId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });
      const superseded = await stack.federation.getAgreement(v1.agreementId);
      expect(superseded.status).toBe("SUPERSEDED");

      await expect(
        stack.federation.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: FED_PRINCIPALS.requesterB,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_NOT_ACTIVE" });
      expect(stack.admitCalls).toHaveLength(0);
      expect(
        await stack.federationDeps.materializations.getByIntent(intent.intentId),
      ).toBeNull();
      // No silent rebase onto v2
      expect(intent.agreementId).toBe(v1.agreementId);
      expect(intent.agreementHash).toBe(v1.agreementHash);
    });

    it("E. unauthorized target-local requester fails Phase2 with zero materialization", async () => {
      const stack = buildFederationService({
        admit: async () => ({
          outcome: "REJECTED",
          reasonCode: "REQUESTER_UNAUTHORIZED",
          message: "requester lacks Phase2 authority",
        }),
      });
      const ids = await seedBilateralInstitutions(stack);
      const agreement = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      await stack.federation.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "needs requester",
        acceptanceCriteria: ["ok"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await acceptWithProof(stack, {
        intentId: intent.intentId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        acceptorPrincipalId: FED_PRINCIPALS.acceptorB,
      });
      await expect(
        stack.federation.materializeWork({
          intentId: intent.intentId,
          targetLocalRequesterId: "unauthorized_stranger",
        }),
      ).rejects.toMatchObject({ code: "FEDERATED_MATERIALIZATION_FAILED" });
      expect(stack.admitCalls).toHaveLength(1);
      expect(
        (stack.admitCalls[0] as { requesterId: string }).requesterId,
      ).toBe("unauthorized_stranger");
      expect(
        await stack.federationDeps.materializations.getByIntent(intent.intentId),
      ).toBeNull();
    });

    it("F/G. source institution cannot ACCEPT or REJECT for target", async () => {
      const { stack, ids, agreement } = await activeBilateral();
      await stack.canonicalAuthority.seed({
        principalId: FED_PRINCIPALS.acceptorA,
        authorityRole: "FEDERATION_WORK_ACCEPTOR",
        projectId: ids.projectA,
        environmentScope: [GOV_ENV_STAGING],
      });
      const intent = await stack.federation.proposeWorkIntent({
        agreementId: agreement.agreementId,
        sourceInstitutionId: ids.institutionA,
        sourceProjectId: ids.projectA,
        targetInstitutionId: ids.institutionB,
        targetProjectId: ids.projectB,
        requestedEnvironment: GOV_ENV_STAGING,
        requestedOutcome: "target owns decision",
        acceptanceCriteria: ["ok"],
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });

      await expect(
        stack.federation.acceptWork({
          intentId: intent.intentId,
          actorPrincipalId: FED_PRINCIPALS.acceptorA,
          institutionalAuthorizationProofId: "proof_forged_source",
          projectId: ids.projectA,
          environment: GOV_ENV_STAGING,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /FEDERATED_TARGET_SCOPE_DENIED|FEDERATION_AUTHORITY_REQUIRED/,
        ),
      });
      await expect(
        stack.federation.rejectWork({
          intentId: intent.intentId,
          actorPrincipalId: FED_PRINCIPALS.acceptorA,
          institutionalAuthorizationProofId: "proof_forged_source",
          projectId: ids.projectA,
          environment: GOV_ENV_STAGING,
        }),
      ).rejects.toMatchObject({
        code: expect.stringMatching(
          /FEDERATED_TARGET_SCOPE_DENIED|FEDERATION_AUTHORITY_REQUIRED/,
        ),
      });

      // Source acceptor with target project still lacks target-local grant.
      await expect(
        stack.federation.acceptWork({
          intentId: intent.intentId,
          actorPrincipalId: FED_PRINCIPALS.acceptorA,
          institutionalAuthorizationProofId: "proof_forged_source",
          projectId: ids.projectB,
          environment: GOV_ENV_STAGING,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_AUTHORITY_REQUIRED" });

      const undecided = await stack.federationDeps.intents.getById(
        intent.intentId,
      );
      expect(undecided?.status).toBe("PROPOSED");
      expect(stack.admitCalls).toHaveLength(0);
      expect(
        await stack.federationDeps.acceptances.getByIntent(intent.intentId),
      ).toBeNull();

      await acceptWithProof(stack, {
        intentId: intent.intentId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        acceptorPrincipalId: FED_PRINCIPALS.acceptorB,
      });
      const accepted = await stack.federationDeps.intents.getById(intent.intentId);
      expect(accepted?.status).toBe("ACCEPTED");
    });
  });

  describe("concurrency / failpoint / actions", () => {
    it("competing agreement version fails stale base", async () => {
      const stack = buildFederationService();
      const ids = await seedBilateralInstitutions(stack);
      const p1 = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      const p2 = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE", "SHARE_EVIDENCE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
        federationId: p1.federationId,
      });
      expect(p1.baseFederationStateFingerprint).toBe(
        p2.baseFederationStateFingerprint,
      );

      for (const agreementId of [p1.agreementId, p2.agreementId]) {
        await ratifyWithProof(stack, {
          agreementId,
          institutionId: ids.institutionA,
          projectId: ids.projectA,
          ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
        });
        await ratifyWithProof(stack, {
          agreementId,
          institutionId: ids.institutionB,
          projectId: ids.projectB,
          ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
        });
      }

      await stack.federation.activate({
        agreementId: p1.agreementId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });
      await expect(
        stack.federation.activate({
          agreementId: p2.agreementId,
          actorPrincipalId: PRINCIPALS.govAdmin,
        }),
      ).rejects.toMatchObject({ code: "FEDERATION_BASE_STATE_STALE" });
    });

    it("activation failpoint rolls back material write", async () => {
      const stack = buildFederationService();
      stack.federationDeps.activationFailpoint = {
        name: "after_material_before_record",
        trigger: () => {
          throw new Error("failpoint");
        },
      };
      const ids = await seedBilateralInstitutions(stack);
      const agreement = await stack.federation.proposeAgreement({
        participantInstitutionIds: [ids.institutionA, ids.institutionB],
        scope: bilateralScope(ids),
        allowedActions: ["PROPOSE_OBJECTIVE"],
        proposingInstitutionId: ids.institutionA,
        proposedByPrincipalId: FED_PRINCIPALS.negotiatorA,
        projectId: ids.projectA,
        environment: GOV_ENV_STAGING,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionA,
        projectId: ids.projectA,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierA,
      });
      await ratifyWithProof(stack, {
        agreementId: agreement.agreementId,
        institutionId: ids.institutionB,
        projectId: ids.projectB,
        ratifierPrincipalId: FED_PRINCIPALS.ratifierB,
      });
      await expect(
        stack.federation.activate({
          agreementId: agreement.agreementId,
          actorPrincipalId: PRINCIPALS.govAdmin,
        }),
      ).rejects.toThrow("failpoint");
      const after = await stack.federation.getAgreement(agreement.agreementId);
      expect(after.status).not.toBe("ACTIVE");
      expect(
        await stack.federationDeps.activationRecords.getByAgreement(
          agreement.agreementId,
        ),
      ).toBeNull();

      delete stack.federationDeps.activationFailpoint;
      const ok = await stack.federation.activate({
        agreementId: agreement.agreementId,
        actorPrincipalId: PRINCIPALS.govAdmin,
      });
      expect(ok.agreement.status).toBe("ACTIVE");
    });

    it("exhaustive federation action handling", () => {
      for (const action of FEDERATION_ACTIONS) {
        expect(describeFederationAction(action).length).toBeGreaterThan(0);
      }
      expect(() =>
        assertExhaustiveFederationAction("NOPE" as never),
      ).toThrow(/Unhandled federation action/);
    });
  });
});
