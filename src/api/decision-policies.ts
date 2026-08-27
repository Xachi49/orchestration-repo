import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DecisionPolicyOrchestrationService } from "../decision-policies/service.js";
import type {
  DecisionContextRepository,
  DecisionPolicyCandidateRepository,
  DecisionRecommendationRepository,
} from "../decision-policies/repositories.js";
import { RiskClassSchema } from "../decision-policies/variables-actions.js";
import { OptimizationObjectiveSchema } from "../decision-policies/context.js";
import { DecisionStateVariableSchema } from "../decision-policies/variables-actions.js";
import { DecisionActionDefinitionSchema } from "../decision-policies/variables-actions.js";
import { HistoricalDecisionCaseSchema } from "../decision-policies/evaluation.js";
import { DecisionPolicyApprovalDecisionSchema } from "../decision-policies/authority.js";
import { DecisionPolicyActivationDecisionSchema } from "../decision-policies/authority.js";
import { isDecisionPolicyError } from "../decision-policies/errors.js";

const ContextParams = z.object({ id: z.string().min(1) }).strict();
const PolicyParams = z.object({ id: z.string().min(1) }).strict();

const AdmitContextBody = z
  .object({
    projectIds: z.array(z.string().min(1)).min(1),
    environmentScope: z.array(z.string().min(1)).min(1),
    stateVariables: z.array(DecisionStateVariableSchema).min(1),
    eligibleActions: z.array(DecisionActionDefinitionSchema).optional(),
    constraints: z.array(z.string().min(1)).optional(),
    nonGoals: z.array(z.string().min(1)).optional(),
    optimizationObjectives: z.array(OptimizationObjectiveSchema).min(1),
    riskTolerance: RiskClassSchema,
    materialityThreshold: z.number().finite(),
    timeHorizon: z.string().min(1),
    createdBy: z.string().min(1).optional(),
    strategicGoalRefs: z.array(z.string().min(1)).optional(),
    portfolioRefs: z.array(z.string().min(1)).optional(),
    programRefs: z.array(z.string().min(1)).optional(),
    decisionProblemRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();

const SynthesizeBody = z
  .object({
    createdBy: z.string().min(1).optional(),
    sourcePromotedCausalClaimIds: z.array(z.string().min(1)).optional(),
    sourceEvidenceRefs: z.array(z.string().min(1)).optional(),
    sourceScenarioRefs: z.array(z.string().min(1)).optional(),
  })
  .strict();

const EvaluateOfflineBody = z
  .object({
    cases: z.array(HistoricalDecisionCaseSchema).min(1),
  })
  .strict();

const ApprovalDecideBody = z
  .object({
    decisionPolicyApprovalRequestId: z.string().min(1),
    approverId: z.string().min(1).optional(),
    decision: DecisionPolicyApprovalDecisionSchema,
    decisionNonce: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

const ActivationDecideBody = z
  .object({
    decisionPolicyActivationRequestId: z.string().min(1),
    activatorId: z.string().min(1).optional(),
    decision: DecisionPolicyActivationDecisionSchema,
    decisionNonce: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

/**
 * Caller-supplied values are query hints / DATA only.
 * Authoritative DecisionStateSnapshot is resolved server-side.
 */
const ShadowBody = z
  .object({
    environment: z.string().min(1),
    hints: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
    actualActionId: z.string().min(1).optional(),
  })
  .strict();

const RecommendBody = z
  .object({
    environment: z.string().min(1),
    hints: z
      .record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.null()]),
      )
      .optional(),
  })
  .strict();

const MaterializeBody = z
  .object({
    recommendationId: z.string().min(1),
  })
  .strict();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForDecisionPolicy(code: string): number {
  switch (code) {
    case "DECISION_CONTEXT_NOT_FOUND":
    case "DECISION_POLICY_NOT_FOUND":
      return 404;
    case "DECISION_POLICY_VERSION_CONFLICT":
    case "DECISION_POLICY_STATE_CONFLICT":
    case "DECISION_POLICY_CAS_CONFLICT":
      return 409;
    case "DECISION_POLICY_APPROVER_SCOPE_INSUFFICIENT":
    case "DECISION_POLICY_ACTIVATOR_SCOPE_INSUFFICIENT":
    case "DECISION_POLICY_APPROVAL_INVALID":
    case "DECISION_POLICY_APPROVAL_EXPIRED":
    case "DECISION_POLICY_ACTIVATION_INVALID":
    case "DECISION_POLICY_ACTIVATION_EXPIRED":
    case "DECISION_POLICY_NOT_ACTIVE":
    case "ACTIVATION_NOT_READY":
    case "DECISION_MATERIALIZATION_NOT_PERMITTED":
      return 403;
    default:
      return 400;
  }
}

export function registerDecisionPolicyRoutes(
  app: FastifyInstance,
  deps: {
    decisionPolicyService: DecisionPolicyOrchestrationService;
    decisionContexts: DecisionContextRepository;
    decisionPolicies: DecisionPolicyCandidateRepository;
    decisionRecommendations: DecisionRecommendationRepository;
  },
): void {
  app.post("/v1/decision-policies/contexts", async (request, reply) => {
    try {
      const body = AdmitContextBody.parse(request.body);
      const result = await deps.decisionPolicyService.admitContext({
        projectIds: body.projectIds,
        environmentScope: body.environmentScope,
        stateVariables: body.stateVariables,
        optimizationObjectives: body.optimizationObjectives,
        riskTolerance: body.riskTolerance,
        materialityThreshold: body.materialityThreshold,
        timeHorizon: body.timeHorizon,
        createdBy: body.createdBy ?? principalId(request),
        ...(body.eligibleActions !== undefined
          ? { eligibleActions: body.eligibleActions }
          : {}),
        ...(body.constraints !== undefined
          ? { constraints: body.constraints }
          : {}),
        ...(body.nonGoals !== undefined ? { nonGoals: body.nonGoals } : {}),
        ...(body.strategicGoalRefs !== undefined
          ? { strategicGoalRefs: body.strategicGoalRefs }
          : {}),
        ...(body.portfolioRefs !== undefined
          ? { portfolioRefs: body.portfolioRefs }
          : {}),
        ...(body.programRefs !== undefined
          ? { programRefs: body.programRefs }
          : {}),
        ...(body.decisionProblemRefs !== undefined
          ? { decisionProblemRefs: body.decisionProblemRefs }
          : {}),
      });
      return reply.code(201).send(result);
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/decision-policies/contexts/:id", async (request, reply) => {
    const { id } = ContextParams.parse(request.params);
    const context = await deps.decisionContexts.getById(id);
    if (!context) {
      return reply.code(404).send({
        error: "DECISION_CONTEXT_NOT_FOUND",
        message: "Not found",
      });
    }
    return context;
  });

  app.post(
    "/v1/decision-policies/contexts/:id/synthesize",
    async (request, reply) => {
      try {
        const { id } = ContextParams.parse(request.params);
        const body = SynthesizeBody.parse(request.body ?? {});
        return await deps.decisionPolicyService.synthesizePolicy({
          decisionContextId: id,
          createdBy: body.createdBy ?? principalId(request),
          ...(body.sourcePromotedCausalClaimIds !== undefined
            ? { sourcePromotedCausalClaimIds: body.sourcePromotedCausalClaimIds }
            : {}),
          ...(body.sourceEvidenceRefs !== undefined
            ? { sourceEvidenceRefs: body.sourceEvidenceRefs }
            : {}),
          ...(body.sourceScenarioRefs !== undefined
            ? { sourceScenarioRefs: body.sourceScenarioRefs }
            : {}),
        });
      } catch (error) {
        if (isDecisionPolicyError(error)) {
          return reply
            .code(httpStatusForDecisionPolicy(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get("/v1/decision-policies/:id", async (request, reply) => {
    const { id } = PolicyParams.parse(request.params);
    const policy = await deps.decisionPolicies.getById(id);
    if (!policy) {
      return reply.code(404).send({
        error: "DECISION_POLICY_NOT_FOUND",
        message: "Not found",
      });
    }
    return policy;
  });

  app.post("/v1/decision-policies/:id/validate", async (request, reply) => {
    try {
      const { id } = PolicyParams.parse(request.params);
      return await deps.decisionPolicyService.validatePolicy(id);
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/decision-policies/:id/evaluate", async (request, reply) => {
    try {
      const { id } = PolicyParams.parse(request.params);
      const body = EvaluateOfflineBody.parse(request.body);
      return await deps.decisionPolicyService.evaluateOffline(id, body.cases);
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/decision-policies/:id/approval/route", async (request, reply) => {
    try {
      const { id } = PolicyParams.parse(request.params);
      return await deps.decisionPolicyService.routeApproval(id);
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/decision-policies/approval/decision", async (request, reply) => {
    try {
      const body = ApprovalDecideBody.parse(request.body);
      return await deps.decisionPolicyService.decideApproval({
        decisionPolicyApprovalRequestId: body.decisionPolicyApprovalRequestId,
        approverId: body.approverId ?? principalId(request),
        decision: body.decision,
        decisionNonce: body.decisionNonce,
        submittedAt: body.submittedAt ?? new Date().toISOString(),
      });
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/decision-policies/:id/shadow", async (request, reply) => {
    try {
      const { id } = PolicyParams.parse(request.params);
      const body = ShadowBody.parse(request.body);
      return await deps.decisionPolicyService.runShadowDecision({
        decisionPolicyId: id,
        environment: body.environment,
        ...(body.hints !== undefined ? { hints: body.hints } : {}),
        ...(body.actualActionId !== undefined
          ? { actualActionId: body.actualActionId }
          : {}),
      });
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/decision-policies/:id/shadow/evaluate",
    async (request, reply) => {
      try {
        const { id } = PolicyParams.parse(request.params);
        return await deps.decisionPolicyService.evaluateShadow(id);
      } catch (error) {
        if (isDecisionPolicyError(error)) {
          return reply
            .code(httpStatusForDecisionPolicy(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/decision-policies/:id/activation/route",
    async (request, reply) => {
      try {
        const { id } = PolicyParams.parse(request.params);
        return await deps.decisionPolicyService.routeActivation(id);
      } catch (error) {
        if (isDecisionPolicyError(error)) {
          return reply
            .code(httpStatusForDecisionPolicy(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/decision-policies/activation/decision",
    async (request, reply) => {
      try {
        const body = ActivationDecideBody.parse(request.body);
        return await deps.decisionPolicyService.decideActivation({
          decisionPolicyActivationRequestId:
            body.decisionPolicyActivationRequestId,
          activatorId: body.activatorId ?? principalId(request),
          decision: body.decision,
          decisionNonce: body.decisionNonce,
          submittedAt: body.submittedAt ?? new Date().toISOString(),
        });
      } catch (error) {
        if (isDecisionPolicyError(error)) {
          return reply
            .code(httpStatusForDecisionPolicy(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post("/v1/decision-policies/:id/recommend", async (request, reply) => {
    try {
      const { id } = PolicyParams.parse(request.params);
      const body = RecommendBody.parse(request.body);
      return await deps.decisionPolicyService.recommend({
        decisionPolicyId: id,
        environment: body.environment,
        ...(body.hints !== undefined ? { hints: body.hints } : {}),
      });
    } catch (error) {
      if (isDecisionPolicyError(error)) {
        return reply
          .code(httpStatusForDecisionPolicy(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/decision-policies/recommendations/materialize",
    async (request, reply) => {
      try {
        const body = MaterializeBody.parse(request.body);
        return await deps.decisionPolicyService.materializeRecommendation({
          recommendationId: body.recommendationId,
        });
      } catch (error) {
        if (isDecisionPolicyError(error)) {
          return reply
            .code(httpStatusForDecisionPolicy(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/decision-policies/recommendations/:id",
    async (request, reply) => {
      const { id } = PolicyParams.parse(request.params);
      const recommendation = await deps.decisionRecommendations.getById(id);
      if (!recommendation) {
        return reply.code(404).send({
          error: "DECISION_RECOMMENDATION_INVALID",
          message: "Not found",
        });
      }
      return recommendation;
    },
  );
}
