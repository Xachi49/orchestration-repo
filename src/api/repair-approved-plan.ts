import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ApprovedPlanRepairService,
  isApprovedPlanRepairError,
  type ApprovedPlanRepairErrorCode,
} from "../planning/approved-plan-repair.js";

const RunParamsSchema = z.object({ runId: z.string().min(1) }).strict();
const BodySchema = z
  .object({
    reason: z.string().min(1),
    operatorPrincipalId: z.string().min(1).optional(),
  })
  .strict();

export function httpStatusForApprovedPlanRepair(
  code: ApprovedPlanRepairErrorCode,
): number {
  switch (code) {
    case "RUN_NOT_FOUND":
      return 404;
    case "REPAIR_IN_PROGRESS":
    case "REPAIR_CONFLICT":
      return 409;
    case "REPAIR_REASON_DENIED":
    case "REPAIR_NOT_ELIGIBLE":
    case "REPAIR_BINDING_FAILED":
    case "REPAIR_SEMANTIC_CHANGE_DENIED":
      return 409;
    default:
      return 409;
  }
}

export interface ApprovedPlanRepairRouteDeps {
  repair: ApprovedPlanRepairService;
}

export function registerApprovedPlanRepairRoutes(
  app: FastifyInstance,
  deps: ApprovedPlanRepairRouteDeps,
): void {
  app.post("/v1/runs/:runId/repair-approved-plan", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_REPAIR_REQUEST",
        message: "runId is required",
      });
    }
    // Refuse operator-supplied target/plan identity fields if present on raw body.
    const raw = (request.body ?? {}) as Record<string, unknown>;
    const forbidden = [
      "targetIds",
      "caseId",
      "leadId",
      "templateId",
      "planHash",
      "planVersion",
      "planId",
      "newPlanId",
      "newPlanVersion",
    ];
    for (const key of forbidden) {
      if (key in raw) {
        return reply.status(400).send({
          error: "REPAIR_SEMANTIC_CHANGE_DENIED",
          message: `Caller must not supply ${key}; bindings come from canonical state`,
        });
      }
    }
    const body = BodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({
        error: "INVALID_REPAIR_REQUEST",
        message: "reason is required; callers must not supply target bindings",
      });
    }

    try {
      const result = await deps.repair.repairApprovedPlan({
        runId: params.data.runId,
        reason: body.data.reason,
        ...(body.data.operatorPrincipalId !== undefined
          ? { operatorPrincipalId: body.data.operatorPrincipalId }
          : {}),
      });
      return reply.status(200).send(result);
    } catch (error) {
      if (isApprovedPlanRepairError(error)) {
        return reply.status(httpStatusForApprovedPlanRepair(error.code)).send({
          error: error.code,
          message: error.message,
          details: error.details,
        });
      }
      throw error;
    }
  });
}
