import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CausalOrchestrationService } from "../causal/service.js";
import type {
  CausalQuestionRepository,
  PromotedCausalClaimRepository,
  DecisionModelCalibrationCandidateRepository,
} from "../causal/repositories.js";
import { CausalAnalysisBudgetSchema } from "../causal/question.js";
import { QuantityUnitSchema } from "../causal/variables.js";
import { CausalReviewDecisionSchema } from "../causal/review.js";
import { isCausalError } from "../causal/errors.js";

const QuestionParams = z.object({ id: z.string().min(1) }).strict();
const ClaimParams = z.object({ id: z.string().min(1) }).strict();

const AdmitBody = z
  .object({
    causalQuestionId: z.string().min(1).optional(),
    projectIds: z.array(z.string().min(1)).min(1),
    sourceDecisionProblemIds: z.array(z.string().min(1)).optional(),
    sourceExperimentIds: z.array(z.string().min(1)).optional(),
    sourceAssumptionIds: z.array(z.string().min(1)).optional(),
    intervention: z.string().min(1).max(2000),
    outcome: z.string().min(1).max(2000),
    interventionUnit: QuantityUnitSchema,
    outcomeUnit: QuantityUnitSchema,
    targetPopulation: z.string().min(1).max(500),
    targetEnvironment: z.string().min(1).max(200),
    timeHorizon: z.string().min(1).max(200),
    candidateConfounders: z.array(z.string().min(1)).optional(),
    candidateMediators: z.array(z.string().min(1)).optional(),
    candidateModerators: z.array(z.string().min(1)).optional(),
    businessDecisionContext: z.string().min(1).max(4000),
    materialityThreshold: z.number().finite(),
    constraints: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    budgetEnvelope: CausalAnalysisBudgetSchema,
    createdBy: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
  })
  .strict();

const ReviewDecideBody = z
  .object({
    reviewRequestId: z.string().min(1),
    reviewerId: z.string().min(1).optional(),
    decision: CausalReviewDecisionSchema,
    decisionNonce: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForCausal(code: string): number {
  switch (code) {
    case "CAUSAL_QUESTION_NOT_FOUND":
      return 404;
    case "CAUSAL_QUESTION_VERSION_CONFLICT":
    case "CAUSAL_STATE_CONFLICT":
    case "CAUSAL_CAS_CONFLICT":
      return 409;
    case "CAUSAL_REVIEW_REQUIRED":
    case "CAUSAL_REVIEW_INVALID":
    case "CAUSAL_REVIEW_EXPIRED":
    case "CAUSAL_REVIEWER_SCOPE_INSUFFICIENT":
    case "CAUSAL_PROMOTION_REJECTED":
      return 403;
    default:
      return 400;
  }
}

export function registerCausalRoutes(
  app: FastifyInstance,
  deps: {
    causalService: CausalOrchestrationService;
    questions: CausalQuestionRepository;
    promotedClaims: PromotedCausalClaimRepository;
    calibrationCandidates: DecisionModelCalibrationCandidateRepository;
  },
): void {
  app.post("/v1/causal/questions", async (request, reply) => {
    try {
      const body = AdmitBody.parse(request.body);
      const result = await deps.causalService.admit({
        projectIds: body.projectIds,
        intervention: body.intervention,
        outcome: body.outcome,
        interventionUnit: body.interventionUnit,
        outcomeUnit: body.outcomeUnit,
        targetPopulation: body.targetPopulation,
        targetEnvironment: body.targetEnvironment,
        timeHorizon: body.timeHorizon,
        businessDecisionContext: body.businessDecisionContext,
        materialityThreshold: body.materialityThreshold,
        budgetEnvelope: body.budgetEnvelope,
        createdBy: body.createdBy ?? principalId(request),
        ...(body.causalQuestionId
          ? { causalQuestionId: body.causalQuestionId }
          : {}),
        ...(body.sourceDecisionProblemIds !== undefined
          ? { sourceDecisionProblemIds: body.sourceDecisionProblemIds }
          : {}),
        ...(body.sourceExperimentIds !== undefined
          ? { sourceExperimentIds: body.sourceExperimentIds }
          : {}),
        ...(body.sourceAssumptionIds !== undefined
          ? { sourceAssumptionIds: body.sourceAssumptionIds }
          : {}),
        ...(body.candidateConfounders !== undefined
          ? { candidateConfounders: body.candidateConfounders }
          : {}),
        ...(body.candidateMediators !== undefined
          ? { candidateMediators: body.candidateMediators }
          : {}),
        ...(body.candidateModerators !== undefined
          ? { candidateModerators: body.candidateModerators }
          : {}),
        ...(body.constraints !== undefined
          ? { constraints: body.constraints }
          : {}),
        ...(body.nonGoals !== undefined ? { nonGoals: body.nonGoals } : {}),
        ...(body.correlationId !== undefined
          ? { correlationId: body.correlationId }
          : {}),
        ...(body.traceId !== undefined ? { traceId: body.traceId } : {}),
      });
      return reply.code(result.reused ? 200 : 201).send(result);
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/causal/questions/:id", async (request, reply) => {
    const { id } = QuestionParams.parse(request.params);
    const question = await deps.questions.getById(id);
    if (!question) {
      return reply
        .code(404)
        .send({ error: "CAUSAL_QUESTION_NOT_FOUND", message: "Not found" });
    }
    return question;
  });

  app.post("/v1/causal/questions/:id/graph", async (request, reply) => {
    try {
      const { id } = QuestionParams.parse(request.params);
      return await deps.causalService.proposeGraph(id);
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/causal/questions/:id/identify", async (request, reply) => {
    try {
      const { id } = QuestionParams.parse(request.params);
      return await deps.causalService.identify(id);
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/causal/questions/:id/estimate", async (request, reply) => {
    try {
      const { id } = QuestionParams.parse(request.params);
      return await deps.causalService.estimate(id);
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/causal/questions/:id/synthesize", async (request, reply) => {
    try {
      const { id } = QuestionParams.parse(request.params);
      return await deps.causalService.synthesize(id);
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/causal/questions/:id/validate", async (request, reply) => {
    try {
      const { id } = QuestionParams.parse(request.params);
      return await deps.causalService.validate(id);
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/causal/questions/:id/review", async (request, reply) => {
    try {
      const { id } = QuestionParams.parse(request.params);
      const routed = await deps.causalService.routeReview(id);
      return {
        reviewRequestId: routed.request.reviewRequestId,
        status: routed.request.status,
        expiresAt: routed.request.expiresAt,
        decisionNonce: routed.decisionNonce,
      };
    } catch (error) {
      if (isCausalError(error)) {
        return reply
          .code(httpStatusForCausal(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/causal/questions/:id/review/decision",
    async (request, reply) => {
      try {
        QuestionParams.parse(request.params);
        const body = ReviewDecideBody.parse(request.body);
        return await deps.causalService.decideReview({
          reviewRequestId: body.reviewRequestId,
          reviewerId: body.reviewerId ?? principalId(request),
          decision: body.decision,
          decisionNonce: body.decisionNonce,
          submittedAt: body.submittedAt ?? new Date().toISOString(),
        });
      } catch (error) {
        if (isCausalError(error)) {
          return reply
            .code(httpStatusForCausal(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get("/v1/causal/claims/:id", async (request, reply) => {
    const { id } = ClaimParams.parse(request.params);
    const claim = await deps.promotedClaims.getById(id);
    if (!claim) {
      return reply
        .code(404)
        .send({ error: "CAUSAL_QUESTION_NOT_FOUND", message: "Claim not found" });
    }
    return claim;
  });

  app.get(
    "/v1/causal/claims/:id/calibration-candidates",
    async (request, reply) => {
      const { id } = ClaimParams.parse(request.params);
      const claim = await deps.promotedClaims.getById(id);
      if (!claim) {
        return reply.code(404).send({
          error: "CAUSAL_QUESTION_NOT_FOUND",
          message: "Claim not found",
        });
      }
      return deps.calibrationCandidates.listByPromotedClaim(id);
    },
  );
}
