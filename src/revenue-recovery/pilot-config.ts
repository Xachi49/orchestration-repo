import { z } from "zod";

/**
 * LIVE PILOT LAW: REAL PROVIDER != BYPASS OF GOVERNANCE.
 * Mode is never inferred from API key presence.
 */
export const RECOVERY_PROVIDER_MODES = ["FAKE", "SHADOW", "LIVE_EMAIL"] as const;
export type RecoveryProviderMode = (typeof RECOVERY_PROVIDER_MODES)[number];

export const RecoveryPilotConfigSchema = z
  .object({
    mode: z.enum(RECOVERY_PROVIDER_MODES),
    resendApiKey: z.string().min(1).optional(),
    resendWebhookSecret: z.string().min(1).optional(),
    recoveryEmailFrom: z.string().email().optional(),
    recoveryEmailReplyTo: z.string().email().optional(),
    livePilotCustomerAccountId: z.string().min(1).optional(),
    livePilotProjectId: z.string().min(1).optional(),
    /** Server-only web form ingest secret — never browser/CT exposed. */
    webIngestSecret: z.string().min(1).optional(),
    /** Bound pilot recipient for live smoke only — never a general customer list. */
    livePilotRecipientAllowlist: z.array(z.string().email()).default([]),
  })
  .strict();

export type RecoveryPilotConfig = z.infer<typeof RecoveryPilotConfigSchema>;

function env(map: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = map[name];
  return value && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Load pilot config from server env. Never log secret values.
 * PRODUCTION fails closed when LIVE_EMAIL lacks required fields.
 */
export function loadRecoveryPilotConfig(
  map: NodeJS.ProcessEnv = process.env,
): RecoveryPilotConfig {
  const runtimeEnvironment =
    env(map, "ORCHESTRATOR_ENV") ?? "DEVELOPMENT";
  const modeRaw = env(map, "RECOVERY_PROVIDER_MODE");
  if (!modeRaw) {
    if (runtimeEnvironment === "PRODUCTION") {
      throw new Error("PRODUCTION requires RECOVERY_PROVIDER_MODE");
    }
  }
  const modeResolved = modeRaw ?? "FAKE";
  if (!RECOVERY_PROVIDER_MODES.includes(modeResolved as RecoveryProviderMode)) {
    throw new Error(
      `RECOVERY_PROVIDER_MODE must be one of ${RECOVERY_PROVIDER_MODES.join(", ")}`,
    );
  }
  const mode = modeResolved as RecoveryProviderMode;
  const allowlistRaw = env(map, "RECOVERY_LIVE_PILOT_RECIPIENT_ALLOWLIST");
  const livePilotRecipientAllowlist = allowlistRaw
    ? allowlistRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];

  const config = RecoveryPilotConfigSchema.parse({
    mode,
    ...(env(map, "RESEND_API_KEY")
      ? { resendApiKey: env(map, "RESEND_API_KEY") }
      : {}),
    ...(env(map, "RESEND_WEBHOOK_SECRET")
      ? { resendWebhookSecret: env(map, "RESEND_WEBHOOK_SECRET") }
      : {}),
    ...(env(map, "RECOVERY_EMAIL_FROM")
      ? { recoveryEmailFrom: env(map, "RECOVERY_EMAIL_FROM") }
      : {}),
    ...(env(map, "RECOVERY_EMAIL_REPLY_TO")
      ? { recoveryEmailReplyTo: env(map, "RECOVERY_EMAIL_REPLY_TO") }
      : {}),
    ...(env(map, "RECOVERY_LIVE_PILOT_CUSTOMER_ACCOUNT_ID")
      ? {
          livePilotCustomerAccountId: env(
            map,
            "RECOVERY_LIVE_PILOT_CUSTOMER_ACCOUNT_ID",
          ),
        }
      : {}),
    ...(env(map, "RECOVERY_LIVE_PILOT_PROJECT_ID")
      ? { livePilotProjectId: env(map, "RECOVERY_LIVE_PILOT_PROJECT_ID") }
      : {}),
    ...(env(map, "RECOVERY_WEB_INGEST_SECRET")
      ? { webIngestSecret: env(map, "RECOVERY_WEB_INGEST_SECRET") }
      : {}),
    livePilotRecipientAllowlist,
  });

  if (config.mode === "LIVE_EMAIL") {
    if (!config.resendApiKey) {
      throw new Error("LIVE_EMAIL requires RESEND_API_KEY");
    }
    if (!config.recoveryEmailFrom) {
      throw new Error("LIVE_EMAIL requires RECOVERY_EMAIL_FROM");
    }
    if (!config.livePilotCustomerAccountId || !config.livePilotProjectId) {
      throw new Error(
        "LIVE_EMAIL requires RECOVERY_LIVE_PILOT_CUSTOMER_ACCOUNT_ID and RECOVERY_LIVE_PILOT_PROJECT_ID",
      );
    }
  }

  if (config.mode === "SHADOW" && !config.recoveryEmailFrom) {
    // Shadow builds the request; from-address still required for containment.
    throw new Error("SHADOW requires RECOVERY_EMAIL_FROM");
  }

  return config;
}

/** Public, secret-free health snapshot for Control Tower. */
export function recoveryPilotHealth(config: RecoveryPilotConfig): {
  mode: RecoveryProviderMode;
  webIngestConfigured: boolean;
  resendConfigured: boolean;
  livePilotTenantBound: boolean;
} {
  return {
    mode: config.mode,
    webIngestConfigured: Boolean(config.webIngestSecret),
    resendConfigured: Boolean(
      config.resendApiKey && config.recoveryEmailFrom,
    ),
    livePilotTenantBound: Boolean(
      config.livePilotCustomerAccountId && config.livePilotProjectId,
    ),
  };
}

export function isLivePilotTenant(
  config: RecoveryPilotConfig,
  input: { customerAccountId: string; projectId: string },
): boolean {
  return (
    config.livePilotCustomerAccountId === input.customerAccountId &&
    config.livePilotProjectId === input.projectId
  );
}
