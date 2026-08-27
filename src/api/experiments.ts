import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ExperimentOrchestrationService } from "../experiments/service.js";
import type {
  ExperimentRepository,
  ExperimentEvidenceBundleRepository,
} from "../experiments/repositories.js";
import { ExperimentBudgetEnvelopeSchema } from "../experiments/experiment.js";
import { ExperimentAuthorizationDecisionSchema } from "../experiments/authorization.js";
import { MeasurementResultSchema } from "../experiments/evidence.js";
import { isExperimentError } from "../experiments/errors.js";

const ExperimentParams = z.object({ id: z.string().min(1) }).strict();

const AdmitBody = z
  .object({
    experimentId: z.string().min(1).optional(),
    experimentVersion: z.number().int().positive().optional(),
    projectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
    sourceDecisionProblemId: z.string().min(1).optional(),
    sourceDecisionProblemVersion: z.number().int().positive().optional(),
    sourceScenarioSetId: z.string().min(1).optional(),
    sourceScenarioSetVersion: z.number().int().positive().optional(),
    sourceAssumptionIds: z.array(z.string().min(1)).optional(),
    sourcePortfolioId: z.string().min(1).optional(),
    sourcePortfolioVersion: z.number().int().positive().optional(),
    objective: z.string().min(1).max(4000),
    constraints: z.array(z.string()).optional(),
    nonGoals: z.array(z.string()).optional(),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    budgetEnvelope: ExperimentBudgetEnvelopeSchema,
    createdBy: z.string().min(1).optional(),
    correlationId: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

const AuthorizationDecideBody = z
  .object({
    authorizationId: z.string().min(1),
    sponsorId: z.string().min(1).optional(),
    decision: ExperimentAuthorizationDecisionSchema,
    decisionNonce: z.string().min(1),
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

const ReconcileBody = z
  .object({
    measurementResults: z.array(MeasurementResultSchema).optional(),
  })
  .strict()
  .optional();

const VerifyBody = z
  .object({
    measurementResults: z.array(MeasurementResultSchema).optional(),
    outcomeVerificationIds: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .optional();

function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

function httpStatusForExperiment(code: string): number {
  switch (code) {
    case "EXPERIMENT_NOT_FOUND":
      return 404;
    case "EXPERIMENT_VERSION_CONFLICT":
    case "EXPERIMENT_STATE_CONFLICT":
    case "EXPERIMENT_CAS_CONFLICT":
      return 409;
    case "EXPERIMENT_AUTHORIZATION_REQUIRED":
    case "EXPERIMENT_AUTHORIZATION_INVALID":
    case "EXPERIMENT_AUTHORIZATION_EXPIRED":
    case "EXPERIMENT_SPONSOR_SCOPE_INSUFFICIENT":
    case "EXPERIMENT_AUTH_DOES_NOT_EXECUTE":
    case "EXECUTION_AUTHORIZATION_REQUIRED":
      return 403;
    default:
      return 400;
  }
}

export function registerExperimentRoutes(
  app: FastifyInstance,
  deps: {
    experimentService: ExperimentOrchestrationService;
    experiments: ExperimentRepository;
    evidenceBundles: ExperimentEvidenceBundleRepository;
  },
): void {
  app.post("/v1/experiments", async (request, reply) => {
    try {
      const body = AdmitBody.parse(request.body);
      const result = await deps.experimentService.admit({
        projectId: body.projectId,
        requestedEnvironment: body.requestedEnvironment,
        objective: body.objective,
        riskClass: body.riskClass,
        budgetEnvelope: body.budgetEnvelope,
        createdBy: body.createdBy ?? principalId(request),
        submittedAt: body.submittedAt ?? new Date().toISOString(),
        ...(body.experimentId ? { experimentId: body.experimentId } : {}),
        ...(body.experimentVersion !== undefined
          ? { experimentVersion: body.experimentVersion }
          : {}),
        ...(body.sourceDecisionProblemId !== undefined
          ? { sourceDecisionProblemId: body.sourceDecisionProblemId }
          : {}),
        ...(body.sourceDecisionProblemVersion !== undefined
          ? {
              sourceDecisionProblemVersion: body.sourceDecisionProblemVersion,
            }
          : {}),
        ...(body.sourceScenarioSetId !== undefined
          ? { sourceScenarioSetId: body.sourceScenarioSetId }
          : {}),
        ...(body.sourceScenarioSetVersion !== undefined
          ? { sourceScenarioSetVersion: body.sourceScenarioSetVersion }
          : {}),
        ...(body.sourceAssumptionIds !== undefined
          ? { sourceAssumptionIds: body.sourceAssumptionIds }
          : {}),
        ...(body.sourcePortfolioId !== undefined
          ? { sourcePortfolioId: body.sourcePortfolioId }
          : {}),
        ...(body.sourcePortfolioVersion !== undefined
          ? { sourcePortfolioVersion: body.sourcePortfolioVersion }
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
      return reply.code(result.outcome === "ADMITTED" ? 201 : 200).send(result);
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/experiments/:id", async (request, reply) => {
    const { id } = ExperimentParams.parse(request.params);
    const experiment = await deps.experiments.getById(id);
    if (!experiment) {
      return reply
        .code(404)
        .send({ error: "EXPERIMENT_NOT_FOUND", message: "Not found" });
    }
    return experiment;
  });

  app.post("/v1/experiments/:id/design", async (request, reply) => {
    try {
      const { id } = ExperimentParams.parse(request.params);
      return await deps.experimentService.design(id);
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/experiments/:id/validate", async (request, reply) => {
    try {
      const { id } = ExperimentParams.parse(request.params);
      return await deps.experimentService.validate(id);
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/experiments/:id/authorization", async (request, reply) => {
    try {
      const { id } = ExperimentParams.parse(request.params);
      const routed = await deps.experimentService.routeAuthorization(id);
      return {
        authorizationId: routed.request.authorizationId,
        status: routed.request.status,
        expiresAt: routed.request.expiresAt,
        decisionNonce: routed.decisionNonce,
      };
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/experiments/:id/authorization/decision",
    async (request, reply) => {
      try {
        ExperimentParams.parse(request.params);
        const body = AuthorizationDecideBody.parse(request.body);
        return await deps.experimentService.decideAuthorization({
          authorizationId: body.authorizationId,
          sponsorId: body.sponsorId ?? principalId(request),
          decision: body.decision,
          decisionNonce: body.decisionNonce,
          submittedAt: body.submittedAt ?? new Date().toISOString(),
        });
      } catch (error) {
        if (isExperimentError(error)) {
          return reply
            .code(httpStatusForExperiment(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post("/v1/experiments/:id/compile", async (request, reply) => {
    try {
      const { id } = ExperimentParams.parse(request.params);
      return await deps.experimentService.compileExecution(id);
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/experiments/:id/reconcile", async (request, reply) => {
    try {
      const { id } = ExperimentParams.parse(request.params);
      const body = ReconcileBody.parse(request.body ?? {});
      const experiment = await deps.experiments.getById(id);
      if (!experiment) {
        return reply
          .code(404)
          .send({ error: "EXPERIMENT_NOT_FOUND", message: "Not found" });
      }
      if (body?.measurementResults && body.measurementResults.length > 0) {
        return await deps.experimentService.recordVerifiedMeasurements(
          id,
          body.measurementResults,
        );
      }
      await deps.experimentService.recheckTruthOrMarkStale(experiment);
      const refreshed = await deps.experiments.getById(id);
      return { experiment: refreshed ?? experiment };
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/experiments/:id/verify", async (request, reply) => {
    try {
      const { id } = ExperimentParams.parse(request.params);
      const body = VerifyBody.parse(request.body ?? {});
      return await deps.experimentService.verifyAndComplete(id, {
        ...(body?.measurementResults !== undefined
          ? { measurementResults: body.measurementResults }
          : {}),
        ...(body?.outcomeVerificationIds !== undefined
          ? { outcomeVerificationIds: body.outcomeVerificationIds }
          : {}),
      });
    } catch (error) {
      if (isExperimentError(error)) {
        return reply
          .code(httpStatusForExperiment(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/experiments/:id/evidence", async (request, reply) => {
    const { id } = ExperimentParams.parse(request.params);
    const bundle = await deps.evidenceBundles.getByExperiment(id);
    if (!bundle) {
      return reply
        .code(404)
        .send({ error: "EVIDENCE_BUNDLE_INVALID", message: "No evidence" });
    }
    return bundle;
  });
}
