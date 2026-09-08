import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildServer } from "./server.js";
import { FakeRequestAuthenticator } from "../runtime/auth.js";
import { InMemoryProjectAccessDirectory } from "../runtime/access.js";
import { DrainController } from "../runtime/startup.js";
import { OperationalMetrics } from "../runtime/metrics.js";
import { MemoryStructuredLogger } from "../runtime/logging.js";
import { SlidingWindowRateLimiter } from "../runtime/rate-limit.js";
import {
  acceptWithProof,
  bilateralScope,
  buildFederationService,
  FED_PRINCIPALS,
  GOV_ENV_STAGING,
  PRINCIPALS,
  ratifyWithProof,
  seedBilateralInstitutions,
} from "../federation/test-fixtures.js";

const PublicMaterializeBody = z
  .object({
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

describe("POST /v1/federation-intents/:intentId/materialize", () => {
  it("D. rejects source-supplied targetLocalRequesterId in public body", () => {
    const parsed = PublicMaterializeBody.safeParse({
      targetLocalRequesterId: FED_PRINCIPALS.requesterB,
    });
    expect(parsed.success).toBe(false);
  });

  it("D. derives requester from authenticated principal — body cannot inject R", async () => {
    const stack = buildFederationService({
      admit: async (input: unknown) => {
        const req = input as {
          projectId: string;
          objectiveId: string;
          requesterId: string;
        };
        if (req.requesterId !== FED_PRINCIPALS.requesterB) {
          return {
            outcome: "REJECTED" as const,
            reasonCode: "REQUESTER_UNAUTHORIZED",
            message: "only target-local requester admitted",
          };
        }
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
            createdAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2027-01-01T00:00:00.000Z",
            schemaVersion: "1",
            data: {},
          },
          controlContextReference: {
            projectId: req.projectId,
            environment: GOV_ENV_STAGING,
            policyBundleId: "pol_test",
            budgetProfileId: "bud_test",
            resolvedAt: "2026-01-01T00:00:00.000Z",
          },
          idempotencyKey: `idem_${req.objectiveId}`,
          correlationId: "corr_fed",
          traceId: "trace_fed",
        };
      },
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
      requestedOutcome: "api materialize",
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

    // Source-authenticated caller — body naming B requester must not be trusted.
    const sourceApp = await buildServer({
      federationService: stack.federation,
      perimeter: {
        authenticator: new FakeRequestAuthenticator({
          principalId: FED_PRINCIPALS.negotiatorA,
          authenticationMode: "HEADER_PRINCIPAL",
        }),
        access: new InMemoryProjectAccessDirectory([
          {
            principalId: FED_PRINCIPALS.negotiatorA,
            projectIds: [ids.projectA, ids.projectB],
          },
        ]),
        drain: new DrainController(),
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("fed-api", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(100, 60_000),
        authenticationMode: "HEADER_PRINCIPAL",
      },
    });
    const injectAttempt = await sourceApp.inject({
      method: "POST",
      url: `/v1/federation-intents/${intent.intentId}/materialize`,
      payload: { targetLocalRequesterId: FED_PRINCIPALS.requesterB },
    });
    expect(injectAttempt.statusCode).toBe(400);
    expect(injectAttempt.json().code).toBe(
      "FEDERATED_REQUESTER_AUTHORITY_REQUIRED",
    );
    expect(stack.admitCalls).toHaveLength(0);
    await sourceApp.close();

    // Empty body with source principal uses authenticated identity — Phase2 rejects.
    const sourceApp2 = await buildServer({
      federationService: stack.federation,
      perimeter: {
        authenticator: new FakeRequestAuthenticator({
          principalId: FED_PRINCIPALS.negotiatorA,
          authenticationMode: "HEADER_PRINCIPAL",
        }),
        access: new InMemoryProjectAccessDirectory([
          {
            principalId: FED_PRINCIPALS.negotiatorA,
            projectIds: [ids.projectA, ids.projectB],
          },
        ]),
        drain: new DrainController(),
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("fed-api2", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(100, 60_000),
        authenticationMode: "HEADER_PRINCIPAL",
      },
    });
    const sourceMaterialize = await sourceApp2.inject({
      method: "POST",
      url: `/v1/federation-intents/${intent.intentId}/materialize`,
      payload: {},
    });
    expect(sourceMaterialize.statusCode).toBe(400);
    expect(sourceMaterialize.json().code).toBe(
      "FEDERATED_MATERIALIZATION_FAILED",
    );
    expect(stack.admitCalls).toHaveLength(1);
    expect(
      (stack.admitCalls[0] as { requesterId: string }).requesterId,
    ).toBe(FED_PRINCIPALS.negotiatorA);
    expect(
      await stack.federationDeps.materializations.getByIntent(intent.intentId),
    ).toBeNull();
    await sourceApp2.close();

    // Legitimate B-authenticated requester may materialize.
    stack.admitCalls.length = 0;
    const targetApp = await buildServer({
      federationService: stack.federation,
      perimeter: {
        authenticator: new FakeRequestAuthenticator({
          principalId: FED_PRINCIPALS.requesterB,
          authenticationMode: "HEADER_PRINCIPAL",
        }),
        access: new InMemoryProjectAccessDirectory([
          {
            principalId: FED_PRINCIPALS.requesterB,
            projectIds: [ids.projectB],
          },
        ]),
        drain: new DrainController(),
        metrics: new OperationalMetrics(),
        logger: new MemoryStructuredLogger("fed-api3", () => undefined),
        rateLimiter: new SlidingWindowRateLimiter(100, 60_000),
        authenticationMode: "HEADER_PRINCIPAL",
      },
    });
    const ok = await targetApp.inject({
      method: "POST",
      url: `/v1/federation-intents/${intent.intentId}/materialize`,
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    expect(stack.admitCalls).toHaveLength(1);
    expect(
      (stack.admitCalls[0] as { requesterId: string }).requesterId,
    ).toBe(FED_PRINCIPALS.requesterB);
    await targetApp.close();
  });
});
