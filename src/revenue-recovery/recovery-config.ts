import { z } from "zod";
import { RECOVERY_SAFETY_CEILINGS } from "./doctrine.js";
import { RevenueRecoveryError } from "./errors.js";
import { hashCanonical } from "./hash.js";

export const RECOVERY_CHANNELS = ["SMS", "EMAIL", "CALL_TASK"] as const;
export type RecoveryChannel = (typeof RECOVERY_CHANNELS)[number];

const ContactWindowSchema = z
  .object({
    /** Inclusive start hour 0–23 in customer timezone. */
    startHourLocal: z.number().int().min(0).max(23),
    /** Exclusive end hour 1–24 in customer timezone. */
    endHourLocal: z.number().int().min(1).max(24),
    daysOfWeek: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7),
  })
  .strict()
  .refine((w) => w.startHourLocal < w.endHourLocal, {
    message: "contactWindow startHourLocal must be < endHourLocal",
  });

export const RecoveryConfigurationInputSchema = z
  .object({
    customerAccountId: z.string().min(1).max(128),
    projectId: z.string().min(1).max(128),
    responseGapThresholdMinutes: z
      .number()
      .int()
      .positive()
      .max(RECOVERY_SAFETY_CEILINGS.maxResponseGapThresholdMinutes),
    allowedChannels: z.array(z.enum(RECOVERY_CHANNELS)).min(1),
    contactWindow: ContactWindowSchema,
    timezone: z.string().min(1).max(64),
    maxSmsAttempts: z
      .number()
      .int()
      .positive()
      .max(RECOVERY_SAFETY_CEILINGS.maxSmsAttempts),
    maxEmailAttempts: z
      .number()
      .int()
      .positive()
      .max(RECOVERY_SAFETY_CEILINGS.maxEmailAttempts),
    maxCallTasks: z
      .number()
      .int()
      .positive()
      .max(RECOVERY_SAFETY_CEILINGS.maxCallTasks),
    cooldownMinutes: z
      .number()
      .int()
      .nonnegative()
      .max(RECOVERY_SAFETY_CEILINGS.maxCooldownMinutes),
    maximumRecoveryAgeDays: z
      .number()
      .int()
      .positive()
      .max(RECOVERY_SAFETY_CEILINGS.maxRecoveryAgeDays),
    attributionWindowDays: z
      .number()
      .int()
      .positive()
      .max(RECOVERY_SAFETY_CEILINGS.maxAttributionWindowDays),
    currency: z.string().length(3),
    businessName: z.string().min(1).max(200),
    bookingLink: z.string().url().max(500).optional(),
    enabled: z.boolean().default(true),
  })
  .strict();

export type RecoveryConfigurationInput = z.infer<
  typeof RecoveryConfigurationInputSchema
>;

export const RecoveryConfigurationSchema =
  RecoveryConfigurationInputSchema.extend({
    configId: z.string().min(1),
    configVersion: z.number().int().positive(),
    configFingerprint: z.string().min(1),
    createdAt: z.string().datetime(),
  }).strict();

export type RecoveryConfiguration = z.infer<typeof RecoveryConfigurationSchema>;

export function parseRecoveryConfiguration(
  input: unknown,
): RecoveryConfiguration {
  return RecoveryConfigurationSchema.parse(input);
}

export function parseRecoveryConfigurationInput(
  input: unknown,
): RecoveryConfigurationInput {
  return RecoveryConfigurationInputSchema.parse(input);
}

export function assertValidTimezone(timezone: string): void {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
  } catch {
    throw new RevenueRecoveryError(
      "RECOVERY_CONFIG_INVALID",
      `Invalid IANA timezone: ${timezone}`,
    );
  }
}

export function recoveryConfigFingerprint(
  input: RecoveryConfigurationInput,
): string {
  return hashCanonical(input);
}

export function newRecoveryConfigId(input: {
  customerAccountId: string;
  projectId: string;
  configVersion: number;
}): string {
  return `rcfg_${hashCanonical(input).slice(0, 24)}`;
}

/** Local hour + weekday in customer timezone (fail closed on invalid TZ). */
export function localTimeParts(
  isoUtc: string,
  timezone: string,
): { hour: number; dayOfWeek: number } {
  assertValidTimezone(timezone);
  const date = new Date(isoUtc);
  if (Number.isNaN(date.getTime())) {
    throw new RevenueRecoveryError(
      "RECOVERY_CONFIG_INVALID",
      "Invalid timestamp for contact window evaluation",
    );
  }
  const hourFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const dayFmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
  });
  const hour = Number(hourFmt.format(date));
  const weekday = dayFmt.format(date);
  const dayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };
  const dayOfWeek = dayMap[weekday];
  if (dayOfWeek === undefined || !Number.isFinite(hour)) {
    throw new RevenueRecoveryError(
      "RECOVERY_CONFIG_INVALID",
      "Failed to resolve local contact window",
    );
  }
  // Intl may return 24 for midnight in some environments
  const normalizedHour = hour === 24 ? 0 : hour;
  return { hour: normalizedHour, dayOfWeek };
}

export function isWithinContactWindow(
  isoUtc: string,
  config: Pick<RecoveryConfiguration, "contactWindow" | "timezone">,
): boolean {
  const { hour, dayOfWeek } = localTimeParts(isoUtc, config.timezone);
  const w = config.contactWindow;
  if (!w.daysOfWeek.includes(dayOfWeek)) return false;
  return hour >= w.startHourLocal && hour < w.endHourLocal;
}
