import { createHash } from "node:crypto";
import { z } from "zod";
import { QualificationError } from "./errors.js";

/**
 * Secret-free production configuration profile fingerprint.
 * Hashes presence/type/semantics — never secret contents.
 * Domain-local shape (does not import src/runtime).
 */
export const ProductionConfigProfileSchema = z
  .object({
    runtimeEnvironment: z.enum(["TEST", "DEVELOPMENT", "STAGING", "PRODUCTION"]),
    storageMode: z.string().min(1),
    runtimeRole: z.string().min(1),
    authenticationMode: z.string().min(1),
    workerConcurrencyClass: z.enum(["SINGLE", "BOUNDED", "HIGH"]),
    artifactBackendClass: z.enum(["LOCAL_FS", "NONE"]),
    repositoryBackendClass: z.enum(["GIT_LOCAL", "NONE"]),
    deliverySecretConfigured: z.boolean(),
    debugMode: z.boolean(),
    modelProviderEnabled: z.boolean(),
    faultInjectionDisabled: z.literal(true),
    externalActionMode: z.enum(["BOUNDED_SAFE_ACTUATOR", "DISABLED"]),
  })
  .strict();

export type ProductionConfigProfile = z.infer<
  typeof ProductionConfigProfileSchema
>;

/** Minimal config projection for fingerprinting — no runtime module import. */
export type ProductionConfigProjection = {
  runtimeEnvironment: "TEST" | "DEVELOPMENT" | "STAGING" | "PRODUCTION";
  storageMode: string;
  runtimeRole: string;
  authenticationMode: string;
  workerConcurrency: number;
  deliverySecretConfigured: boolean;
  debugMode: boolean;
  modelProviderEnabled: boolean;
};

export function workerConcurrencyClass(
  concurrency: number,
): "SINGLE" | "BOUNDED" | "HIGH" {
  if (concurrency <= 1) return "SINGLE";
  if (concurrency <= 16) return "BOUNDED";
  return "HIGH";
}

export function productionConfigProfileFromRuntimeConfig(
  config: ProductionConfigProjection,
): ProductionConfigProfile {
  return ProductionConfigProfileSchema.parse({
    runtimeEnvironment: config.runtimeEnvironment,
    storageMode: config.storageMode,
    runtimeRole: config.runtimeRole,
    authenticationMode: config.authenticationMode,
    workerConcurrencyClass: workerConcurrencyClass(config.workerConcurrency),
    artifactBackendClass: "LOCAL_FS",
    repositoryBackendClass: "GIT_LOCAL",
    deliverySecretConfigured: config.deliverySecretConfigured,
    debugMode: config.debugMode,
    modelProviderEnabled: config.modelProviderEnabled,
    faultInjectionDisabled: true,
    externalActionMode: "BOUNDED_SAFE_ACTUATOR",
  });
}

export function computeProductionConfigProfileFingerprint(
  profile: ProductionConfigProfile,
): string {
  const canonical = ProductionConfigProfileSchema.parse(profile);
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

export function assertProductionConfigEligible(
  profile: ProductionConfigProfile,
): void {
  if (profile.runtimeEnvironment === "PRODUCTION") {
    if (profile.storageMode !== "POSTGRES") {
      throw new QualificationError(
        "PRODUCTION_CONFIG_INVALID",
        "Production requires POSTGRES storage mode",
      );
    }
    if (profile.debugMode) {
      throw new QualificationError(
        "PRODUCTION_CONFIG_INVALID",
        "Production cannot enable debugMode",
      );
    }
    if (!profile.faultInjectionDisabled) {
      throw new QualificationError(
        "PRODUCTION_CONFIG_INVALID",
        "Production must disable fault injection",
      );
    }
    if (!profile.deliverySecretConfigured) {
      throw new QualificationError(
        "PRODUCTION_CONFIG_INVALID",
        "Production requires approval delivery secret configured (presence only)",
      );
    }
  }
}
