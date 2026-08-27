import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { AuthorizationRoutingService } from "../authorization/routing.js";
import type { HumanAuthorizationService } from "../authorization/service.js";
import type { ApprovalExpiryService } from "../authorization/expiry.js";
import type { AuthorizationReadinessService } from "../authorization/readiness.js";
import {
  isAuthorizationError,
  type AuthorizationErrorCode,
} from "../authorization/errors.js";
import { HumanAuthorizationDecisionSchema } from "../domain/authorization/index.js";

const RunParamsSchema = z.object({ runId: z.string().min(1) }).strict();
const ApprovalParamsSchema = z
  .object({ approvalRequestId: z.string().min(1) })
  .strict();

export function httpStatusForAuthorization(
  code: AuthorizationErrorCode,
): number {
  switch (code) {
    case "APPROVAL_REQUEST_NOT_FOUND":
      return 404;
    case "AUTHORIZATION_NOT_READY":
    case "APPROVAL_REQUEST_ALREADY_EXISTS":
    case "APPROVAL_REQUEST_NOT_PENDING":
    case "APPROVAL_REQUEST_EXPIRED":
    case "APPROVAL_REQUEST_IMMUTABLE":
    case "AUTHORIZATION_DECISION_REPLAYED":
    case "INVALID_DECISION_NONCE":
    case "AUTHORIZATION_BINDING_MISMATCH":
    case "AUTHORIZATION_BINDING_STALE":
    case "DECISION_CARD_HASH_MISMATCH":
    case "PLAN_SUPERSEDED":
    case "POLICY_CHANGED_DURING_APPROVAL":
    case "REPOSITORY_CHANGED_DURING_APPROVAL":
    case "CAPABILITY_CHANGED_DURING_APPROVAL":
    case "AUTHORIZATION_ALREADY_DECIDED":
    case "INVALID_AUTHORIZATION_STATE":
    case "AUTHORIZATION_DECISION_NOT_TERMINAL":
    case "MODIFICATION_REQUEST_INVALID":
    case "APPROVAL_REISSUE_NOT_ELIGIBLE":
      return 409;
    case "APPROVER_UNAUTHORIZED":
    case "UNKNOWN_APPROVER":
    case "PROJECT_ACCESS_DENIED":
      return 403;
    case "APPROVAL_DELIVERY_FAILED":
      return 502;
    case "AUTHORIZATION_PERSISTENCE_FAILED":
      return 500;
    default:
      return 409;
  }
}

export interface AuthorizationRouteDeps {
  routing: AuthorizationRoutingService;
  humanAuthorization: HumanAuthorizationService;
  expiry: ApprovalExpiryService;
  readiness: AuthorizationReadinessService;
}

export function registerAuthorizationRoutes(
  app: FastifyInstance,
  deps: AuthorizationRouteDeps,
): void {
  app.post("/v1/runs/:runId/authorization-route", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_AUTHORIZATION_REQUEST",
        message: "runId is required",
      });
    }
    try {
      const result = await deps.routing.route(params.data.runId);
      return reply.status(200).send(result);
    } catch (error) {
      if (isAuthorizationError(error)) {
        return reply.status(httpStatusForAuthorization(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.get("/v1/runs/:runId/approval-request", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_AUTHORIZATION_REQUEST",
        message: "runId is required",
      });
    }
    const pending = await deps.humanAuthorization.getPendingRequest(
      params.data.runId,
    );
    if (!pending) {
      return reply.status(404).send({
        error: "APPROVAL_REQUEST_NOT_FOUND",
        message: `No pending approval request for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(pending);
  });

  app.post(
    "/v1/approval-requests/:approvalRequestId/decision",
    async (request, reply) => {
      const params = ApprovalParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({
          error: "INVALID_AUTHORIZATION_REQUEST",
          message: "approvalRequestId is required",
        });
      }
      const body = HumanAuthorizationDecisionSchema.omit({
        approvalRequestId: true,
      }).safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "INVALID_AUTHORIZATION_REQUEST",
          message: "Invalid human authorization decision payload",
          issues: body.error.issues,
        });
      }
      try {
        const result = await deps.humanAuthorization.decide({
          approvalRequestId: params.data.approvalRequestId,
          ...body.data,
        });
        return reply.status(200).send(result);
      } catch (error) {
        if (isAuthorizationError(error)) {
          return reply.status(httpStatusForAuthorization(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.get("/v1/runs/:runId/authorization", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_AUTHORIZATION_REQUEST",
        message: "runId is required",
      });
    }
    const record = await deps.humanAuthorization.getLatestAuthorization(
      params.data.runId,
    );
    if (!record) {
      return reply.status(404).send({
        error: "AUTHORIZATION_RECORD_NOT_FOUND",
        message: `No authorization record for run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(record);
  });

  app.post("/v1/approval-requests/expire", async (request, reply) => {
    const body = z
      .object({ now: z.string().datetime().optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!body.success) {
      return reply.status(400).send({
        error: "INVALID_AUTHORIZATION_REQUEST",
        message: "Invalid expire payload",
      });
    }
    const result = await deps.expiry.expireDueRequests(body.data.now);
    return reply.status(200).send(result);
  });

  app.get("/v1/runs/:runId/authorization-readiness", async (request, reply) => {
    const params = RunParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_AUTHORIZATION_REQUEST",
        message: "runId is required",
      });
    }
    const readiness = await deps.readiness.assess(params.data.runId);
    return reply.status(200).send(readiness);
  });
}
