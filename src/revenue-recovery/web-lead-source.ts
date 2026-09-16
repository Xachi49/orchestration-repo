import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  LeadIngestSchema,
  type LeadIngestInput,
  type LeadSource,
} from "./lead.js";
import { RevenueRecoveryError } from "./errors.js";

/**
 * Authenticated website form → LeadIngestRequest adapter.
 *
 * Host/provider neutral: the upstream may be Vercel, Netlify, Cloudflare,
 * custom Node, a future Wix Velo adapter, or another landing-page system.
 * Revenue Recovery does not couple to any particular website host.
 *
 * Auth model (pilot v1):
 * Server verifies `Authorization: Bearer <RECOVERY_WEB_INGEST_SECRET>` or
 * `X-RR-Web-Ingest-Token: <RECOVERY_WEB_INGEST_SECRET>` against the configured
 * secret using constant-time comparison. `source = "WEB_FORM"` alone confers
 * zero trust.
 *
 * CRITICAL: RECOVERY_WEB_INGEST_SECRET must NEVER be embedded in browser JS,
 * HTML, frontend env, Control Tower, or public form configuration.
 * Intended flow: browser form → website-owned server/edge handler → this ingress.
 */
export const WebFormLeadPayloadSchema = z
  .object({
    submissionId: z.string().min(1).max(256),
    formId: z.string().max(256).optional(),
    submittedAt: z.string().datetime(),
    firstName: z.string().max(100).optional(),
    lastName: z.string().max(100).optional(),
    email: z.string().email().max(254).optional(),
    phone: z.string().max(32).optional(),
    serviceRequested: z.string().max(500).optional(),
    serviceArea: z.string().max(200).optional(),
    /** May become ESTIMATED only — never CONFIRMED_*. */
    estimatedValue: z.number().nonnegative().finite().optional(),
    currency: z.string().length(3).optional(),
    consent: z
      .object({
        email: z.boolean().optional(),
        sms: z.boolean().optional(),
        call: z.boolean().optional(),
        doNotContact: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type WebFormLeadPayload = z.infer<typeof WebFormLeadPayloadSchema>;

export const WEB_FORM_LEAD_SOURCE: LeadSource = "WEB_FORM";

function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Length mismatch — still run a dummy compare on equal-sized buffers.
    const dummy = Buffer.alloc(b.length);
    timingSafeEqual(dummy, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function verifyWebIngestAuthentication(input: {
  authorizationHeader?: string | undefined;
  tokenHeader?: string | undefined;
  configuredSecret: string | undefined;
}): void {
  if (!input.configuredSecret) {
    throw new RevenueRecoveryError(
      "WEB_INGEST_NOT_CONFIGURED",
      "Web ingest secret is not configured",
    );
  }
  const bearer = input.authorizationHeader?.startsWith("Bearer ")
    ? input.authorizationHeader.slice("Bearer ".length).trim()
    : undefined;
  const token = (input.tokenHeader ?? bearer)?.trim();
  if (!token || !secretsEqual(token, input.configuredSecret)) {
    throw new RevenueRecoveryError(
      "WEB_INGEST_UNAUTHORIZED",
      "Invalid web ingest authentication",
    );
  }
}

/**
 * Normalize a bounded web-form payload into LeadIngestInput.
 * Tenant/project must come from trusted server config — never from the payload.
 * Does not invent economic confirmation.
 */
export function webPayloadToLeadIngest(input: {
  payload: WebFormLeadPayload;
  customerAccountId: string;
  projectId: string;
}): LeadIngestInput {
  const p = input.payload;
  const consent = p.consent;
  return LeadIngestSchema.parse({
    customerAccountId: input.customerAccountId,
    projectId: input.projectId,
    externalLeadId: p.submissionId,
    source: WEB_FORM_LEAD_SOURCE,
    createdAt: p.submittedAt,
    ...(p.firstName !== undefined ? { firstName: p.firstName } : {}),
    ...(p.lastName !== undefined ? { lastName: p.lastName } : {}),
    ...(p.email !== undefined ? { email: p.email } : {}),
    ...(p.phone !== undefined ? { phone: p.phone } : {}),
    ...(p.serviceRequested !== undefined
      ? { serviceRequested: p.serviceRequested }
      : {}),
    ...(p.serviceArea !== undefined ? { serviceArea: p.serviceArea } : {}),
    ...(p.estimatedValue !== undefined
      ? { estimatedValue: p.estimatedValue }
      : {}),
    ...(p.currency !== undefined ? { currency: p.currency } : {}),
    consent: {
      ...(consent?.sms !== undefined ? { smsOptIn: consent.sms } : {}),
      ...(consent?.email !== undefined ? { emailOptIn: consent.email } : {}),
      ...(consent?.call !== undefined ? { callOptIn: consent.call } : {}),
      ...(consent?.doNotContact !== undefined
        ? { doNotContact: consent.doNotContact }
        : {}),
    },
    sourceMetadata: {
      ...(p.formId !== undefined ? { formId: p.formId } : {}),
      adapter: "AuthenticatedWebLeadSourceAdapter",
    },
  });
}

export class AuthenticatedWebLeadSourceAdapter {
  normalize(input: {
    payload: unknown;
    customerAccountId: string;
    projectId: string;
  }): LeadIngestInput {
    const payload = WebFormLeadPayloadSchema.parse(input.payload);
    return webPayloadToLeadIngest({
      payload,
      customerAccountId: input.customerAccountId,
      projectId: input.projectId,
    });
  }
}
