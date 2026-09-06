import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ConstitutionalChangeOrchestrationService } from "../constitutional/service.js";
import { isConstitutionalError } from "../constitutional/errors.js";
import { ConstitutionalChangeOperationSchema } from "../constitutional/operations.js";
import { ConstitutionalRiskClassSchema } from "../constitutional/operations.js";

const ProposalParams = z.object({ proposalId: z.string().min(1) }).strict();

const CreateProposalBody = z
  .object({
    institutionId: z.string().min(1),
    title: z.string().min(1).max(500),
    rationale: z.string().min(1).max(8000),
    changeOperations: z.array(ConstitutionalChangeOperationSchema).min(1),
    riskClass: ConstitutionalRiskClassSchema,
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

const ReviewBody = z
  .object({
    reviewerPrincipalId: z.string().min(1).optional(),
    institutionalAuthorizationProofId: z.string().min(1),
    decision: z.enum(["APPROVE", "REJECT"]),
    reason: z.string().max(4000).optional(),
    projectId: z.string().min(1),
    environment: z.string().min(1),
  })
  .strict();

const StageBody = z
  .object({
    activatorPrincipalId: z.string().min(1).optional(),
    institutionalAuthorizationProofId: z.string().min(1),
    reviewDecisionId: z.string().min(1),
    effectiveAt: z.string().datetime().optional(),
    projectId: z.string().min(1),
    environment: z.string().min(1),
  })
  .strict();

const ActivateBody = z
  .object({
    activatorPrincipalId: z.string().min(1).optional(),
    activationRecordId: z.string().min(1),
    institutionalAuthorizationProofId: z.string().min(1),
    reviewDecisionId: z.string().min(1),
    projectId: z.string().min(1),
    environment: z.string().min(1),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForConstitutional(code: string): number {
  switch (code) {
    case "CONSTITUTIONAL_PROPOSAL_NOT_FOUND":
      return 404;
    case "CONSTITUTIONAL_CAS_CONFLICT":
    case "CONSTITUTIONAL_ACTIVATION_CONFLICT":
    case "CONSTITUTIONAL_PROPOSAL_STATE_CONFLICT":
      return 409;
    case "CONSTITUTIONAL_ADMIN_INSUFFICIENT":
    case "CONSTITUTIONAL_SELF_ESCALATION":
    case "CONSTITUTIONAL_SEPARATION_VIOLATION":
      return 403;
    default:
      return 400;
  }
}

export function registerConstitutionalRoutes(
  app: FastifyInstance,
  deps: {
    constitutionalService: ConstitutionalChangeOrchestrationService;
  },
): void {
  app.post("/v1/constitutional/changes", async (request, reply) => {
    const body = CreateProposalBody.parse(request.body);
    try {
      const proposal = await deps.constitutionalService.createProposal({
        institutionId: body.institutionId,
        title: body.title,
        rationale: body.rationale,
        changeOperations: body.changeOperations,
        riskClass: body.riskClass,
        proposedByPrincipalId: principalId(request),
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
      });
      return reply.code(201).send(proposal);
    } catch (error) {
      if (isConstitutionalError(error)) {
        return reply
          .code(httpStatusForConstitutional(error.code))
          .send({ code: error.code, message: error.message, details: error.details });
      }
      throw error;
    }
  });

  app.get("/v1/constitutional/changes/:proposalId", async (request, reply) => {
    const { proposalId } = ProposalParams.parse(request.params);
    try {
      const proposal = await deps.constitutionalService.getProposal(proposalId);
      return proposal;
    } catch (error) {
      if (isConstitutionalError(error)) {
        return reply
          .code(httpStatusForConstitutional(error.code))
          .send({ code: error.code, message: error.message, details: error.details });
      }
      throw error;
    }
  });

  app.post(
    "/v1/constitutional/changes/:proposalId/submit",
    async (request, reply) => {
      const { proposalId } = ProposalParams.parse(request.params);
      try {
        const proposal = await deps.constitutionalService.submitProposal({
          proposalId,
          actorPrincipalId: principalId(request),
        });
        return proposal;
      } catch (error) {
        if (isConstitutionalError(error)) {
          return reply
            .code(httpStatusForConstitutional(error.code))
            .send({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/constitutional/changes/:proposalId/analyze",
    async (request, reply) => {
      const { proposalId } = ProposalParams.parse(request.params);
      try {
        const analysis = await deps.constitutionalService.analyzeProposal({
          proposalId,
          actorPrincipalId: principalId(request),
        });
        return analysis;
      } catch (error) {
        if (isConstitutionalError(error)) {
          return reply
            .code(httpStatusForConstitutional(error.code))
            .send({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/constitutional/changes/:proposalId/review",
    async (request, reply) => {
      const { proposalId } = ProposalParams.parse(request.params);
      const body = ReviewBody.parse(request.body);
      try {
        const decision = await deps.constitutionalService.recordReviewDecision({
          proposalId,
          reviewerPrincipalId: body.reviewerPrincipalId ?? principalId(request),
          institutionalAuthorizationProofId:
            body.institutionalAuthorizationProofId,
          decision: body.decision,
          ...(body.reason !== undefined ? { reason: body.reason } : {}),
          projectId: body.projectId,
          environment: body.environment,
        });
        return decision;
      } catch (error) {
        if (isConstitutionalError(error)) {
          return reply
            .code(httpStatusForConstitutional(error.code))
            .send({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/constitutional/changes/:proposalId/stage",
    async (request, reply) => {
      const { proposalId } = ProposalParams.parse(request.params);
      const body = StageBody.parse(request.body);
      try {
        const record = await deps.constitutionalService.stageActivation({
          proposalId,
          activatorPrincipalId:
            body.activatorPrincipalId ?? principalId(request),
          institutionalAuthorizationProofId:
            body.institutionalAuthorizationProofId,
          reviewDecisionId: body.reviewDecisionId,
          ...(body.effectiveAt !== undefined
            ? { effectiveAt: body.effectiveAt }
            : {}),
          projectId: body.projectId,
          environment: body.environment,
        });
        return record;
      } catch (error) {
        if (isConstitutionalError(error)) {
          return reply
            .code(httpStatusForConstitutional(error.code))
            .send({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/constitutional/changes/:proposalId/activate",
    async (request, reply) => {
      const { proposalId } = ProposalParams.parse(request.params);
      const body = ActivateBody.parse(request.body);
      try {
        const result = await deps.constitutionalService.activate({
          proposalId,
          activatorPrincipalId:
            body.activatorPrincipalId ?? principalId(request),
          activationRecordId: body.activationRecordId,
          institutionalAuthorizationProofId:
            body.institutionalAuthorizationProofId,
          reviewDecisionId: body.reviewDecisionId,
          projectId: body.projectId,
          environment: body.environment,
        });
        return {
          record: result.record,
          institutionId: result.capability.payload.institutionId,
          targetGovernanceFingerprint: result.record.targetGovernanceFingerprint,
        };
      } catch (error) {
        if (isConstitutionalError(error)) {
          return reply
            .code(httpStatusForConstitutional(error.code))
            .send({ code: error.code, message: error.message, details: error.details });
        }
        throw error;
      }
    },
  );
}
