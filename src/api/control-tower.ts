import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ControlTowerService } from "../control-tower/service.js";
import type { ProjectAccessDirectory } from "../runtime/access.js";
import { resolveControlTowerViewer } from "../control-tower/access-scope.js";

export type ControlTowerRouteOptions = {
  access?: ProjectAccessDirectory;
  authenticationMode?: "ANONYMOUS" | "HEADER_PRINCIPAL" | "STATIC_PRINCIPAL";
  runtimeEnvironment?: string;
  /**
   * When false (PRODUCTION composition), local-delivery is not registered.
   * DEVELOPMENT/TEST may enable FakeApprovalDeliveryAdapter nonce channel.
   */
  allowLocalDelivery?: boolean;
  /**
   * Explicit DEVELOPMENT/TEST unrestricted CT reads.
   * Never inferred from empty bindings or ANONYMOUS alone.
   */
  controlTowerDevAllowAll?: boolean;
};

function principalId(request: FastifyRequest): string {
  const fromRequest = (request as { orchestratorPrincipalId?: string })
    .orchestratorPrincipalId;
  if (fromRequest) return fromRequest;
  // Without perimeter: do not invent bootstrap identity. Anonymous only.
  return "anonymous";
}

function viewerFor(
  request: FastifyRequest,
  options: ControlTowerRouteOptions,
) {
  return resolveControlTowerViewer({
    principalId: principalId(request),
    ...(options.access ? { access: options.access } : {}),
    authenticationMode: options.authenticationMode ?? "ANONYMOUS",
    runtimeEnvironment: options.runtimeEnvironment ?? "DEVELOPMENT",
    controlTowerDevAllowAll: options.controlTowerDevAllowAll === true,
  });
}

function requireAuthenticatedOperator(
  options: ControlTowerRouteOptions,
  reply: FastifyReply,
): boolean {
  const mode = options.authenticationMode ?? "ANONYMOUS";
  if (mode === "ANONYMOUS") {
    void reply.status(401).send({
      error: "UNAUTHENTICATED",
      message:
        "Assurance/qualification reads require an authenticated operator context (ANONYMOUS != AUTHENTICATED PRINCIPAL)",
    });
    return false;
  }
  return true;
}

/**
 * Read-only Control Tower composition endpoints + optional local delivery helper.
 * Mutations continue to use canonical Phase2/6/7/8 routes.
 */
export function registerControlTowerRoutes(
  app: FastifyInstance,
  service: ControlTowerService,
  options: ControlTowerRouteOptions = {},
): void {
  const allowLocalDelivery = options.allowLocalDelivery === true;
  const controlTowerDevAllowAll = options.controlTowerDevAllowAll === true;

  app.get("/v1/control-tower/identity-mode", async (_request, reply) => {
    const mode = options.authenticationMode ?? "ANONYMOUS";
    const developmentIdentityAdapter = mode === "HEADER_PRINCIPAL";
    return reply.status(200).send({
      authenticationMode: mode,
      runtimeEnvironment: options.runtimeEnvironment ?? "DEVELOPMENT",
      developmentIdentityAdapter,
      localDeliveryEnabled: allowLocalDelivery,
      controlTowerDevAllowAll,
      doctrine: {
        clientProvidedPrincipalNotAuthenticated:
          "CLIENT-PROVIDED PRINCIPAL != AUTHENTICATED PRINCIPAL",
        anonymousNotAuthenticated: "ANONYMOUS != AUTHENTICATED PRINCIPAL",
        controlTowerNotAuthority: "CONTROL TOWER != AUTHORITY",
      },
    });
  });

  app.get("/v1/control-tower/projects", async (request, reply) => {
    const viewer = viewerFor(request, options);
    return reply.status(200).send({
      principalId: viewer.principalId,
      projects: viewer.unrestricted ? [] : [...viewer.allowedProjectIds],
      unrestricted: viewer.unrestricted,
    });
  });

  app.get("/v1/control-tower/dashboard", async (request, reply) => {
    const dashboard = await service.getDashboard(viewerFor(request, options));
    return reply.status(200).send(dashboard);
  });

  app.get("/v1/runs", async (request, reply) => {
    const query = z
      .object({
        projectId: z.string().min(1).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      })
      .safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({
        error: "INVALID_QUERY",
        message: "Invalid runs list query",
      });
    }
    const runs = await service.listRuns(viewerFor(request, options), {
      ...(query.data.projectId !== undefined
        ? { projectId: query.data.projectId }
        : {}),
      ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
    });
    return reply.status(200).send({ runs });
  });

  app.get("/v1/runs/:runId", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_RUN_ID",
        message: "runId is required",
      });
    }
    const detail = await service.getRunDetail(
      viewerFor(request, options),
      params.data.runId,
    );
    if (detail === "FORBIDDEN") {
      return reply.status(403).send({
        error: "PROJECT_ACCESS_DENIED",
        message: "Caller is not bound to this project",
      });
    }
    if (!detail) {
      return reply.status(404).send({
        error: "RUN_NOT_FOUND",
        message: `Unknown run ${params.data.runId}`,
      });
    }
    return reply.status(200).send(detail);
  });

  app.get("/v1/runs/:runId/timeline", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_RUN_ID",
        message: "runId is required",
      });
    }
    const detail = await service.getRunDetail(
      viewerFor(request, options),
      params.data.runId,
    );
    if (detail === "FORBIDDEN") {
      return reply.status(403).send({
        error: "PROJECT_ACCESS_DENIED",
        message: "Caller is not bound to this project",
      });
    }
    if (!detail) {
      return reply.status(404).send({
        error: "RUN_NOT_FOUND",
        message: `Unknown run ${params.data.runId}`,
      });
    }
    return reply.status(200).send({
      runId: detail.run.runId,
      state: detail.run.state,
      timeline: detail.timeline,
      hasCompletion: Boolean(detail.completion),
      doctrine: detail.doctrine,
    });
  });

  app.get("/v1/runs/:runId/evidence", async (request, reply) => {
    const params = z.object({ runId: z.string().min(1) }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_RUN_ID",
        message: "runId is required",
      });
    }
    const detail = await service.getRunDetail(
      viewerFor(request, options),
      params.data.runId,
    );
    if (detail === "FORBIDDEN") {
      return reply.status(403).send({
        error: "PROJECT_ACCESS_DENIED",
        message: "Caller is not bound to this project",
      });
    }
    if (!detail) {
      return reply.status(404).send({
        error: "RUN_NOT_FOUND",
        message: `Unknown run ${params.data.runId}`,
      });
    }
    return reply.status(200).send({
      runId: detail.run.runId,
      validation: detail.validation,
      verification: detail.verification,
      completion: detail.completion,
      repositoryContext: detail.repositoryContext,
      plan: detail.plan
        ? {
            planId: (detail.plan as { planId?: string }).planId,
            planVersion: (detail.plan as { planVersion?: number }).planVersion,
            planHash: (detail.plan as { planHash?: string }).planHash,
          }
        : null,
    });
  });

  app.get("/v1/approvals", async (request, reply) => {
    const approvals = await service.listPendingApprovals(
      viewerFor(request, options),
    );
    return reply.status(200).send({ approvals });
  });

  app.get("/v1/approvals/:approvalRequestId", async (request, reply) => {
    const params = z
      .object({ approvalRequestId: z.string().min(1) })
      .safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({
        error: "INVALID_APPROVAL_ID",
        message: "approvalRequestId is required",
      });
    }
    const detail = await service.getApprovalDetail(
      viewerFor(request, options),
      params.data.approvalRequestId,
    );
    if (detail === "FORBIDDEN") {
      return reply.status(403).send({
        error: "PROJECT_ACCESS_DENIED",
        message: "Caller is not bound to this project",
      });
    }
    if (!detail) {
      return reply.status(404).send({
        error: "APPROVAL_REQUEST_NOT_FOUND",
        message: `Unknown approval ${params.data.approvalRequestId}`,
      });
    }
    return reply.status(200).send(detail);
  });

  if (allowLocalDelivery) {
    /**
     * Local/test out-of-band delivery simulation.
     * Registered only when FakeApprovalDelivery is enabled (non-PRODUCTION).
     * Never returns decisionNonceHash.
     */
    app.get(
      "/v1/approvals/:approvalRequestId/local-delivery",
      async (request, reply) => {
        const params = z
          .object({ approvalRequestId: z.string().min(1) })
          .safeParse(request.params);
        if (!params.success) {
          return reply.status(400).send({
            error: "INVALID_APPROVAL_ID",
            message: "approvalRequestId is required",
          });
        }
        const detail = await service.getApprovalDetail(
          viewerFor(request, options),
          params.data.approvalRequestId,
        );
        if (detail === "FORBIDDEN") {
          return reply.status(403).send({
            error: "PROJECT_ACCESS_DENIED",
            message: "Caller is not bound to this project",
          });
        }
        if (!detail) {
          return reply.status(404).send({
            error: "APPROVAL_REQUEST_NOT_FOUND",
            message: `Unknown approval ${params.data.approvalRequestId}`,
          });
        }
        const nonce = service.getLocalDeliveryNonce(
          params.data.approvalRequestId,
        );
        if (!nonce) {
          return reply.status(404).send({
            error: "DELIVERY_NOT_AVAILABLE",
            message:
              "No local fake delivery nonce. Production operators receive the nonce out-of-band.",
            channel: "NONE",
          });
        }
        return reply.status(200).send({
          channel: "FAKE_LOCAL",
          approvalRequestId: params.data.approvalRequestId,
          decisionNonce: nonce,
        });
      },
    );
  }

  app.get("/v1/system/assurance", async (_request, reply) => {
    if (!requireAuthenticatedOperator(options, reply)) return;
    return reply.status(200).send(await service.getAssuranceSnapshot());
  });

  app.get("/v1/system/qualification", async (_request, reply) => {
    if (!requireAuthenticatedOperator(options, reply)) return;
    return reply.status(200).send(await service.getQualificationSnapshot());
  });
}
