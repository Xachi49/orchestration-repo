import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  isRevenueRecoveryError,
  LeadIngestSchema,
  LeadEventIngestSchema,
  RecoveryConfigurationInputSchema,
  type RevenueRecoveryService,
} from "../revenue-recovery/index.js";
import type { ProjectAccessDirectory } from "../runtime/access.js";

function httpStatus(code: string): number {
  switch (code) {
    case "LEAD_NOT_FOUND":
    case "RECOVERY_CASE_NOT_FOUND":
    case "TEMPLATE_NOT_FOUND":
    case "RECOVERY_CONFIG_MISSING":
    case "PROJECT_NOT_FOUND":
      return 404;
    case "RECOVERY_TEMPLATE_IDENTITY_CONFLICT":
    case "RECOVERY_TEMPLATE_VERSION_CONFLICT":
      return 409;
    case "TEMPLATE_VARIABLE_UNSUPPORTED":
      return 422;
    case "TEMPLATE_PROVISIONING_UNAVAILABLE":
    case "OBJECTIVE_REISSUE_UNAVAILABLE":
      return 503;
    case "OBJECTIVE_REISSUE_NOT_ELIGIBLE":
    case "OBJECTIVE_REISSUE_ALREADY_EXISTS":
    case "OBJECTIVE_REISSUE_CONFLICT":
    case "OBJECTIVE_REISSUE_AUTHORITY_PRESENT":
    case "OBJECTIVE_REISSUE_BINDING_CHANGED":
    case "RUN_REPLACEMENT_NOT_ELIGIBLE":
    case "RUN_REPLACEMENT_LIMIT_REACHED":
    case "RUN_REPLACEMENT_CONFLICT":
    case "RUN_REPLACEMENT_AUTHORITY_PRESENT":
    case "RUN_REPLACEMENT_BINDING_CHANGED":
      return 409;
    case "RUN_REPLACEMENT_UNAVAILABLE":
      return 503;
    case "TENANT_ISOLATION_VIOLATION":
    case "CONTACT_NOT_PERMITTED":
    case "CONTACT_WINDOW_CLOSED":
    case "RECOVERY_SUPPRESSED":
    case "PROVENANCE_NOT_PERMITTED":
      return 403;
    case "LEAD_SOURCE_CONFLICT":
    case "LEAD_EVENT_CONFLICT":
    case "RECOVERY_CASE_ALREADY_OPEN":
    case "RECOVERY_RECORD_CONFLICT":
    case "RECOVERY_OBJECTIVE_CONFLICT":
    case "RECOVERY_CAS_CONFLICT":
    case "RECOVERY_STATE_CONFLICT":
    case "EXECUTION_ACTION_CONFLICT":
      return 409;
    case "ATTEMPT_LIMIT_REACHED":
    case "RECOVERY_ACTION_TARGET_MISMATCH":
    case "ATTRIBUTION_INVALID":
    case "RESPONSE_GAP_NOT_ELIGIBLE":
      return 422;
    default:
      return 400;
  }
}

/**
 * Keys a caller may never supply over HTTP.
 *
 * CALLER ASSERTION != AUTHORIZATION — outreach authority comes only from a
 * durable Phase6 AuthorizationRecord via Phase7.
 * EVENT KIND != TRUST PROVENANCE — provenance is server-assigned.
 */
const FORBIDDEN_BODY_KEYS = [
  "humanAuthorizationConfirmed",
  "trustProvenance",
] as const;

function forbiddenBodyKey(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  return (
    FORBIDDEN_BODY_KEYS.find((key) =>
      Object.prototype.hasOwnProperty.call(body, key),
    ) ?? null
  );
}

const TemplateScopeQuerySchema = z
  .object({
    customerAccountId: z.string().min(1),
    projectId: z.string().min(1),
    channel: z.enum(["SMS", "EMAIL"]).optional(),
  })
  .strict();

const TemplateVersionParamsSchema = z
  .object({
    templateId: z.string().min(1),
    version: z.coerce.number().int().positive(),
  })
  .strict();

function principalOf(request: FastifyRequest): string | undefined {
  return (request as { orchestratorPrincipalId?: string }).orchestratorPrincipalId;
}

export function registerRevenueRecoveryRoutes(
  app: FastifyInstance,
  deps: {
    revenueRecovery: RevenueRecoveryService;
    /** Perimeter project access; present whenever the authenticated perimeter is composed. */
    access?: ProjectAccessDirectory;
  },
): void {
  const service = deps.revenueRecovery;

  /**
   * CUSTOMER ACCOUNT != PROJECT AUTHORITY. Query-string projectIds are not seen
   * by the perimeter, so template routes re-check project access here.
   */
  function denyProjectAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    projectId: string,
  ): boolean {
    if (!deps.access) return false;
    const principalId = principalOf(request);
    if (!principalId || !deps.access.canAccessProject(principalId, projectId)) {
      void reply.code(403).send({
        error: "PROJECT_ACCESS_DENIED",
        message: "Caller is not bound to this project",
      });
      return true;
    }
    return false;
  }

  function sendRecoveryError(reply: FastifyReply, error: unknown) {
    if (isRevenueRecoveryError(error)) {
      return reply.code(httpStatus(error.code)).send({
        error: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      });
    }
    throw error;
  }

  app.addHook("preValidation", async (request, reply) => {
    if (!request.url.startsWith("/v1/revenue-recovery/")) return;
    const key = forbiddenBodyKey(request.body);
    if (key) {
      return reply.code(400).send({
        error: "CALLER_ASSERTION_REJECTED",
        message: `Request body must not contain ${key}`,
      });
    }
  });

  app.post("/v1/revenue-recovery/config", async (request, reply) => {
    try {
      const body = RecoveryConfigurationInputSchema.parse(request.body);
      const config = await service.putConfiguration(body);
      return reply.code(201).send(config);
    } catch (error) {
      if (isRevenueRecoveryError(error)) {
        return reply.code(httpStatus(error.code)).send({
          error: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  });

  app.post("/v1/revenue-recovery/leads", async (request, reply) => {
    try {
      const body = LeadIngestSchema.parse(request.body);
      const result = await service.ingestLead(body);
      return reply.code(result.created ? 201 : 200).send(result);
    } catch (error) {
      if (isRevenueRecoveryError(error)) {
        return reply.code(httpStatus(error.code)).send({
          error: error.code,
          message: error.message,
          details: error.details,
        });
      }
      throw error;
    }
  });

  app.post(
    "/v1/revenue-recovery/leads/:leadId/events",
    async (request, reply) => {
      try {
        const params = z
          .object({ leadId: z.string().min(1) })
          .parse(request.params);
        const body = LeadEventIngestSchema.parse({
          ...(request.body as object),
          leadId: params.leadId,
        });
        // Generic ingest is always MANUAL_ATTESTATION: a caller-supplied
        // SALE_RECORDED / PAYMENT_RECORDED can only become ATTESTED_*.
        const result = await service.appendLeadEvent(body);
        return reply.code(result.created ? 201 : 200).send(result);
      } catch (error) {
        if (isRevenueRecoveryError(error)) {
          return reply.code(httpStatus(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.post(
    "/v1/revenue-recovery/leads/:leadId/detect-gap",
    async (request, reply) => {
      try {
        const params = z
          .object({ leadId: z.string().min(1) })
          .parse(request.params);
        const body = z
          .object({
            customerAccountId: z.string().min(1),
            projectId: z.string().min(1),
          })
          .strict()
          .parse(request.body);
        const result = await service.detectAndOpenRecoveryCase({
          leadId: params.leadId,
          ...body,
        });
        return reply.code(200).send(result);
      } catch (error) {
        if (isRevenueRecoveryError(error)) {
          return reply.code(httpStatus(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.get(
    "/v1/revenue-recovery/cases/:recoveryCaseId",
    async (request, reply) => {
      try {
        const params = z
          .object({ recoveryCaseId: z.string().min(1) })
          .parse(request.params);
        const query = z
          .object({
            customerAccountId: z.string().min(1),
            projectId: z.string().min(1),
          })
          .parse(request.query);
        if (denyProjectAccess(request, reply, query.projectId)) {
          return reply;
        }
        const detail = await service.getCaseDetail({
          recoveryCaseId: params.recoveryCaseId,
          ...query,
        });
        return reply.send(detail);
      } catch (error) {
        if (isRevenueRecoveryError(error)) {
          return reply.code(httpStatus(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  app.get("/v1/revenue-recovery/dashboard", async (request, reply) => {
    const query = z
      .object({
        customerAccountId: z.string().min(1),
        projectId: z.string().min(1),
      })
      .parse(request.query);
    return reply.send(await service.getDashboard(query));
  });

  app.post(
    "/v1/revenue-recovery/cases/:recoveryCaseId/prepare-objective",
    async (request, reply) => {
      try {
        const params = z
          .object({ recoveryCaseId: z.string().min(1) })
          .parse(request.params);
        const body = z
          .object({
            requesterId: z.string().min(1),
            requestedEnvironment: z.string().min(1),
            admit: z.boolean().optional(),
          })
          .strict()
          .parse(request.body);
        const result = await service.prepareRecoveryObjective({
          recoveryCaseId: params.recoveryCaseId,
          requesterId: body.requesterId,
          requestedEnvironment: body.requestedEnvironment,
          admit: body.admit === true,
        });
        return reply.send(result);
      } catch (error) {
        if (isRevenueRecoveryError(error)) {
          return reply.code(httpStatus(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        throw error;
      }
    },
  );

  // RUN REPLACEMENT != OBJECTIVE RESUBMISSION. Same objective version, new
  // run attempt. The principal is lineage only and grants no execution authority.
  app.post(
    "/v1/revenue-recovery/cases/:recoveryCaseId/run-replacement",
    async (request, reply) => {
      const params = z
        .object({ recoveryCaseId: z.string().min(1) })
        .safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({
          error: "RUN_REPLACEMENT_INVALID",
          message: "recoveryCaseId is required",
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const projectId = body["projectId"];
      if (typeof projectId === "string" && denyProjectAccess(request, reply, projectId)) {
        return reply;
      }
      try {
        const principalId = principalOf(request);
        const result = await service.replaceRecoveryRun({
          recoveryCaseId: params.data.recoveryCaseId,
          body: request.body,
          ...(principalId !== undefined ? { principalId } : {}),
        });
        return reply
          .code(result.outcome === "REPLACED" ? 201 : 200)
          .send(result);
      } catch (error) {
        return sendRecoveryError(reply, error);
      }
    },
  );

  // OBJECTIVE REISSUE != PLAN REVISION. Mints the next objective version and a
  // replacement run through Phase 2; carries no plan, approval, or authority.
  app.post(
    "/v1/revenue-recovery/cases/:recoveryCaseId/objective-reissue",
    async (request, reply) => {
      const params = z
        .object({ recoveryCaseId: z.string().min(1) })
        .safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({
          error: "OBJECTIVE_REISSUE_INVALID",
          message: "recoveryCaseId is required",
        });
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const projectId = body["projectId"];
      if (typeof projectId === "string" && denyProjectAccess(request, reply, projectId)) {
        return reply;
      }
      try {
        const principalId = principalOf(request);
        const result = await service.reissueRecoveryObjective({
          recoveryCaseId: params.data.recoveryCaseId,
          body: request.body,
          ...(principalId !== undefined ? { principalId } : {}),
        });
        return reply
          .code(result.outcome === "REISSUED" ? 201 : 200)
          .send(result);
      } catch (error) {
        return sendRecoveryError(reply, error);
      }
    },
  );

  // TEMPLATE PROVISIONED != OUTREACH AUTHORIZED. Creates one immutable version;
  // never sends, never approves, never touches consent or provider mode.
  app.post("/v1/revenue-recovery/templates", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const projectId = body["projectId"];
    if (typeof projectId === "string" && denyProjectAccess(request, reply, projectId)) {
      return reply;
    }
    try {
      const principalId = principalOf(request);
      const result = await service.provisionTemplate(
        request.body,
        principalId !== undefined ? { principalId } : {},
      );
      return reply
        .code(result.outcome === "CREATED" ? 201 : 200)
        .send(result);
    } catch (error) {
      return sendRecoveryError(reply, error);
    }
  });

  app.get("/v1/revenue-recovery/templates", async (request, reply) => {
    const query = TemplateScopeQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: "INVALID_TEMPLATE_QUERY",
        message: "customerAccountId and projectId are required; channel must be SMS or EMAIL",
      });
    }
    if (denyProjectAccess(request, reply, query.data.projectId)) {
      return reply;
    }
    const { customerAccountId, projectId, channel } = query.data;
    const templates = await service.listTemplates({
      customerAccountId,
      projectId,
      ...(channel ? { channel } : {}),
    });
    return reply.send({
      customerAccountId,
      projectId,
      channel: channel ?? null,
      templates,
    });
  });

  app.get(
    "/v1/revenue-recovery/templates/:templateId/versions/:version",
    async (request, reply) => {
      const params = TemplateVersionParamsSchema.safeParse(request.params);
      const query = TemplateScopeQuerySchema.omit({ channel: true }).safeParse(
        request.query,
      );
      if (!params.success || !query.success) {
        return reply.code(400).send({
          error: "INVALID_TEMPLATE_QUERY",
          message:
            "templateId, positive integer version, customerAccountId, and projectId are required",
        });
      }
      if (denyProjectAccess(request, reply, query.data.projectId)) {
        return reply;
      }
      try {
        const template = await service.getTemplate({
          ...params.data,
          ...query.data,
        });
        return reply.send({ template });
      } catch (error) {
        return sendRecoveryError(reply, error);
      }
    },
  );

  // No outreach route exists by design. Recovery sends are reachable only
  // through Phase6 authorization → Phase7 execution → SafeActuator →
  // RevenueRecoveryPhase7Actuator.
}
