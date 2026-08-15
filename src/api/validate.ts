import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ValidationService } from "../validation/service.js";
import {
  isValidationError,
  type ValidationErrorCode,
} from "../validation/errors.js";

const ValidateParamsSchema = z.object({ runId: z.string().min(1) }).strict();

export function httpStatusForValidation(code: ValidationErrorCode): number {
  switch (code) {
    case "VALIDATION_NOT_READY":
    case "VALIDATION_IN_PROGRESS":
    case "VALIDATION_CONTEXT_STALE":
    case "PLAN_NOT_VALIDATABLE":
    case "INVALID_VALIDATION_STATE":
    case "POLICY_BUNDLE_UNAVAILABLE":
    case "VALIDATION_MODEL_BUDGET_EXCEEDED":
    case "VALIDATION_MODEL_BUDGET_INVARIANT_VIOLATION":
    case "REVISION_NOT_PERMITTED":
    case "REVISION_LIMIT_EXCEEDED":
      return 409;
    case "PLAN_NOT_FOUND":
    case "OBJECTIVE_NOT_FOUND":
      return 404;
    case "VALIDATION_MODEL_UNAVAILABLE":
    case "VALIDATION_MODEL_TIMEOUT":
      return 502;
    case "VALIDATION_MODEL_REFUSED":
    case "VALIDATION_MODEL_INVALID_OUTPUT":
    case "REVISION_MODEL_INVALID_OUTPUT":
    case "REVISION_COMPILATION_FAILED":
      return 422;
    case "VALIDATION_DECISION_PERSISTENCE_FAILED":
    case "VALIDATION_RECONCILIATION_FAILED":
    case "REVISION_PERSISTENCE_FAILED":
      return 500;
    default:
      return 409;
  }
}

export function registerValidationRoutes(
  app: FastifyInstance,
  validation: ValidationService,
): void {
  app.post("/v1/runs/:runId/validate", async (request, reply) => {
    const params = ValidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_VALIDATION_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const result = await validation.validate(params.data.runId);
      return reply.status(200).send(result);
    } catch (error) {
      if (isValidationError(error)) {
        return reply.status(httpStatusForValidation(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/validation", async (request, reply) => {
    const params = ValidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_VALIDATION_REQUEST",
        message: "runId is required",
      });
    }
    const decision = await validation.getLatestDecision(params.data.runId);
    if (!decision) {
      return reply.status(404).send({
        error: "VALIDATION_DECISION_NOT_FOUND",
        message: `No validation decision for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(decision);
  });

  app.get("/v1/runs/:runId/validations", async (request, reply) => {
    const params = ValidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_VALIDATION_REQUEST",
        message: "runId is required",
      });
    }
    const decisions = await validation.listDecisions(params.data.runId);
    return reply.status(200).send({ decisions });
  });

  app.get("/v1/runs/:runId/validation-readiness", async (request, reply) => {
    const params = ValidateParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_VALIDATION_REQUEST",
        message: "runId is required",
      });
    }
    const readiness = await validation.assess(params.data.runId);
    return reply.status(200).send(readiness);
  });
}
