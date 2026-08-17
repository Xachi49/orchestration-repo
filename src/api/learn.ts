import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { GovernedMemoryService } from "../memory/service.js";
import {
  LocalPrecedentReviewApplicator,
  PrecedentReviewRequestSchema,
} from "../memory/review.js";
import {
  isMemoryError,
  type MemoryErrorCode,
} from "../memory/errors.js";

const RunParamsSchema = z.object({ runId: z.string().min(1) }).strict();
const ProjectParamsSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
const PrecedentParamsSchema = z
  .object({ precedentId: z.string().min(1) })
  .strict();
const CandidateParamsSchema = z
  .object({ candidateId: z.string().min(1) })
  .strict();

export function httpStatusForMemory(code: MemoryErrorCode): number {
  switch (code) {
    case "CANDIDATE_NOT_FOUND":
    case "PRECEDENT_NOT_FOUND":
      return 404;
    case "LEARNING_IN_PROGRESS":
    case "LEARNING_ALREADY_PROCESSED":
    case "LEARNING_NOT_READY":
    case "LEARNING_RUN_NOT_TERMINAL":
    case "LEARNING_OUTCOME_MISSING":
    case "PROMOTION_NOT_ELIGIBLE":
    case "PROMOTION_GROUNDING_INSUFFICIENT":
    case "PROMOTION_PROVENANCE_INVALID":
    case "PROMOTION_CONTRADICTED":
    case "PRECEDENT_INTEGRITY_FAILED":
    case "INVALID_PROMOTION_DECISION":
    case "INVALID_LEARNING_STATE":
    case "HISTORICAL_RUN_CONFLICT":
      return 409;
    case "LEARNING_RESOURCE_BUDGET_EXCEEDED":
      return 429;
    default:
      return 409;
  }
}

export interface LearningRouteDeps {
  memory: GovernedMemoryService;
  review?: LocalPrecedentReviewApplicator;
}

export function registerLearningRoutes(
  app: FastifyInstance,
  deps: LearningRouteDeps,
): void {
  const review =
    deps.review ?? new LocalPrecedentReviewApplicator(deps.memory);

  app.post("/v1/runs/:runId/learn", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_LEARNING_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const result = await deps.memory.learn(params.data.runId);
      return reply.status(200).send(result);
    } catch (error) {
      if (isMemoryError(error)) {
        return reply.status(httpStatusForMemory(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/learnings", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_LEARNING_REQUEST",
        message: "runId is required",
      });
    }
    const learnings = await deps.memory.listLearnings(params.data.runId);
    return reply.status(200).send(learnings);
  });

  app.get("/v1/projects/:projectId/precedents", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_LEARNING_REQUEST",
        message: "projectId is required",
      });
    }
    const precedents = await deps.memory.listProjectPrecedents(
      params.data.projectId,
    );
    return reply.status(200).send({ precedents });
  });

  app.get("/v1/precedents/:precedentId", async (request, reply) => {
    const params = PrecedentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_LEARNING_REQUEST",
        message: "precedentId is required",
      });
    }
    const precedent = await deps.memory.getPrecedent(params.data.precedentId);
    if (!precedent) {
      return reply.status(404).send({
        error: "PRECEDENT_NOT_FOUND",
        message: `Precedent not found: ${params.data.precedentId}`,
      });
    }
    return reply.status(200).send(precedent);
  });

  app.post(
    "/v1/precedent-candidates/:candidateId/review",
    async (request, reply) => {
      const params = CandidateParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "INVALID_LEARNING_REQUEST",
          message: "candidateId is required",
        });
      }
      const body = PrecedentReviewRequestSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "INVALID_PROMOTION_DECISION",
          message: "Bounded promotion decision body required",
        });
      }
      try {
        const result = await review.apply(params.data.candidateId, body.data);
        return reply.status(200).send(result);
      } catch (error) {
        if (isMemoryError(error)) {
          return reply.status(httpStatusForMemory(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
