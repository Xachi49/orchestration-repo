import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { PortfolioSchedulerService } from "../scheduling/service.js";
import type { RunRepository } from "../admission/run-repository.js";
import { isSchedulingError } from "../scheduling/errors.js";
import { DEPENDENCY_MILESTONES } from "../scheduling/dependency.js";

const ProjectParams = z.object({ projectId: z.string().min(1) }).strict();
const RunParams = z.object({ runId: z.string().min(1) }).strict();
const WorkParams = z.object({ workItemId: z.string().min(1) }).strict();

const DependencyBody = z
  .object({
    dependentRunId: z.string().min(1),
    prerequisiteRunId: z.string().min(1),
    requiredMilestone: z.enum(DEPENDENCY_MILESTONES),
  })
  .strict();

/** Principal is stamped on the request by the Phase 12 perimeter. */
function principalId(request: FastifyRequest): string {
  return (
    (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId ??
    "anonymous"
  );
}

/**
 * Authenticated portfolio / scheduling read + operational pause APIs.
 * Project isolation is enforced by the Phase 12 perimeter using URL/body projectId
 * and run-derived projectId for run-scoped routes.
 */
export function registerSchedulerRoutes(
  app: FastifyInstance,
  deps: {
    scheduler: PortfolioSchedulerService;
    runs: RunRepository;
  },
): void {
  app.get("/v1/portfolio", async (_request, reply) => {
    const snapshot = await deps.scheduler.portfolioSnapshot();
    return reply.send(snapshot);
  });

  app.get("/v1/projects/:projectId/work", async (request, reply) => {
    const params = ProjectParams.parse(request.params);
    const work = await deps.scheduler.listWorkForProject(params.projectId);
    return reply.send({ projectId: params.projectId, work });
  });

  app.get("/v1/runs/:runId/work", async (request, reply) => {
    const params = RunParams.parse(request.params);
    const run = await deps.runs.getById(params.runId);
    if (!run) {
      return reply.status(404).send({
        error: "RUN_NOT_FOUND",
        message: `Unknown run ${params.runId}`,
      });
    }
    const work = await deps.scheduler.listWorkForRun(params.runId);
    return reply.send({
      runId: params.runId,
      projectId: run.projectId,
      work,
    });
  });

  app.get("/v1/work-items/:workItemId", async (request, reply) => {
    const params = WorkParams.parse(request.params);
    const explained = await deps.scheduler.explainWork(params.workItemId);
    if (!explained) {
      return reply.status(404).send({
        error: "WORK_ITEM_NOT_FOUND",
        message: `Unknown work item ${params.workItemId}`,
      });
    }
    return reply.send({
      status: explained.work.status,
      phase: explained.work.workKind,
      priority: explained.work.priorityClass,
      attemptCount: explained.work.attemptCount,
      reason: explained.work.failureReasonCode ?? null,
      dependencyState: explained.dependencies,
      decisions: explained.decisions,
      work: explained.work,
    });
  });

  app.post(
    "/v1/projects/:projectId/scheduling/pause",
    async (request, reply) => {
      const params = ProjectParams.parse(request.params);
      try {
        const pause = await deps.scheduler.setPause({
          scope: "PROJECT",
          projectId: params.projectId,
          paused: true,
          principalId: principalId(request),
        });
        return reply.send(pause);
      } catch (error) {
        if (isSchedulingError(error)) {
          return reply.status(409).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/projects/:projectId/scheduling/resume",
    async (request, reply) => {
      const params = ProjectParams.parse(request.params);
      try {
        const pause = await deps.scheduler.setPause({
          scope: "PROJECT",
          projectId: params.projectId,
          paused: false,
          principalId: principalId(request),
        });
        return reply.send(pause);
      } catch (error) {
        if (isSchedulingError(error)) {
          return reply.status(409).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/projects/:projectId/scheduling/dependencies",
    async (request, reply) => {
      const params = ProjectParams.parse(request.params);
      const body = DependencyBody.parse(request.body);
      try {
        const dependency = await deps.scheduler.registerDependency({
          projectId: params.projectId,
          dependentRunId: body.dependentRunId,
          prerequisiteRunId: body.prerequisiteRunId,
          requiredMilestone: body.requiredMilestone,
        });
        return reply.status(201).send(dependency);
      } catch (error) {
        if (isSchedulingError(error)) {
          const status =
            error.code === "CROSS_PROJECT_DEPENDENCY_DENIED" ||
            error.code === "SELF_DEPENDENCY" ||
            error.code === "DEPENDENCY_CYCLE"
              ? 400
              : 409;
          return reply.status(status).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );
}
