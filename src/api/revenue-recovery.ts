import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  isRevenueRecoveryError,
  LeadIngestSchema,
  LeadEventIngestSchema,
  RecoveryConfigurationInputSchema,
  type RevenueRecoveryService,
} from "../revenue-recovery/index.js";

function httpStatus(code: string): number {
  switch (code) {
    case "LEAD_NOT_FOUND":
    case "RECOVERY_CASE_NOT_FOUND":
    case "TEMPLATE_NOT_FOUND":
    case "RECOVERY_CONFIG_MISSING":
      return 404;
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

export function registerRevenueRecoveryRoutes(
  app: FastifyInstance,
  deps: { revenueRecovery: RevenueRecoveryService },
): void {
  const service = deps.revenueRecovery;

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

  // No outreach route exists by design. Recovery sends are reachable only
  // through Phase6 authorization → Phase7 execution → SafeActuator →
  // RevenueRecoveryPhase7Actuator.
}
