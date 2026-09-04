import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { EXAMPLE_ENVIRONMENT } from "../../control-plane/fixtures.js";
import { compileReviewSubjectBinding } from "../../constitutional/review.js";
import { ConstitutionalActivationCapability } from "../../constitutional/activation-capability.js";
import { PostgresHealthService } from "./health.js";
import {
  createTestStack,
  uniquePostgresTestId,
} from "./test-helpers.js";
import {
  authorizeExistingProposal,
  activatePreparedProposal,
  computeInstitutionFingerprint,
  countActivatedRecordsForProposal,
  countAuditEventsForProposal,
  countOrgUnitsByName,
  createAuthorizedProposal,
  createConcurrentStack,
  createP21ApiServer,
  isStaleBaseError,
  lookupGrantId,
  p21LifecycleFromAnchor,
  P21_ACTIVATOR,
  P21_GOV_ADMIN,
  P21_REVIEWER_A,
  seedP21Authority,
  setupConstitutionalInstitution,
} from "./postgres.phase21.helpers.js";

describe("Phase 21 constitutional change control (postgres)", () => {
  it("reports migration 016 schema compatibility on fresh database", async () => {
    const env = await createTestStack(uniquePostgresTestId("p21-schema"));
    try {
      const health = await new PostgresHealthService(env.db, "postgres").readiness();
      expect(health.supportedSchemaVersion).toBe(
        "016_phase21_constitutional_change_control",
      );
      expect(health.supportedSchemaVersion).toBe(SUPPORTED_SCHEMA_VERSION);
      expect(health.schemaCompatible).toBe(true);
    } finally {
      await env.close();
    }
  });

  it(
    "A: primary constitutional ladder with target fingerprint restart integrity",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-ladder"));
      const projectId = uniquePostgresTestId("proj_p21_ladder");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 1);
        const prepared = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Constitutional Desk",
          title: "Primary ladder",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });
        expect(prepared.baseFingerprint).toBeTruthy();

        const activated = await activatePreparedProposal({
          stack: env.stack,
          prepared,
          activationAt: lifecycle.activationAt,
        });
        expect(activated.record.status).toBe("ACTIVATED");
        expect(activated.record.baseGovernanceFingerprint).toBe(
          prepared.baseFingerprint,
        );
        expect(activated.record.targetGovernanceFingerprint).not.toBe(
          prepared.baseFingerprint,
        );
        expect(
          await countActivatedRecordsForProposal(env.db, prepared.proposalId),
        ).toBe(1);
        expect(
          await countAuditEventsForProposal(
            env.db,
            prepared.proposalId,
            "ACTIVATED",
          ),
        ).toBe(1);
        expect(
          await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
        ).toBe(1);

        const env2 = await createTestStack(uniquePostgresTestId("p21-restart"));
        try {
          const reloaded =
            await env2.stack.constitutionalService.getProposal(
              prepared.proposalId,
            );
          expect(reloaded.status).toBe("ACTIVATED");
          const fingerprint = await computeInstitutionFingerprint(
            env2.stack,
            institutionId,
            projectId,
          );
          expect(fingerprint).toBe(activated.record.targetGovernanceFingerprint);
          expect(
            ConstitutionalActivationCapability.isCapability(
              activated.capability,
            ),
          ).toBe(true);
        } finally {
          await env2.close();
        }
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "B: competing proposals with same base fingerprint serialize to one activation",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-compete"));
      const projectId = uniquePostgresTestId("proj_p21_compete");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 2);
        const p1 = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Compete Desk A",
          title: "Compete P1",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });
        const p2 = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Compete Desk B",
          title: "Compete P2",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });
        expect(p1.baseFingerprint).toBe(p2.baseFingerprint);

        const stackA = await createConcurrentStack(env.db, "compete-a");
        const stackB = await createConcurrentStack(env.db, "compete-b");
        try {
          const [resultA, resultB] = await Promise.allSettled([
            activatePreparedProposal({ stack: stackA, prepared: p1, activationAt: lifecycle.activationAt }),
            activatePreparedProposal({ stack: stackB, prepared: p2, activationAt: lifecycle.activationAt }),
          ]);

          const fulfilled = [resultA, resultB].filter(
            (r) => r.status === "fulfilled",
          );
          const rejected = [resultA, resultB].filter(
            (r) => r.status === "rejected",
          );
          expect(fulfilled).toHaveLength(1);
          expect(rejected).toHaveLength(1);
          expect(isStaleBaseError((rejected[0] as PromiseRejectedResult).reason)).toBe(
            true,
          );

          const winner = fulfilled[0] as PromiseFulfilledResult<
            Awaited<ReturnType<typeof activatePreparedProposal>>
          >;
          expect(winner.value.record.status).toBe("ACTIVATED");
          const winnerFingerprint = winner.value.record.targetGovernanceFingerprint;

          expect(
            (await countActivatedRecordsForProposal(env.db, p1.proposalId)) +
              (await countActivatedRecordsForProposal(env.db, p2.proposalId)),
          ).toBe(1);

          const loserProposalId =
            winner.value.record.proposalId === p1.proposalId
              ? p2.proposalId
              : p1.proposalId;
          const loser = await env.stack.constitutionalService.getProposal(
            loserProposalId,
          );
          expect(loser.status).toBe("STALE");
          expect(loser.baseGovernanceFingerprint).toBe(p1.baseFingerprint);

          const envRestart = await createTestStack(
            uniquePostgresTestId("p21-compete-restart"),
          );
          try {
            const fingerprint = await computeInstitutionFingerprint(
              envRestart.stack,
              institutionId,
              projectId,
            );
            expect(fingerprint).toBe(winnerFingerprint);
          } finally {
            await envRestart.close();
          }
        } finally {
          await stackA.close();
          await stackB.close();
        }
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "same-proposal concurrent activation is idempotent with one material transition",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-idem"));
      const projectId = uniquePostgresTestId("proj_p21_idem");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 3);
        const prepared = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Idempotent Desk",
          title: "Idempotent",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });

        const stackA = await createConcurrentStack(env.db, "idem-a");
        const stackB = await createConcurrentStack(env.db, "idem-b");
        try {
          const [resultA, resultB] = await Promise.allSettled([
            activatePreparedProposal({ stack: stackA, prepared, activationAt: lifecycle.activationAt }),
            activatePreparedProposal({ stack: stackB, prepared, activationAt: lifecycle.activationAt }),
          ]);
          const outcomes = [resultA, resultB].map((r) =>
            r.status === "fulfilled" ? "ok" : "err",
          );
          expect(outcomes.filter((o) => o === "ok").length).toBeGreaterThanOrEqual(1);

          expect(
            await countActivatedRecordsForProposal(env.db, prepared.proposalId),
          ).toBe(1);
          expect(
            await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
          ).toBe(1);

          const record =
            await env.stack.constitutionalService.getProposal(prepared.proposalId);
          expect(record.status).toBe("ACTIVATED");
        } finally {
          await stackA.close();
          await stackB.close();
        }
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "C: activation failpoint rolls back material writes then retry succeeds once",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-fail-setup"));
      const projectId = uniquePostgresTestId("proj_p21_fail");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 4);
        const prepared = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Failpoint Desk",
          title: "Failpoint",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });
        const baseFingerprint = prepared.baseFingerprint;

        let failpointFired = false;
        const failStack = await createConcurrentStack(env.db, "failpoint", {
          constitutionalActivationFailpoint: {
            name: "AFTER_TARGET_GOVERNANCE_WRITE_BEFORE_ACTIVATION_RECORD",
            trigger: () => {
              if (failpointFired) return;
              failpointFired = true;
              throw new Error("postgres activation failpoint");
            },
          },
        });
        try {
          await expect(
            activatePreparedProposal({
              stack: failStack,
              prepared,
              activationAt: lifecycle.activationAt,
            }),
          ).rejects.toThrow("postgres activation failpoint");
        } finally {
          await failStack.close();
        }

        const envReload = await createTestStack(
          uniquePostgresTestId("p21-fail-reload"),
        );
        try {
          const fingerprint = await computeInstitutionFingerprint(
            envReload.stack,
            institutionId,
            projectId,
          );
          expect(fingerprint).toBe(baseFingerprint);
          expect(
            await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
          ).toBe(0);
          expect(
            await countActivatedRecordsForProposal(env.db, prepared.proposalId),
          ).toBe(0);
          expect(
            await countAuditEventsForProposal(
              env.db,
              prepared.proposalId,
              "ACTIVATED",
            ),
          ).toBe(0);
          const proposal = await envReload.stack.constitutionalService.getProposal(
            prepared.proposalId,
          );
          expect(proposal.status).toBe("STAGED");
        } finally {
          await envReload.close();
        }

        const retryStack = await createConcurrentStack(env.db, "fail-retry");
        try {
          const activated = await activatePreparedProposal({
            stack: retryStack,
            prepared,
            activationAt: lifecycle.retryAt,
          });
          expect(activated.record.status).toBe("ACTIVATED");
          expect(
            await countActivatedRecordsForProposal(env.db, prepared.proposalId),
          ).toBe(1);
          expect(
            await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
          ).toBe(1);
          expect(
            await countAuditEventsForProposal(
              env.db,
              prepared.proposalId,
              "ACTIVATED",
            ),
          ).toBe(1);
        } finally {
          await retryStack.close();
        }
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "D: reviewer revocation leaves historical proof stale and blocks activation",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-rev-reviewer"));
      const projectId = uniquePostgresTestId("proj_p21_rev_reviewer");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId, enableControl: false },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 5);
        const prepared = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Reviewer Revoke Desk",
          title: "Reviewer revoke",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
          stage: false,
        });

        const g1 = await lookupGrantId(
          env.db,
          projectId,
          P21_REVIEWER_A,
          "CONSTITUTIONAL_REVIEWER",
        );
        await env.stack.governanceService.revokeTarget({
          targetType: "DIRECT_GRANT",
          targetId: g1,
          reason: "reviewer revocation provenance test",
          principalId: P21_GOV_ADMIN,
          effectiveAt: lifecycle.revocationEffectiveAt,
        });
        await seedP21Authority(env.db, projectId, [
          {
            principalId: `${P21_REVIEWER_A}_g2`,
            principalType: "CONSTITUTIONAL_REVIEWER",
          },
        ]);

        await env.stack.constitutionalService.enableConstitutionalControl({
          institutionId,
          actorPrincipalId: P21_GOV_ADMIN,
        });

        await expect(
          env.stack.constitutionalService.stageActivation({
            proposalId: prepared.proposalId,
            activatorPrincipalId: P21_ACTIVATOR,
            institutionalAuthorizationProofId: prepared.activationProofId,
            reviewDecisionId: prepared.reviewDecisionId,
            projectId,
            environment: EXAMPLE_ENVIRONMENT,
            atIso: lifecycle.postRevocationAt,
          }),
        ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });

        expect(
          await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
        ).toBe(0);
        expect(
          await countActivatedRecordsForProposal(env.db, prepared.proposalId),
        ).toBe(0);

        const envRestart = await createTestStack(
          uniquePostgresTestId("p21-rev-reviewer-restart"),
        );
        try {
          await expect(
            envRestart.stack.constitutionalService.stageActivation({
              proposalId: prepared.proposalId,
              activatorPrincipalId: P21_ACTIVATOR,
              institutionalAuthorizationProofId: prepared.activationProofId,
              reviewDecisionId: prepared.reviewDecisionId,
              projectId,
              environment: EXAMPLE_ENVIRONMENT,
              atIso: lifecycle.postRevocationAt,
            }),
          ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
        } finally {
          await envRestart.close();
        }
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "E: activator revocation blocks activation while review remains valid",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-rev-activator"));
      const projectId = uniquePostgresTestId("proj_p21_rev_activator");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 6);
        const prepared = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Activator Revoke Desk",
          title: "Activator revoke",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });

        const a1 = await lookupGrantId(
          env.db,
          projectId,
          P21_ACTIVATOR,
          "CONSTITUTIONAL_ACTIVATOR",
        );
        await env.stack.governanceService.revokeTarget({
          targetType: "DIRECT_GRANT",
          targetId: a1,
          reason: "activator revocation provenance test",
          principalId: P21_GOV_ADMIN,
          effectiveAt: lifecycle.revocationEffectiveAt,
        });

        await expect(
          activatePreparedProposal({
            stack: env.stack,
            prepared,
            activationAt: lifecycle.postRevocationAt,
          }),
        ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });

        const proposal = await env.stack.constitutionalService.getProposal(
          prepared.proposalId,
        );
        expect(proposal.status).not.toBe("ACTIVATED");
        expect(
          await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
        ).toBe(0);

        const envRestart = await createTestStack(
          uniquePostgresTestId("p21-rev-activator-restart"),
        );
        try {
          await expect(
            activatePreparedProposal({
              stack: envRestart.stack,
              prepared,
              activationAt: lifecycle.postRevocationAt,
            }),
          ).rejects.toMatchObject({ code: "GOVERNANCE_PROOF_STALE" });
        } finally {
          await envRestart.close();
        }
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "F: old quorum governs relaxation adoption then new rule applies after activation",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-quorum"));
      const projectId = uniquePostgresTestId("proj_p21_quorum");
      try {
        await seedP21Authority(env.db, projectId);
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 7);
        const { institutionId, mandateId } = await setupConstitutionalInstitution({
          stack: env.stack,
          projectId,
          enableControl: false,
          quorumRequirement: {
            kind: "K_OF_N",
            k: 3,
            n: 5,
            roles: ["CONSTITUTIONAL_REVIEWER"],
            rejectBlocksImmediately: false,
          },
        });
        await env.stack.constitutionalService.enableConstitutionalControl({
          institutionId,
          actorPrincipalId: P21_GOV_ADMIN,
        });

        await seedP21Authority(env.db, projectId, [
          {
            principalId: `${P21_ACTIVATOR}_b`,
            principalType: "CONSTITUTIONAL_ACTIVATOR",
          },
          {
            principalId: `${P21_ACTIVATOR}_c`,
            principalType: "CONSTITUTIONAL_ACTIVATOR",
          },
        ]);

        const constitutional = env.stack.constitutionalService;
        const governance = env.stack.governanceService;
        const proposal = await constitutional.createProposal({
          institutionId,
          title: "Relax quorum",
          rationale: "3-of-5 to 2-of-2",
          changeOperations: [
            {
              kind: "CHANGE_MANDATE_QUORUM",
              mandateId,
              quorumRequirement: {
                kind: "K_OF_N",
                k: 2,
                n: 2,
                roles: ["CONSTITUTIONAL_REVIEWER"],
                rejectBlocksImmediately: false,
              },
            },
          ],
          riskClass: "HIGH",
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
          projectIds: [projectId],
          environmentScope: [EXAMPLE_ENVIRONMENT],
          mandateIds: [mandateId],
          expiresAt: lifecycle.caseExpiresAt,
        });
        await governance.attest({
          governanceCaseId: reviewCase.governanceCaseId,
          principalId: P21_REVIEWER_A,
          authorityRole: "CONSTITUTIONAL_REVIEWER",
          decision: "APPROVE",
          nonce: `nonce-quorum-one-${proposal.constitutionalChangeProposalId}`,
        });
        expect(
          (await constitutional.getProposal(proposal.constitutionalChangeProposalId))
            .status,
        ).not.toBe("AUTHORIZED");

        const authorized = await authorizeExistingProposal({
          stack: env.stack,
          proposalId: proposal.constitutionalChangeProposalId,
          proposalHash: proposal.proposalHash,
          proposalVersion: proposal.proposalVersion,
          institutionId,
          projectId,
          mandateId,
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
          requiredReviewCount: 3,
          requiredActivationCount: 3,
        });
        expect(
          (await constitutional.getProposal(proposal.constitutionalChangeProposalId))
            .status,
        ).toBe("STAGED");

        const activated = await constitutional.activate({
          proposalId: proposal.constitutionalChangeProposalId,
          activatorPrincipalId: P21_ACTIVATOR,
          activationRecordId: authorized.activationRecordId,
          institutionalAuthorizationProofId: authorized.activationProofId,
          reviewDecisionId: authorized.reviewDecisionId,
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          atIso: lifecycle.activationAt,
        });
        expect(activated.record.status).toBe("ACTIVATED");

        const envRestart = await createTestStack(
          uniquePostgresTestId("p21-quorum-restart"),
        );
        try {
          const mandates =
            await envRestart.stack.governanceService.listActiveMandatesByProject(
              projectId,
            );
          const constitutionalMandate = mandates.find((m) =>
            m.subjectClasses.includes("CONSTITUTIONAL_CHANGE"),
          );
          expect(constitutionalMandate?.quorumRequirement?.kind).toBe("K_OF_N");
          if (constitutionalMandate?.quorumRequirement?.kind === "K_OF_N") {
            expect(constitutionalMandate.quorumRequirement.k).toBe(2);
            expect(constitutionalMandate.quorumRequirement.n).toBe(2);
          }
        } finally {
          await envRestart.close();
        }
      } finally {
        await env.close();
      }
    },
    90_000,
  );

  it(
    "old SoD governs SoD-removal review in postgres",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-sod"));
      const projectId = uniquePostgresTestId("proj_p21_sod");
      try {
        await seedP21Authority(env.db, projectId);
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 8);
        const { institutionId, mandateId } = await setupConstitutionalInstitution({
          stack: env.stack,
          projectId,
          enableControl: false,
          separationOfDutyRules: [
            {
              ruleId: "sod_reviewer_admin",
              kind: "FORBID_SAME_PRINCIPAL",
              roleA: "CONSTITUTIONAL_REVIEWER",
              roleB: "GOVERNANCE_ADMIN",
              notes: "Reviewer cannot be admin proposer",
            },
          ],
        });
        await env.stack.constitutionalService.enableConstitutionalControl({
          institutionId,
          actorPrincipalId: P21_GOV_ADMIN,
        });
        await seedP21Authority(env.db, projectId, [
          {
            principalId: P21_GOV_ADMIN,
            principalType: "CONSTITUTIONAL_REVIEWER",
          },
        ]);

        const constitutional = env.stack.constitutionalService;
        const governance = env.stack.governanceService;
        const proposal = await constitutional.createProposal({
          institutionId,
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

        const reviewCase = await governance.openGovernanceCase({
          subjectType: "CONSTITUTIONAL_CHANGE_REVIEW",
          subjectId: proposal.constitutionalChangeProposalId,
          subjectVersion: proposal.proposalVersion,
          subjectHash: proposal.proposalHash,
          requiredRole: "CONSTITUTIONAL_REVIEWER",
          action: "CONSTITUTIONAL_REVIEW",
          projectIds: [projectId],
          environmentScope: [EXAMPLE_ENVIRONMENT],
          mandateIds: [mandateId],
          expiresAt: lifecycle.caseExpiresAt,
        });
        const reviewAttest = await governance.attest({
          governanceCaseId: reviewCase.governanceCaseId,
          principalId: P21_GOV_ADMIN,
          authorityRole: "CONSTITUTIONAL_REVIEWER",
          decision: "APPROVE",
          nonce: `nonce-sod-self-${proposal.constitutionalChangeProposalId}`,
        });
        await expect(
          constitutional.recordReviewDecision({
            proposalId: proposal.constitutionalChangeProposalId,
            reviewerPrincipalId: P21_GOV_ADMIN,
            institutionalAuthorizationProofId:
              reviewAttest.proof!.institutionalAuthorizationProofId,
            decision: "APPROVE",
            projectId,
            environment: EXAMPLE_ENVIRONMENT,
            atIso: lifecycle.reviewAt,
          }),
        ).rejects.toMatchObject({ code: "CONSTITUTIONAL_SEPARATION_VIOLATION" });

        const valid = await authorizeExistingProposal({
          stack: env.stack,
          proposalId: proposal.constitutionalChangeProposalId,
          proposalHash: proposal.proposalHash,
          proposalVersion: proposal.proposalVersion,
          institutionId,
          projectId,
          mandateId,
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
          requiredReviewCount: 1,
        });
        const activated = await env.stack.constitutionalService.activate({
          proposalId: proposal.constitutionalChangeProposalId,
          activatorPrincipalId: P21_ACTIVATOR,
          activationRecordId: valid.activationRecordId,
          institutionalAuthorizationProofId: valid.activationProofId,
          reviewDecisionId: valid.reviewDecisionId,
          projectId,
          environment: EXAMPLE_ENVIRONMENT,
          atIso: lifecycle.activationAt,
        });
        expect(activated.record.status).toBe("ACTIVATED");
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "G: direct Phase20 protected mutations rejected when constitutional control enabled",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-bypass"));
      const projectId = uniquePostgresTestId("proj_p21_bypass");
      try {
        await seedP21Authority(env.db, projectId);
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 9);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId, enableControl: false },
        );
        const governance = env.stack.governanceService;
        const seedUnit = await governance.createOrganizationalUnit({
          institutionId,
          name: "Bypass Seed OU",
          description: "",
          projectScope: [projectId],
        });
        await env.stack.constitutionalService.enableConstitutionalControl({
          institutionId,
          actorPrincipalId: P21_GOV_ADMIN,
        });
        const reject = async (fn: () => Promise<unknown>) => {
          await expect(fn()).rejects.toMatchObject({
            code: "CONSTITUTIONAL_MUTATION_BYPASS_DENIED",
          });
        };

        await reject(() =>
          governance.createMandate({
            institutionId,
            createdBy: P21_GOV_ADMIN,
            subjectClasses: ["PORTFOLIO_PLAN"],
            requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
            projectScope: [projectId],
            environmentScope: [EXAMPLE_ENVIRONMENT],
          }),
        );
        await reject(() =>
          governance.activateMandate({
            mandateId,
            actorPrincipalId: P21_GOV_ADMIN,
          }),
        );
        await reject(() =>
          governance.supersedeMandate({
            mandateId,
            actorPrincipalId: P21_GOV_ADMIN,
          }),
        );
        await reject(() =>
          governance.createOrganizationalUnit({
            institutionId,
            name: "Bypass OU",
            description: "",
            projectScope: [projectId],
          }),
        );
        const unitId = seedUnit.organizationalUnitId;
        await reject(() =>
          governance.updateOrganizationalUnit({
            organizationalUnitId: unitId,
            parentUnitId: undefined,
            actorPrincipalId: P21_GOV_ADMIN,
          }),
        );
        await reject(() =>
          governance.retireOrganizationalUnit({
            organizationalUnitId: unitId,
            actorPrincipalId: P21_GOV_ADMIN,
          }),
        );
        await reject(() =>
          governance.updateInstitutionProjectScope({
            institutionId,
            projectScope: [projectId],
            actorPrincipalId: P21_GOV_ADMIN,
          }),
        );

        const prepared = await createAuthorizedProposal({
          stack: env.stack,
          institutionId,
          projectId,
          mandateId,
          orgUnitName: "Legitimate Desk",
          title: "Legitimate activation",
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });
        const activated = await activatePreparedProposal({
          stack: env.stack,
          prepared,
          activationAt: lifecycle.activationAt,
        });
        expect(activated.capability).toBeDefined();
        expect(
          await countOrgUnitsByName(env.db, institutionId, prepared.orgUnitName),
        ).toBe(1);
      } finally {
        await env.close();
      }
    },
    60_000,
  );

  it(
    "API bypass cannot inject activation capability; legitimate Phase21 route succeeds",
    async () => {
      const env = await createTestStack(uniquePostgresTestId("p21-api"));
      const projectId = uniquePostgresTestId("proj_p21_api");
      try {
        await seedP21Authority(env.db, projectId);
        const { institutionId, mandateId } = await setupConstitutionalInstitution(
          { stack: env.stack, projectId },
        );
        const lifecycle = p21LifecycleFromAnchor(env.stack.clock.nowIso(), 10);
        const app = await createP21ApiServer(env.stack, projectId);
        const apiPrincipal = { "x-orchestrator-principal": P21_GOV_ADMIN };

        const bypass = await app.inject({
          method: "POST",
          url: "/v1/governance/mandates",
          headers: apiPrincipal,
          payload: {
            institutionId,
            subjectClasses: ["PORTFOLIO_PLAN"],
            requiredAuthorities: ["PORTFOLIO_ALLOCATOR"],
            projectScope: [projectId],
            environmentScope: [EXAMPLE_ENVIRONMENT],
          },
        });
        expect(bypass.statusCode).toBeGreaterThanOrEqual(400);
        expect(bypass.json()).toMatchObject({
          error: "CONSTITUTIONAL_MUTATION_BYPASS_DENIED",
        });

        const createResp = await app.inject({
          method: "POST",
          url: "/v1/constitutional/changes",
          headers: apiPrincipal,
          payload: {
            institutionId,
            title: "API desk",
            rationale: "api path",
            riskClass: "LOW",
            changeOperations: [
              {
                kind: "CREATE_ORGANIZATIONAL_UNIT",
                institutionId,
                name: "API Desk",
                description: "",
                projectScope: [projectId],
              },
            ],
          },
        });
        expect(createResp.statusCode).toBe(201);
        const proposalId = createResp.json().constitutionalChangeProposalId as string;
        const proposal =
          await env.stack.constitutionalService.getProposal(proposalId);

        await app.inject({
          method: "POST",
          url: `/v1/constitutional/changes/${proposalId}/submit`,
          headers: apiPrincipal,
        });
        await app.inject({
          method: "POST",
          url: `/v1/constitutional/changes/${proposalId}/analyze`,
          headers: apiPrincipal,
        });

        const authorized = await authorizeExistingProposal({
          stack: env.stack,
          proposalId,
          proposalHash: proposal.proposalHash,
          proposalVersion: proposal.proposalVersion,
          institutionId,
          projectId,
          mandateId,
          reviewAt: lifecycle.reviewAt,
          activationAuthorizationAt: lifecycle.activationAuthorizationAt,
        });

        const activateResp = await app.inject({
          method: "POST",
          url: `/v1/constitutional/changes/${proposalId}/activate`,
          headers: apiPrincipal,
          payload: {
            activationRecordId: authorized.activationRecordId,
            institutionalAuthorizationProofId: authorized.activationProofId,
            reviewDecisionId: authorized.reviewDecisionId,
            projectId,
            environment: EXAMPLE_ENVIRONMENT,
          },
        });
        expect(activateResp.statusCode).toBe(200);
        expect(activateResp.json().targetGovernanceFingerprint).toBeTruthy();
        expect(activateResp.json().record?.status).toBe("ACTIVATED");
        expect(activateResp.json().capability).toBeUndefined();

        await app.close();
      } finally {
        await env.close();
      }
    },
    90_000,
  );

  it("activation failpoint is not reachable from production HTTP or env wiring", () => {
    const stackSource = readFileSync("src/infrastructure/postgres/stack.ts", "utf8");
    const serverSource = readFileSync("src/api/server.ts", "utf8");
    const constitutionalApi = readFileSync("src/api/constitutional.ts", "utf8");
    expect(stackSource).toContain("constitutionalActivationFailpoint");
    expect(stackSource).not.toMatch(/process\.env.*activationFailpoint/);
    expect(serverSource).not.toContain("activationFailpoint");
    expect(constitutionalApi).not.toContain("activationFailpoint");
    expect(constitutionalApi).not.toContain("activationCapability");
    expect(constitutionalApi).not.toContain("constitutionalBypass");
  });
});
