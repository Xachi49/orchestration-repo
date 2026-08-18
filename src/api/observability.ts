import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ObservabilityService } from "../observability/service.js";
import {
  isObservabilityError,
  type ObservabilityErrorCode,
} from "../observability/errors.js";

const ProjectParamsSchema = z.object({ projectId: z.string().min(1) }).strict();
const RunParamsSchema = z.object({ runId: z.string().min(1) }).strict();
const CandidateParamsSchema = z
  .object({ candidateId: z.string().min(1) })
  .strict();

const RebuildBodySchema = z
  .object({
    kind: z.enum(["LAST_N_RUNS", "TIME_RANGE", "PROJECT_LIFETIME"]).default(
      "LAST_N_RUNS",
    ),
    lastN: z.number().int().positive().optional(),
    startAt: z.string().datetime().optional(),
    endAt: z.string().datetime().optional(),
  })
  .strict();

const ReviewBodySchema = z
  .object({
    status: z.enum(["REVIEWED", "ACCEPTED_FOR_FUTURE_CHANGE", "REJECTED"]),
  })
  .strict();

export function httpStatusForObservability(code: ObservabilityErrorCode): number {
  switch (code) {
    case "RUN_NOT_FOUND":
    case "PROJECT_NOT_FOUND":
    case "SNAPSHOT_NOT_FOUND":
    case "SLO_NOT_FOUND":
    case "ANOMALY_NOT_FOUND":
    case "OPTIMIZATION_CANDIDATE_NOT_FOUND":
    case "TELEMETRY_NOT_FOUND":
      return 404;
    case "INVALID_WINDOW":
    case "INVALID_REVIEW_REQUEST":
      return 400;
    case "TELEMETRY_INTEGRITY_FAILED":
      return 409;
    default:
      return 409;
  }
}

export interface ObservabilityRouteDeps {
  observability: ObservabilityService;
}

export function registerObservabilityRoutes(
  app: FastifyInstance,
  deps: ObservabilityRouteDeps,
): void {
  app.post("/v1/projects/:projectId/observability/rebuild", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    const body = RebuildBodySchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    try {
      const result = await deps.observability.rebuild(params.data.projectId, {
        projectId: params.data.projectId,
        kind: body.data.kind,
        ...(body.data.lastN !== undefined ? { lastN: body.data.lastN } : {}),
        ...(body.data.startAt !== undefined ? { startAt: body.data.startAt } : {}),
        ...(body.data.endAt !== undefined ? { endAt: body.data.endAt } : {}),
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (isObservabilityError(error)) {
        return reply.status(httpStatusForObservability(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/projects/:projectId/health", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    const snapshot = await deps.observability.getLatestHealth(params.data.projectId);
    if (!snapshot) {
      return reply.status(404).send({ error: "SNAPSHOT_NOT_FOUND" });
    }
    return reply.status(200).send(snapshot);
  });

  app.get("/v1/projects/:projectId/metrics", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    const snapshot = await deps.observability.getLatestHealth(params.data.projectId);
    if (!snapshot) {
      return reply.status(404).send({ error: "SNAPSHOT_NOT_FOUND" });
    }
    return reply.status(200).send({
      reliabilityMetrics: snapshot.reliabilityMetrics,
      latencyMetrics: snapshot.latencyMetrics,
      resourceMetrics: snapshot.resourceMetrics,
    });
  });

  app.get("/v1/projects/:projectId/slo-evaluations", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    const evaluations = await deps.observability.sloEvaluations.listByProject(
      params.data.projectId,
    );
    return reply.status(200).send({ evaluations });
  });

  app.get("/v1/projects/:projectId/anomalies", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    const anomalies = await deps.observability.anomalies.listByProject(
      params.data.projectId,
    );
    return reply.status(200).send({ anomalies });
  });

  app.get(
    "/v1/projects/:projectId/optimization-candidates",
    async (request, reply) => {
      const params = ProjectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
      }
      const candidates =
        await deps.observability.optimizationCandidates.listByProject(
          params.data.projectId,
        );
      return reply.status(200).send({ candidates });
    },
  );

  app.get("/v1/runs/:runId/trace", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    try {
      const trace = await deps.observability.trace.trace(params.data.runId);
      return reply.status(200).send(trace);
    } catch (error) {
      if (isObservabilityError(error)) {
        return reply.status(httpStatusForObservability(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/projects/:projectId/funnel", async (request, reply) => {
    const params = ProjectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "INVALID_OBSERVABILITY_REQUEST" });
    }
    const snapshot = await deps.observability.getLatestHealth(params.data.projectId);
    if (!snapshot) {
      return reply.status(404).send({ error: "SNAPSHOT_NOT_FOUND" });
    }
    const funnel = await deps.observability.funnel.report(
      params.data.projectId,
      snapshot.windowFingerprint,
      snapshot.reliabilityMetrics[0]?.provenance.sourceRunIds ?? [],
    );
    return reply.status(200).send(funnel);
  });

  app.post(
    "/v1/optimization-candidates/:candidateId/review",
    async (request, reply) => {
      const params = CandidateParamsSchema.safeParse(request.params);
      const body = ReviewBodySchema.safeParse(request.body ?? {});
      if (!params.success || !body.success) {
        return reply.status(400).send({ error: "INVALID_REVIEW_REQUEST" });
      }
      try {
        const updated = await deps.observability.reviewOptimizationCandidate(
          params.data.candidateId,
          body.data.status,
        );
        return reply.status(200).send(updated);
      } catch (error) {
        if (isObservabilityError(error)) {
          return reply.status(httpStatusForObservability(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
