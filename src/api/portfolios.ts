import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PortfolioOrchestrationService } from "../portfolio/service.js";
import type {
  PortfolioRepository,
  PortfolioPlanRepository,
} from "../portfolio/repositories.js";
import { isPortfolioError } from "../portfolio/errors.js";
import { PortfolioIntentSchema } from "../portfolio/intent.js";
import { PortfolioGoalSchema } from "../portfolio/goals.js";
import { PortfolioAuthorizationEnvelopeSchema } from "../portfolio/authorization-envelope.js";

const PortfolioParams = z
  .object({ portfolioId: z.string().min(1) })
  .strict();

const AdmitBody = z
  .object({
    portfolioId: z.string().min(1).optional(),
    portfolioVersion: z.number().int().positive().optional(),
    primaryProjectId: z.string().min(1),
    requesterId: z.string().min(1).optional(),
    requestedEnvironment: z.string().min(1),
    intent: PortfolioIntentSchema,
    goals: z.array(PortfolioGoalSchema).min(1),
    authorizationEnvelope: PortfolioAuthorizationEnvelopeSchema,
    submittedAt: z.string().datetime().optional(),
  })
  .strict();

const DecideBody = z
  .object({
    authorizationId: z.string().min(1),
    allocatorId: z.string().min(1).optional(),
    decision: z.enum(["APPROVE", "REJECT"]),
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

function httpStatusForPortfolio(code: string): number {
  switch (code) {
    case "PORTFOLIO_NOT_FOUND":
      return 404;
    case "PORTFOLIO_VERSION_CONFLICT":
    case "PORTFOLIO_STATE_CONFLICT":
    case "PORTFOLIO_CAS_CONFLICT":
      return 409;
    case "PORTFOLIO_AUTHORIZATION_REQUIRED":
    case "PORTFOLIO_AUTHORIZATION_INVALID":
    case "PORTFOLIO_AUTHORIZATION_EXPIRED":
      return 403;
    default:
      return 400;
  }
}

export function registerPortfolioRoutes(
  app: FastifyInstance,
  deps: {
    portfolioService: PortfolioOrchestrationService;
    portfolios: PortfolioRepository;
    portfolioPlans: PortfolioPlanRepository;
  },
): void {
  app.post("/v1/portfolios", async (request, reply) => {
    try {
      const body = AdmitBody.parse(request.body);
      const result = await deps.portfolioService.admit({
        primaryProjectId: body.primaryProjectId,
        requesterId: body.requesterId ?? principalId(request),
        requestedEnvironment: body.requestedEnvironment,
        intent: body.intent,
        goals: body.goals,
        authorizationEnvelope: body.authorizationEnvelope,
        submittedAt: body.submittedAt ?? new Date().toISOString(),
        ...(body.portfolioId ? { portfolioId: body.portfolioId } : {}),
        ...(body.portfolioVersion !== undefined
          ? { portfolioVersion: body.portfolioVersion }
          : {}),
      });
      return reply.code(result.outcome === "ADMITTED" ? 201 : 200).send(result);
    } catch (error) {
      if (isPortfolioError(error)) {
        return reply
          .code(httpStatusForPortfolio(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/portfolios/:portfolioId", async (request, reply) => {
    const { portfolioId } = PortfolioParams.parse(request.params);
    const portfolio = await deps.portfolios.getById(portfolioId);
    if (!portfolio) {
      return reply
        .code(404)
        .send({ error: "PORTFOLIO_NOT_FOUND", message: "Not found" });
    }
    return portfolio;
  });

  app.post("/v1/portfolios/:portfolioId/plan", async (request, reply) => {
    try {
      const { portfolioId } = PortfolioParams.parse(request.params);
      await deps.portfolioService.analyze(portfolioId);
      const result = await deps.portfolioService.plan(portfolioId);
      return result;
    } catch (error) {
      if (isPortfolioError(error)) {
        return reply
          .code(httpStatusForPortfolio(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post("/v1/portfolios/:portfolioId/validate", async (request, reply) => {
    try {
      const { portfolioId } = PortfolioParams.parse(request.params);
      return await deps.portfolioService.validate(portfolioId);
    } catch (error) {
      if (isPortfolioError(error)) {
        return reply
          .code(httpStatusForPortfolio(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/portfolios/:portfolioId/authorization", async (request, reply) => {
    try {
      const { portfolioId } = PortfolioParams.parse(request.params);
      const routed = await deps.portfolioService.routeAuthorization(portfolioId);
      return {
        authorizationId: routed.request.authorizationId,
        status: routed.request.status,
        expiresAt: routed.request.expiresAt,
        decisionNonce: routed.decisionNonce,
      };
    } catch (error) {
      if (isPortfolioError(error)) {
        return reply
          .code(httpStatusForPortfolio(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.post(
    "/v1/portfolios/:portfolioId/authorization/decision",
    async (request, reply) => {
      try {
        PortfolioParams.parse(request.params);
        const body = DecideBody.parse(request.body);
        const decided = await deps.portfolioService.decideAuthorization({
          authorizationId: body.authorizationId,
          allocatorId: body.allocatorId ?? principalId(request),
          decision: body.decision,
          decisionNonce: body.decisionNonce,
          submittedAt: body.submittedAt ?? new Date().toISOString(),
        });
        return decided;
      } catch (error) {
        if (isPortfolioError(error)) {
          return reply
            .code(httpStatusForPortfolio(error.code))
            .send({ error: error.code, message: error.message });
        }
        throw error;
      }
    },
  );

  app.post("/v1/portfolios/:portfolioId/reconcile", async (request, reply) => {
    try {
      const { portfolioId } = PortfolioParams.parse(request.params);
      return await deps.portfolioService.reconcile(portfolioId);
    } catch (error) {
      if (isPortfolioError(error)) {
        return reply
          .code(httpStatusForPortfolio(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });

  app.get("/v1/portfolios/:portfolioId/progress", async (request, reply) => {
    try {
      const { portfolioId } = PortfolioParams.parse(request.params);
      return await deps.portfolioService.reconcile(portfolioId);
    } catch (error) {
      if (isPortfolioError(error)) {
        return reply
          .code(httpStatusForPortfolio(error.code))
          .send({ error: error.code, message: error.message });
      }
      throw error;
    }
  });
}
