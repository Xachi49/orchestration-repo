import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  isRevenueRecoveryError,
  type RevenueRecoveryService,
} from "../revenue-recovery/index.js";
import { verifyResendWebhookSignature } from "../revenue-recovery/resend-provider.js";
import type { RecoveryPilotConfig } from "../revenue-recovery/pilot-config.js";
import { WebFormLeadPayloadSchema } from "../revenue-recovery/web-lead-source.js";

function httpStatus(code: string): number {
  switch (code) {
    case "WEB_INGEST_UNAUTHORIZED":
    case "RESEND_WEBHOOK_UNAUTHORIZED":
      return 401;
    case "WEB_INGEST_NOT_CONFIGURED":
    case "PROVIDER_CONFIG_INVALID":
      return 503;
    case "LEAD_SOURCE_CONFLICT":
      return 409;
    case "LIVE_PILOT_TENANT_DENIED":
    case "LIVE_PILOT_RECIPIENT_DENIED":
      return 403;
    default:
      return 400;
  }
}

/**
 * Integration routes:
 * - Web form: Bearer / X-RR-Web-Ingest-Token against RECOVERY_WEB_INGEST_SECRET
 *   (server/edge → RR only; never from browser)
 * - Resend: Svix HMAC over raw body (preParsing captures bytes)
 */
export function registerRevenueRecoveryIntegrationRoutes(
  app: FastifyInstance,
  deps: {
    revenueRecovery: RevenueRecoveryService;
    pilotConfig: RecoveryPilotConfig;
  },
): void {
  const service = deps.revenueRecovery;

  app.addHook("preParsing", async (request, _reply, payload) => {
    if (!request.url.includes("/v1/integrations/resend/webhook")) {
      return payload;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks);
    (request as { rawBody?: Buffer }).rawBody = raw;
    return Readable.from(raw);
  });

  app.post(
    "/v1/integrations/web/revenue-recovery/leads",
    async (request, reply) => {
      try {
        // Strict bounded payload only — no customerAccountId/projectId authority
        // from the website. Tenant binds from trusted pilot server config.
        const payload = WebFormLeadPayloadSchema.parse(request.body);
        const auth =
          typeof request.headers.authorization === "string"
            ? request.headers.authorization
            : undefined;
        const tokenHeader = request.headers["x-rr-web-ingest-token"];
        const token =
          typeof tokenHeader === "string" ? tokenHeader : undefined;
        const result = await service.ingestWebLead({
          authorizationHeader: auth,
          tokenHeader: token,
          payload,
        });
        return reply.code(result.created ? 201 : 200).send({
          leadId: result.lead.leadId,
          created: result.created,
          source: result.lead.source,
          externalLeadId: result.lead.externalLeadId,
        });
      } catch (error) {
        if (isRevenueRecoveryError(error)) {
          return reply.code(httpStatus(error.code)).send({
            error: error.code,
            message: error.message,
          });
        }
        // Zod / parse errors → 400
        if (error && typeof error === "object" && "issues" in error) {
          return reply.code(400).send({
            error: "WEB_INGEST_INVALID_PAYLOAD",
            message: "Web lead payload failed schema validation",
          });
        }
        throw error;
      }
    },
  );

  app.post("/v1/integrations/resend/webhook", async (request, reply) => {
    const secret = deps.pilotConfig.resendWebhookSecret;
    if (!secret) {
      return reply.code(503).send({
        error: "RESEND_WEBHOOK_NOT_CONFIGURED",
        message: "Resend webhook secret is not configured",
      });
    }
    const rawBody = (request as { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      return reply.code(400).send({
        error: "RESEND_WEBHOOK_INVALID",
        message: "Raw body required for signature verification",
      });
    }
    const svixId = String(request.headers["svix-id"] ?? "");
    const svixTimestamp = String(request.headers["svix-timestamp"] ?? "");
    const svixSignature = String(request.headers["svix-signature"] ?? "");
    const ok = verifyResendWebhookSignature({
      rawBody,
      svixId,
      svixTimestamp,
      svixSignature,
      secret,
    });
    if (!ok) {
      return reply.code(401).send({
        error: "RESEND_WEBHOOK_UNAUTHORIZED",
        message: "Invalid Resend webhook signature",
      });
    }

    try {
      const envelope = z
        .object({
          type: z.string().min(1),
          data: z
            .object({
              email_id: z.string().optional(),
              created_at: z.string().optional(),
            })
            .passthrough(),
        })
        .passthrough()
        .parse(request.body);

      const providerEventKey = svixId || `${envelope.type}:${Date.now()}`;
      const result = await service.applyResendWebhookEvent({
        providerEventKey,
        eventKind: envelope.type,
        ...(envelope.data.email_id
          ? { providerMessageId: envelope.data.email_id }
          : {}),
        ...(envelope.data.created_at
          ? { occurredAt: envelope.data.created_at }
          : {}),
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
  });
}
