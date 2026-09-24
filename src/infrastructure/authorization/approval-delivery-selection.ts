/**
 * Approval delivery provider selection.
 *
 * PRODUCTION != FAKE DELIVERY
 * FAKE DELIVERY != PRODUCTION DELIVERY
 * DELIVERY != AUTHORIZATION
 * EMAIL RECEIVED != APPROVED
 *
 * Provider is never inferred from RESEND_API_KEY presence.
 * OpenAI/Resend failures must never fall back to Fake.
 */
import { z } from "zod";
import type { ApprovalDeliveryService } from "../../authorization/delivery.js";
import { FakeApprovalDeliveryService } from "../../authorization/delivery.js";
import {
  ResendApprovalDeliveryService,
  type ApprovalResendTransport,
} from "./resend-approval-delivery.js";

export const APPROVAL_DELIVERY_PROVIDER_LABELS = ["RESEND", "FAKE"] as const;
export type ApprovalDeliveryProviderLabel =
  (typeof APPROVAL_DELIVERY_PROVIDER_LABELS)[number];

export class ApprovalDeliverySelectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ApprovalDeliverySelectionError";
    this.code = code;
  }
}

export function isApprovalDeliverySelectionError(
  error: unknown,
): error is ApprovalDeliverySelectionError {
  return error instanceof ApprovalDeliverySelectionError;
}

export interface ApprovalDeliverySelection {
  delivery: ApprovalDeliveryService;
  approvalDeliveryProvider: ApprovalDeliveryProviderLabel;
  approvalDeliveryConfigured: true;
}

export interface SelectApprovalDeliveryInput {
  runtimeEnvironment: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit delivery override (tests). PRODUCTION forbids Fake.
   */
  approvalDelivery?: ApprovalDeliveryService;
  /** Test seam — Resend HTTP transport. */
  resendTransport?: ApprovalResendTransport;
}

function rawProviderFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER"]?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  return raw.toLowerCase();
}

function requireEmail(
  env: NodeJS.ProcessEnv,
  name: string,
  forProduction: boolean,
): string {
  const raw = env[name]?.trim();
  if (!raw) {
    throw new ApprovalDeliverySelectionError(
      forProduction
        ? `PRODUCTION_${name}_REQUIRED`
        : `${name}_REQUIRED`,
      `${name} is required for Resend approval delivery`,
    );
  }
  const parsed = z.string().email().safeParse(raw);
  if (!parsed.success) {
    throw new ApprovalDeliverySelectionError(
      forProduction
        ? `PRODUCTION_${name}_INVALID`
        : `${name}_INVALID`,
      `${name} must be a valid email address`,
    );
  }
  return parsed.data;
}

export function selectApprovalDelivery(
  input: SelectApprovalDeliveryInput,
): ApprovalDeliverySelection {
  const env = input.env ?? process.env;
  const isProduction = input.runtimeEnvironment === "PRODUCTION";

  if (input.approvalDelivery !== undefined) {
    if (
      isProduction &&
      input.approvalDelivery instanceof FakeApprovalDeliveryService
    ) {
      throw new ApprovalDeliverySelectionError(
        "PRODUCTION_FAKE_APPROVAL_DELIVERY_FORBIDDEN",
        "PRODUCTION != FAKE DELIVERY; injected FakeApprovalDeliveryService is forbidden",
      );
    }
    return selectionFromDelivery(input.approvalDelivery);
  }

  const raw = rawProviderFromEnv(env);

  if (isProduction) {
    if (raw === undefined) {
      throw new ApprovalDeliverySelectionError(
        "PRODUCTION_APPROVAL_DELIVERY_PROVIDER_REQUIRED",
        "PRODUCTION requires explicit ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER=resend; never inferred from RESEND_API_KEY",
      );
    }
    if (raw === "fake") {
      throw new ApprovalDeliverySelectionError(
        "PRODUCTION_FAKE_APPROVAL_DELIVERY_FORBIDDEN",
        "PRODUCTION != FAKE DELIVERY; ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER=fake is forbidden",
      );
    }
    if (raw !== "resend") {
      throw new ApprovalDeliverySelectionError(
        "PRODUCTION_APPROVAL_DELIVERY_PROVIDER_UNSUPPORTED",
        `PRODUCTION supports only ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER=resend, got ${raw}`,
      );
    }
    return constructResend(env, input.resendTransport, true);
  }

  if (raw === "resend") {
    return constructResend(env, input.resendTransport, false);
  }
  if (raw !== undefined && raw !== "fake") {
    throw new ApprovalDeliverySelectionError(
      "APPROVAL_DELIVERY_PROVIDER_UNSUPPORTED",
      `ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER must be resend or fake (non-production), got ${raw}`,
    );
  }

  return selectionFromDelivery(new FakeApprovalDeliveryService());
}

function constructResend(
  env: NodeJS.ProcessEnv,
  transport: ApprovalResendTransport | undefined,
  forProduction: boolean,
): ApprovalDeliverySelection {
  const apiKey = env["RESEND_API_KEY"]?.trim();
  if (!apiKey) {
    throw new ApprovalDeliverySelectionError(
      forProduction
        ? "PRODUCTION_RESEND_API_KEY_REQUIRED"
        : "RESEND_API_KEY_REQUIRED",
      "ORCHESTRATOR_APPROVAL_DELIVERY_PROVIDER=resend requires RESEND_API_KEY; never fall back to Fake",
    );
  }
  const from = requireEmail(env, "APPROVAL_DELIVERY_EMAIL_FROM", forProduction);
  const to = requireEmail(env, "APPROVAL_DELIVERY_EMAIL_TO", forProduction);
  const delivery = new ResendApprovalDeliveryService({
    apiKey,
    from,
    to,
    ...(transport !== undefined ? { transport } : {}),
  });
  return {
    delivery,
    approvalDeliveryProvider: "RESEND",
    approvalDeliveryConfigured: true,
  };
}

function selectionFromDelivery(
  delivery: ApprovalDeliveryService,
): ApprovalDeliverySelection {
  if (delivery instanceof FakeApprovalDeliveryService) {
    return {
      delivery,
      approvalDeliveryProvider: "FAKE",
      approvalDeliveryConfigured: true,
    };
  }
  if (delivery instanceof ResendApprovalDeliveryService) {
    return {
      delivery,
      approvalDeliveryProvider: "RESEND",
      approvalDeliveryConfigured: true,
    };
  }
  throw new ApprovalDeliverySelectionError(
    "APPROVAL_DELIVERY_PROVIDER_UNSUPPORTED",
    "Unsupported ApprovalDeliveryService implementation",
  );
}
