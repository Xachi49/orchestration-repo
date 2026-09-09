import { createHash } from "node:crypto";
import { z } from "zod";
import { CONTROL_CATALOG_VERSION } from "./doctrine.js";
import { listRequiredControlIds } from "./control.js";
import { AssuranceError } from "./errors.js";

export const AssuranceProfileSchema = z
  .object({
    profileId: z.string().min(1),
    profileVersion: z.number().int().positive(),
    profileHash: z.string().min(1),
    title: z.string().min(1),
    controlCatalogVersion: z.string().min(1),
    requiredControlIds: z.array(z.string().min(1)).min(1),
    challengePackIds: z.array(z.string().min(1)).min(1),
    evidenceFreshnessSeconds: z.number().int().positive(),
    allowedEnvironments: z.array(z.enum(["TEST", "STAGING", "PRODUCTION"])).min(1),
    certificationValiditySeconds: z.number().int().positive(),
    requireReplay: z.boolean(),
    requireFaultInjection: z.boolean(),
    requireConcurrencyProbe: z.boolean(),
    requireRestartProof: z.boolean(),
    requireIndependentCertifier: z.boolean(),
    status: z.enum(["DRAFT", "ACTIVE", "SUPERSEDED"]),
    createdAt: z.string().datetime(),
  })
  .strict();

export type AssuranceProfile = z.infer<typeof AssuranceProfileSchema>;

export function computeProfileHash(
  input: Omit<AssuranceProfile, "profileHash">,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        profileId: input.profileId,
        profileVersion: input.profileVersion,
        title: input.title,
        controlCatalogVersion: input.controlCatalogVersion,
        requiredControlIds: [...input.requiredControlIds].sort(),
        challengePackIds: [...input.challengePackIds].sort(),
        evidenceFreshnessSeconds: input.evidenceFreshnessSeconds,
        allowedEnvironments: [...input.allowedEnvironments].sort(),
        certificationValiditySeconds: input.certificationValiditySeconds,
        requireReplay: input.requireReplay,
        requireFaultInjection: input.requireFaultInjection,
        requireConcurrencyProbe: input.requireConcurrencyProbe,
        requireRestartProof: input.requireRestartProof,
        requireIndependentCertifier: input.requireIndependentCertifier,
        status: input.status,
        createdAt: input.createdAt,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withProfileHash(
  input: Omit<AssuranceProfile, "profileHash">,
): AssuranceProfile {
  return AssuranceProfileSchema.parse({
    ...input,
    profileHash: computeProfileHash(input),
  });
}

export function mintCoreSystemQualificationProfile(createdAt: string): AssuranceProfile {
  const required = listRequiredControlIds(false);
  return withProfileHash({
    profileId: "CORE_SYSTEM_QUALIFICATION",
    profileVersion: 1,
    title: "Core system qualification through Phase 22",
    controlCatalogVersion: CONTROL_CATALOG_VERSION,
    requiredControlIds: [...required],
    challengePackIds: [
      "PACK_STATIC_CONFORMANCE",
      "PACK_DYNAMIC_ACCEPTANCE",
      "PACK_SECURITY_BOUNDARY",
      "PACK_MIGRATION_COMPATIBILITY",
      "PACK_REPLAY",
      "PACK_FAILPOINT",
    ],
    evidenceFreshnessSeconds: 86_400 * 30,
    allowedEnvironments: ["TEST", "STAGING"],
    certificationValiditySeconds: 86_400 * 90,
    requireReplay: true,
    requireFaultInjection: true,
    requireConcurrencyProbe: true,
    requireRestartProof: true,
    requireIndependentCertifier: true,
    status: "ACTIVE",
    createdAt,
  });
}

export function assertProfileActive(profile: AssuranceProfile): void {
  if (profile.status !== "ACTIVE") {
    throw new AssuranceError(
      "ASSURANCE_PROFILE_INVALID",
      `Profile ${profile.profileId}@${profile.profileVersion} is ${profile.status}`,
    );
  }
}
