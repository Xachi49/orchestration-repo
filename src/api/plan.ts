import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { PlanningService } from "../planning/service.js";
import {
  isPlanningError,
  type PlanningErrorCode,
} from "../planning/errors.js";

const PlanParamsSchema = z.object({ runId: z.string().min(1) }).strict();

export function httpStatusForPlanning(code: PlanningErrorCode): number {
  switch (code) {
    case "PLANNING_IN_PROGRESS":
    case "PLANNING_NOT_READY":
    case "REPOSITORY_CONTEXT_STALE":
    case "PLANNING_CONTEXT_MISMATCH":
    case "INVALID_EVIDENCE_REFERENCE":
    case "INVALID_CAPABILITY_REFERENCE":
    case "PLAN_DEPENDENCY_CYCLE":
    case "PLAN_DEPENDENCY_MISSING":
    case "PLAN_RESOURCE_BUDGET_EXCEEDED":
    case "PLANNING_MODEL_BUDGET_EXCEEDED":
    case "PLANNING_MODEL_BUDGET_INVARIANT_VIOLATION":
    case "PLAN_RESOURCE_UNESTIMATED":
    case "PLAN_QUALITY_BELOW_THRESHOLD":
    case "INVALID_PLANNING_STATE":
      return 409;
    case "OBJECTIVE_NOT_FOUND":
      return 404;
    case "PLANNING_MODEL_UNAVAILABLE":
    case "PLANNING_MODEL_TIMEOUT":
      return 502;
    case "PLANNING_MODEL_REFUSED":
    case "PLANNING_MODEL_INVALID_OUTPUT":
      return 422;
    case "PLAN_PERSISTENCE_FAILED":
    case "PLANNING_RECONCILIATION_FAILED":
    case "PLANNING_CONTEXT_BUDGET_EXCEEDED":
      return 500;
    default:
      return 409;
  }
}

export function registerPlanRoutes(
  app: FastifyInstance,
  planning: PlanningService,
): void {
  app.post("/v1/runs/:runId/plan", async (request, reply) => {
    const params = PlanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_PLANNING_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const result = await planning.plan(params.data.runId);
      return reply.status(200).send(result);
    } catch (error) {
      if (isPlanningError(error)) {
        return reply.status(httpStatusForPlanning(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/plan", async (request, reply) => {
    const params = PlanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_PLANNING_REQUEST",
        message: "runId is required",
      });
    }
    const plan = await planning.getPlan(params.data.runId);
    if (!plan) {
      return reply.status(404).send({
        error: "PLAN_NOT_FOUND",
        message: `No plan for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(plan);
  });

  app.get("/v1/runs/:runId/planning-context", async (request, reply) => {
    const params = PlanParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_PLANNING_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const stored = await planning.getPlan(params.data.runId);
      if (stored) {
        return reply.status(200).send({
          planningContextFingerprint: stored.planningContextFingerprint,
          selectedEvidenceIds: [],
          excludedEvidenceIds: [],
          promptVersion: stored.planningPromptVersion,
          planId: stored.planId,
          planHash: stored.planHash,
          status: stored.status,
        });
      }
      const context = await planning.compileContext(params.data.runId);
      return reply.status(200).send({
        planningContextFingerprint:
          context.contextMetadata.planningContextFingerprint,
        selectedEvidenceIds: context.contextMetadata.selectedEvidenceIds,
        excludedEvidenceIds: context.contextMetadata.excludedEvidenceIds,
        promptVersion: context.contextMetadata.promptVersion,
        compilerVersion: context.contextMetadata.compilerVersion,
        budgetEstimate: context.contextMetadata.budgetEstimate,
        repository: {
          commitSha: context.repository.commitSha,
          repositoryFingerprint: context.repository.repositoryFingerprint,
          liveLockedStatus: context.repository.liveLockedStatus,
        },
        knownUnknowns: context.knownUnknowns,
      });
    } catch (error) {
      if (isPlanningError(error)) {
        return reply.status(httpStatusForPlanning(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });
}
