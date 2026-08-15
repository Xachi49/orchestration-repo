import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ExecutionService } from "../execution/service.js";
import type { ExecutionReadinessService } from "../execution/readiness.js";
import {
  isExecutionError,
  type ExecutionErrorCode,
} from "../execution/errors.js";

const RunParamsSchema = z.object({ runId: z.string().min(1) }).strict();

export function httpStatusForExecution(code: ExecutionErrorCode): number {
  switch (code) {
    case "EXECUTION_NOT_FOUND":
      return 404;
    case "EXECUTION_MODE_DENIED":
      return 403;
    case "EXECUTION_IN_PROGRESS":
    case "STEP_EXECUTION_IN_PROGRESS":
    case "EXECUTION_ALREADY_COMPLETED":
    case "EXECUTION_NOT_READY":
    case "EXECUTION_BINDING_STALE":
    case "EXECUTION_REPOSITORY_STALE":
    case "EXECUTION_POLICY_CHANGED":
    case "EXECUTION_CAPABILITY_CHANGED":
    case "EXECUTION_IDEMPOTENCY_CONFLICT":
    case "EXECUTION_CONFLICT":
      return 409;
    case "EXECUTION_RESOURCE_BUDGET_EXCEEDED":
      return 429;
    default:
      return 409;
  }
}

export interface ExecutionRouteDeps {
  execution: ExecutionService;
  readiness: ExecutionReadinessService;
}

export function registerExecutionRoutes(
  app: FastifyInstance,
  deps: ExecutionRouteDeps,
): void {
  app.post("/v1/runs/:runId/execute", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_EXECUTION_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const result = await deps.execution.execute(params.data.runId);
      return reply.status(200).send(result);
    } catch (error) {
      if (isExecutionError(error)) {
        return reply.status(httpStatusForExecution(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/execution", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_EXECUTION_REQUEST",
        message: "runId is required",
      });
    }
    const result = await deps.execution.getLatestResult(params.data.runId);
    if (!result) {
      return reply.status(404).send({
        error: "EXECUTION_NOT_FOUND",
        message: `No execution result for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(result);
  });

  app.get("/v1/runs/:runId/execution-artifacts", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_EXECUTION_REQUEST",
        message: "runId is required",
      });
    }
    const artifacts = await deps.execution.listArtifacts(params.data.runId);
    return reply.status(200).send({ artifacts });
  });

  app.get("/v1/runs/:runId/execution-readiness", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_EXECUTION_REQUEST",
        message: "runId is required",
      });
    }
    const readiness = await deps.readiness.assess(params.data.runId);
    return reply.status(200).send(readiness);
  });
}
