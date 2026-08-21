import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RunRepository } from "../admission/run-repository.js";
import type { ApprovalRequestRepository } from "../authorization/approval-request-repository.js";
import type { RequestAuthenticator } from "./auth.js";
import type { ProjectAccessDirectory } from "./access.js";
import type { DrainController } from "./startup.js";
import type { OperationalMetrics } from "./metrics.js";
import type { StructuredLogger } from "./logging.js";
import { SlidingWindowRateLimiter } from "./rate-limit.js";
import { isRuntimeError } from "./errors.js";
import { redactUnknown } from "./logging.js";
import {
  classifyHttpRoute,
  extractApprovalRequestIdFromUrl,
  extractProjectIdFromBody,
  extractRunIdFromUrl,
  extractWorkItemIdFromUrl,
} from "./http-routes.js";
import type { AuthenticationMode } from "./config.js";
import type { SchedulerWorkItemRepository } from "../scheduling/repositories.js";

export interface PerimeterDeps {
  authenticator: RequestAuthenticator;
  access: ProjectAccessDirectory;
  drain: DrainController;
  metrics: OperationalMetrics;
  logger: StructuredLogger;
  rateLimiter: SlidingWindowRateLimiter;
  authenticationMode: AuthenticationMode;
  runs?: RunRepository;
  approvalRequests?: ApprovalRequestRepository;
  workItems?: SchedulerWorkItemRepository;
  databaseAvailable?: () => Promise<boolean>;
}

export function productionErrorEnvelope(
  requestId: string,
  code: string,
  message: string,
): { error: string; message: string; requestId: string } {
  return {
    error: code,
    message: redactUnknown(message),
    requestId,
  };
}

function headerRecord(
  headers: FastifyRequest["headers"],
): Record<string, string | string[] | undefined> {
  return headers as Record<string, string | string[] | undefined>;
}

export async function registerPerimeter(
  app: FastifyInstance,
  deps: PerimeterDeps,
): Promise<void> {
  app.addHook("preHandler", async (request, reply) => {
    const started = Date.now();
    const requestIdHeader = request.headers["x-request-id"];
    const requestId =
      (Array.isArray(requestIdHeader) ? requestIdHeader[0] : requestIdHeader) ||
      `req_${crypto.randomUUID()}`;
    (request as { orchestratorRequestId?: string }).orchestratorRequestId =
      requestId;
    reply.header("x-request-id", requestId);

    const routeClass = classifyHttpRoute(request.method, request.url);
    if (routeClass === "PUBLIC_OPERATIONAL") {
      return;
    }

    if (!deps.drain.isAcceptingWork() && request.method !== "GET") {
      deps.metrics.increment("http_rejected_draining");
      return reply
        .status(503)
        .send(
          productionErrorEnvelope(
            requestId,
            "RUNTIME_DRAINING",
            "Process is draining and not accepting mutations",
          ),
        );
    }

    if (request.method !== "GET" && deps.databaseAvailable) {
      const available = await deps.databaseAvailable();
      if (!available) {
        deps.metrics.increment("http_rejected_database");
        return reply
          .status(503)
          .send(
            productionErrorEnvelope(
              requestId,
              "DATABASE_UNAVAILABLE",
              "PostgreSQL is unavailable; mutations fail closed",
            ),
          );
      }
    }

    try {
      const principal = deps.authenticator.authenticate(
        headerRecord(request.headers),
      );
      (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId =
        principal.principalId;

      if (
        deps.authenticationMode !== "ANONYMOUS" &&
        principal.authenticationMode === "ANONYMOUS"
      ) {
        return reply
          .status(401)
          .send(
            productionErrorEnvelope(
              requestId,
              "UNAUTHENTICATED",
              "Authentication required",
            ),
          );
      }

      if (
        routeClass === "AUTHENTICATED_MUTATION" ||
        routeClass === "APPROVER_OPERATION"
      ) {
        const allowed = deps.rateLimiter.allow(principal.principalId);
        if (!allowed) {
          deps.metrics.increment("http_rate_limited");
          return reply
            .status(429)
            .send(
              productionErrorEnvelope(
                requestId,
                "RATE_LIMITED",
                "Mutation rate limit exceeded",
              ),
            );
        }
      }

      const approvalRequestId = extractApprovalRequestIdFromUrl(request.url);
      const runId = extractRunIdFromUrl(request.url);
      const workItemId = extractWorkItemIdFromUrl(request.url);
      let projectId: string | undefined;
      if (approvalRequestId) {
        if (!deps.approvalRequests) {
          return reply
            .status(503)
            .send(
              productionErrorEnvelope(
                requestId,
                "PROJECT_ACCESS_DENIED",
                "ApprovalRequest project binding is unavailable",
              ),
            );
        }
        const approval = await deps.approvalRequests.getById(approvalRequestId);
        if (!approval) {
          return reply
            .status(404)
            .send(
              productionErrorEnvelope(
                requestId,
                "APPROVAL_REQUEST_NOT_FOUND",
                "Approval request not found",
              ),
            );
        }
        projectId = approval.projectId;
      } else if (workItemId) {
        if (!deps.workItems) {
          return reply
            .status(503)
            .send(
              productionErrorEnvelope(
                requestId,
                "PROJECT_ACCESS_DENIED",
                "Work item project binding is unavailable",
              ),
            );
        }
        const work = await deps.workItems.getById(workItemId);
        if (!work) {
          return reply
            .status(404)
            .send(
              productionErrorEnvelope(
                requestId,
                "WORK_ITEM_NOT_FOUND",
                "Work item not found",
              ),
            );
        }
        projectId = work.projectId;
      } else if (runId && deps.runs) {
        const run = await deps.runs.getById(runId);
        if (!run) {
          return reply
            .status(404)
            .send(
              productionErrorEnvelope(
                requestId,
                "RUN_NOT_FOUND",
                "Run not found",
              ),
            );
        }
        projectId = run.projectId;
      } else {
        const urlProject =
          /\/v1\/projects\/([^/]+)/.exec(request.url.split("?")[0] ?? "")?.[1];
        projectId = urlProject ?? extractProjectIdFromBody(request.body);
      }
      // Portfolio snapshot is principal-scoped in the route handler.
      if (
        projectId &&
        !deps.access.canAccessProject(principal.principalId, projectId)
      ) {
        deps.metrics.increment("http_project_access_denied");
        return reply
          .status(403)
          .send(
            productionErrorEnvelope(
              requestId,
              "PROJECT_ACCESS_DENIED",
              "Caller is not bound to this project",
            ),
          );
      }

      deps.logger.log({
        level: "info",
        operation: "http.request",
        result: "authorized_perimeter",
        requestId,
        projectId,
        runId,
        durationMs: Date.now() - started,
        message: `${request.method} ${request.url}`,
      });
    } catch (error) {
      const code = isRuntimeError(error) ? error.code : "UNAUTHENTICATED";
      return reply
        .status(401)
        .send(
          productionErrorEnvelope(
            requestId,
            code,
            error instanceof Error ? error.message : "unauthenticated",
          ),
        );
    }
    return;
  });

  app.setErrorHandler((error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId =
      (request as { orchestratorRequestId?: string }).orchestratorRequestId ??
      "unknown";
    deps.logger.log({
      level: "error",
      operation: "http.error",
      result: "error",
      requestId,
      message: redactUnknown(error),
    });
    const status =
      "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    return reply.status(status >= 400 ? status : 500).send(
      productionErrorEnvelope(
        requestId,
        "INTERNAL_ERROR",
        status >= 500 ? "Internal error" : redactUnknown(error.message),
      ),
    );
  });
}
