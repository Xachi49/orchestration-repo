import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { RepositoryTruthService } from "../ingestion/service.js";
import {
  isIngestionError,
  type IngestionErrorCode,
} from "../ingestion/errors.js";
import { isControlPlaneError } from "../control-plane/index.js";

const IngestParamsSchema = z.object({
  runId: z.string().min(1),
}).strict();

const IngestBodySchema = z
  .object({
    projectId: z.string().min(1),
    requestedEnvironment: z.string().min(1),
  })
  .strict();

export function httpStatusForIngestion(code: IngestionErrorCode): number {
  switch (code) {
    case "INGESTION_IN_PROGRESS":
      return 409;
    case "REMOTE_AUTHENTICATION_FAILED":
      return 401;
    case "BRANCH_NOT_FOUND":
    case "COMMIT_NOT_FOUND":
      return 404;
    case "REMOTE_REPOSITORY_UNAVAILABLE":
      return 502;
    case "WORKSPACE_PREPARATION_FAILED":
    case "WORKSPACE_PATH_VIOLATION":
    case "REPOSITORY_FINGERPRINT_FAILED":
    case "INDEXING_FAILED":
    case "EVIDENCE_PERSISTENCE_FAILED":
      return 500;
    default:
      return 409;
  }
}

/**
 * HTTP adapter only. Repository business logic lives in RepositoryTruthService.
 */
export function registerIngestRoutes(
  app: FastifyInstance,
  ingestion: RepositoryTruthService,
): void {
  app.post("/v1/runs/:runId/ingest", async (request, reply) => {
    const params = IngestParamsSchema.safeParse(request.params);
    const body = IngestBodySchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({
        error: "INVALID_INGESTION_REQUEST",
        message: "runId, projectId, and requestedEnvironment are required",
      });
    }
    try {
      const context = await ingestion.ingest(
        params.data.runId,
        body.data.projectId,
        body.data.requestedEnvironment,
      );
      return reply.status(200).send(context);
    } catch (error) {
      if (isIngestionError(error)) {
        return reply.status(httpStatusForIngestion(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      if (isControlPlaneError(error)) {
        const status = error.code === "PROJECT_NOT_FOUND" ? 404 : 409;
        return reply.status(status).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/repository-context", async (request, reply) => {
    const params = IngestParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_INGESTION_REQUEST",
        message: "runId is required",
      });
    }
    const context = await ingestion.getContext(params.data.runId);
    if (!context) {
      return reply.status(404).send({
        error: "REPOSITORY_CONTEXT_NOT_FOUND",
        message: `No verified repository context for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(context);
  });
}
