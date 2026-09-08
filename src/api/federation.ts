import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { FederationOrchestrationService } from "../federation/service.js";
import { isFederationError } from "../federation/errors.js";
import { FEDERATION_ACTIONS } from "../federation/doctrine.js";
import { FederationInstitutionPairSchema, FederationResourceRequestCeilingSchema } from "../federation/scope.js";

const FederationParams = z.object({ federationId: z.string().min(1) }).strict();
const IntentParams = z.object({ intentId: z.string().min(1) }).strict();

const ProposeAgreementBody = z
  .object({
    participantInstitutionIds: z.array(z.string().min(1)).min(2),
    permittedPairs: z.array(FederationInstitutionPairSchema).min(1),
    permittedSourceProjectIds: z.array(z.string().min(1)).min(1),
    permittedTargetProjectIds: z.array(z.string().min(1)).min(1),
    permittedEnvironments: z.array(z.string().min(1)).min(1),
    permittedIntentKinds: z.array(z.literal("OBJECTIVE")).min(1),
    evidenceSharingClasses: z.array(z.string().min(1)).optional(),
    maximumResourceRequest: FederationResourceRequestCeilingSchema.optional(),
    effectiveFrom: z.string().datetime(),
    effectiveUntil: z.string().datetime().optional(),
    allowedActions: z.array(z.enum(FEDERATION_ACTIONS)).min(1),
    proposingInstitutionId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    federationId: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const RatifyBody = z
  .object({
    agreementId: z.string().min(1),
    institutionId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    ratifierPrincipalId: z.string().min(1).optional(),
  })
  .strict();

const ActivateBody = z
  .object({
    agreementId: z.string().min(1),
    actorPrincipalId: z.string().min(1).optional(),
  })
  .strict();

const WithdrawBody = z
  .object({
    agreementId: z.string().min(1),
    institutionId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    actorPrincipalId: z.string().min(1).optional(),
    changeType: z.enum(["WITHDRAW", "SUSPEND"]).optional(),
  })
  .strict();

const ProposeIntentBody = z
  .object({
    agreementId: z.string().min(1),
    sourceInstitutionId: z.string().min(1),
    sourceProjectId: z.string().min(1),
    targetInstitutionId: z.string().min(1),
    targetProjectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    requestedOutcome: z.string().min(1).max(8000),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    constraints: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    priority: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]).optional(),
    deadline: z.string().datetime().optional(),
    resourceRequest: FederationResourceRequestCeilingSchema.optional(),
    evidenceReferences: z.array(z.string().min(1)).optional(),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const DecideIntentBody = z
  .object({
    institutionalAuthorizationProofId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    actorPrincipalId: z.string().min(1).optional(),
    reason: z.string().max(4000).optional(),
  })
  .strict();

const MaterializeBody = z
  .object({
    /** Optional clock override for tests; requester is never taken from body. */
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

const EvidenceBody = z
  .object({
    agreementId: z.string().min(1),
    sourceInstitutionId: z.string().min(1),
    sourceProjectId: z.string().min(1),
    sourceEvidenceId: z.string().min(1),
    sourceVerificationId: z.string().min(1).optional(),
    contentHash: z.string().min(1),
    destinationInstitutionId: z.string().min(1),
    destinationProjectId: z.string().min(1),
    dataClassification: z.string().min(1),
    provenance: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
    intentId: z.string().min(1).optional(),
    institutionalAuthorizationProofId: z.string().min(1).optional(),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForFederation(code: string): number {
  switch (code) {
    case "FEDERATION_NOT_FOUND":
      return 404;
    case "FEDERATION_CAS_CONFLICT":
    case "FEDERATION_BASE_STATE_STALE":
    case "FEDERATION_STATE_CONFLICT":
    case "FEDERATED_MATERIALIZATION_CONFLICT":
      return 409;
    case "FEDERATION_AUTHORITY_REQUIRED":
    case "FEDERATED_REQUESTER_AUTHORITY_REQUIRED":
    case "FEDERATED_ACCEPTANCE_DENIED":
      return 403;
    default:
      return 400;
  }
}

export function registerFederationRoutes(
  app: FastifyInstance,
  deps: {
    federationService: FederationOrchestrationService;
  },
): void {
  const svc = deps.federationService;

  app.post("/v1/federations", async (request, reply) => {
    try {
      const body = ProposeAgreementBody.parse(request.body);
      const agreement = await svc.proposeAgreement({
        participantInstitutionIds: body.participantInstitutionIds,
        scope: {
          participantInstitutionIds: body.participantInstitutionIds,
          permittedPairs: body.permittedPairs,
          permittedSourceProjectIds: body.permittedSourceProjectIds,
          permittedTargetProjectIds: body.permittedTargetProjectIds,
          permittedEnvironments: body.permittedEnvironments,
          permittedIntentKinds: body.permittedIntentKinds,
          evidenceSharingClasses: body.evidenceSharingClasses ?? [],
          ...(body.maximumResourceRequest !== undefined
            ? { maximumResourceRequest: body.maximumResourceRequest }
            : {}),
          effectiveFrom: body.effectiveFrom,
          ...(body.effectiveUntil !== undefined
            ? { effectiveUntil: body.effectiveUntil }
            : {}),
        },
        allowedActions: body.allowedActions,
        proposingInstitutionId: body.proposingInstitutionId,
        proposedByPrincipalId: principalId(request),
        projectId: body.projectId,
        environment: body.environment,
        ...(body.federationId !== undefined
          ? { federationId: body.federationId }
          : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      });
      return reply.code(201).send(agreement);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/federations/:federationId", async (request, reply) => {
    try {
      const { federationId } = FederationParams.parse(request.params);
      const agreement = await svc.getFederation(federationId);
      if (!agreement) {
        return reply
          .code(404)
          .send({ code: "FEDERATION_NOT_FOUND", message: "Not found" });
      }
      return reply.send(agreement);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/federations/:federationId/ratifications", async (request, reply) => {
    try {
      FederationParams.parse(request.params);
      const body = RatifyBody.parse(request.body);
      const ratification = await svc.ratify({
        agreementId: body.agreementId,
        institutionId: body.institutionId,
        ratifierPrincipalId:
          body.ratifierPrincipalId ?? principalId(request),
        institutionalAuthorizationProofId:
          body.institutionalAuthorizationProofId,
        projectId: body.projectId,
        environment: body.environment,
      });
      return reply.code(201).send(ratification);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/federations/:federationId/activate", async (request, reply) => {
    try {
      FederationParams.parse(request.params);
      const body = ActivateBody.parse(request.body);
      const result = await svc.activate({
        agreementId: body.agreementId,
        actorPrincipalId: body.actorPrincipalId ?? principalId(request),
      });
      return reply.send(result);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/federations/:federationId/withdrawals", async (request, reply) => {
    try {
      FederationParams.parse(request.params);
      const body = WithdrawBody.parse(request.body);
      const change = await svc.withdraw({
        agreementId: body.agreementId,
        institutionId: body.institutionId,
        actorPrincipalId: body.actorPrincipalId ?? principalId(request),
        institutionalAuthorizationProofId:
          body.institutionalAuthorizationProofId,
        projectId: body.projectId,
        environment: body.environment,
        ...(body.changeType !== undefined ? { changeType: body.changeType } : {}),
      });
      return reply.code(201).send(change);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/federations/:federationId/intents", async (request, reply) => {
    try {
      FederationParams.parse(request.params);
      const body = ProposeIntentBody.parse(request.body);
      const intent = await svc.proposeWorkIntent({
        agreementId: body.agreementId,
        sourceInstitutionId: body.sourceInstitutionId,
        sourceProjectId: body.sourceProjectId,
        targetInstitutionId: body.targetInstitutionId,
        targetProjectId: body.targetProjectId,
        requestedEnvironment: body.requestedEnvironment,
        requestedOutcome: body.requestedOutcome,
        acceptanceCriteria: body.acceptanceCriteria,
        ...(body.constraints !== undefined
          ? { constraints: body.constraints }
          : {}),
        ...(body.nonGoals !== undefined ? { nonGoals: body.nonGoals } : {}),
        ...(body.priority !== undefined ? { priority: body.priority } : {}),
        ...(body.deadline !== undefined ? { deadline: body.deadline } : {}),
        ...(body.resourceRequest !== undefined
          ? { resourceRequest: body.resourceRequest }
          : {}),
        ...(body.evidenceReferences !== undefined
          ? { evidenceReferences: body.evidenceReferences }
          : {}),
        proposedByPrincipalId: principalId(request),
        projectId: body.projectId,
        environment: body.environment,
        ...(body.institutionalAuthorizationProofId !== undefined
          ? {
              institutionalAuthorizationProofId:
                body.institutionalAuthorizationProofId,
            }
          : {}),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      });
      return reply.code(201).send(intent);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/federation-intents/:intentId/accept", async (request, reply) => {
    try {
      const { intentId } = IntentParams.parse(request.params);
      const body = DecideIntentBody.parse(request.body);
      const acceptance = await svc.acceptWork({
        intentId,
        actorPrincipalId: body.actorPrincipalId ?? principalId(request),
        institutionalAuthorizationProofId:
          body.institutionalAuthorizationProofId,
        projectId: body.projectId,
        environment: body.environment,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      return reply.send(acceptance);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/federation-intents/:intentId/reject", async (request, reply) => {
    try {
      const { intentId } = IntentParams.parse(request.params);
      const body = DecideIntentBody.parse(request.body);
      const acceptance = await svc.rejectWork({
        intentId,
        actorPrincipalId: body.actorPrincipalId ?? principalId(request),
        institutionalAuthorizationProofId:
          body.institutionalAuthorizationProofId,
        projectId: body.projectId,
        environment: body.environment,
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });
      return reply.send(acceptance);
    } catch (error) {
      if (isFederationError(error)) {
        return reply
          .code(httpStatusForFederation(error.code))
          .send({ code: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/federation-intents/:intentId/materialize",
    async (request, reply) => {
      try {
        const params = IntentParams.safeParse(request.params);
        if (!params.success) {
          return reply.code(400).send({
            code: "FEDERATED_INTENT_INVALID",
            message: "Invalid intentId",
          });
        }
        const body = MaterializeBody.safeParse(request.body ?? {});
        if (!body.success) {
          return reply.code(400).send({
            code: "FEDERATED_REQUESTER_AUTHORITY_REQUIRED",
            message:
              "Materialize body must not carry targetLocalRequesterId or unknown fields; requester is authenticated principal only",
          });
        }
        // Target-local requester is the authenticated principal only —
        // never body/header/query requesterId (source cannot inject target authority).
        const targetLocalRequesterId = principalId(request);
        if (
          !targetLocalRequesterId ||
          targetLocalRequesterId === "anonymous"
        ) {
          return reply.code(403).send({
            code: "FEDERATED_REQUESTER_AUTHORITY_REQUIRED",
            message:
              "Authenticated target-local principal required for materialization",
          });
        }
        const result = await svc.materializeWork({
          intentId: params.data.intentId,
          targetLocalRequesterId,
          ...(body.data.submittedAt !== undefined
            ? { submittedAt: body.data.submittedAt }
            : {}),
        });
        return reply.send(result);
      } catch (error) {
        if (isFederationError(error)) {
          return reply
            .code(httpStatusForFederation(error.code))
            .send({ code: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/federation-intents/:intentId/evidence",
    async (request, reply) => {
      try {
        const { intentId } = IntentParams.parse(request.params);
        const body = EvidenceBody.parse(request.body);
        const envelope = await svc.shareEvidence({
          agreementId: body.agreementId,
          sourceInstitutionId: body.sourceInstitutionId,
          sourceProjectId: body.sourceProjectId,
          sourceEvidenceId: body.sourceEvidenceId,
          ...(body.sourceVerificationId !== undefined
            ? { sourceVerificationId: body.sourceVerificationId }
            : {}),
          contentHash: body.contentHash,
          destinationInstitutionId: body.destinationInstitutionId,
          destinationProjectId: body.destinationProjectId,
          dataClassification: body.dataClassification,
          provenance: body.provenance,
          sharedByPrincipalId: principalId(request),
          projectId: body.projectId,
          environment: body.environment,
          intentId,
          ...(body.institutionalAuthorizationProofId !== undefined
            ? {
                institutionalAuthorizationProofId:
                  body.institutionalAuthorizationProofId,
              }
            : {}),
        });
        return reply.code(201).send(envelope);
      } catch (error) {
        if (isFederationError(error)) {
          return reply
            .code(httpStatusForFederation(error.code))
            .send({ code: error.code, message: error.message });
        }
        throw error;
      }
    },
  );
}
