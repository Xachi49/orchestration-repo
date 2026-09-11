import { createHash } from "node:crypto";
import { z } from "zod";
import { REFERENCE_RUNTIME_MANIFEST_VERSION } from "./doctrine.js";
import { QualificationError } from "./errors.js";

export const REFERENCE_RUNTIME_COMPONENTS = [
  "FASTIFY_API",
  "POSTGRES_PERSISTENCE",
  "MIGRATION_COMPATIBILITY_CHECKER",
  "ADMISSION_SERVICE",
  "REPOSITORY_INGESTION",
  "PLANNER",
  "VALIDATOR",
  "AUTHORIZATION",
  "EXECUTOR",
  "VERIFIER",
  "MEMORY",
  "OBSERVABILITY",
  "SCHEDULER",
  "PROGRAM_ORCHESTRATION",
  "PORTFOLIO_ORCHESTRATION",
  "GOVERNANCE",
  "CONSTITUTIONAL_GOVERNANCE",
  "FEDERATION",
  "ASSURANCE",
  "QUALIFICATION",
  "REQUIRED_WORKERS",
  "ARTIFACT_PERSISTENCE",
  "OUTBOX_INBOX_RECOVERY",
  "LEASE_RECOVERY_COORDINATORS",
] as const;

export type ReferenceRuntimeComponent =
  (typeof REFERENCE_RUNTIME_COMPONENTS)[number];

export const CRITICAL_REFERENCE_RUNTIME_COMPONENTS: readonly ReferenceRuntimeComponent[] =
  [
    "FASTIFY_API",
    "POSTGRES_PERSISTENCE",
    "MIGRATION_COMPATIBILITY_CHECKER",
    "ADMISSION_SERVICE",
    "PLANNER",
    "VALIDATOR",
    "AUTHORIZATION",
    "EXECUTOR",
    "VERIFIER",
    "SCHEDULER",
    "GOVERNANCE",
    "ASSURANCE",
    "QUALIFICATION",
    "REQUIRED_WORKERS",
  ];

export const ReferenceRuntimeComponentEntrySchema = z
  .object({
    componentId: z.enum(REFERENCE_RUNTIME_COMPONENTS),
    present: z.boolean(),
    storageClass: z.enum(["POSTGRES", "MEMORY", "NONE"]).optional(),
  })
  .strict();

export type ReferenceRuntimeComponentEntry = z.infer<
  typeof ReferenceRuntimeComponentEntrySchema
>;

export const ReferenceRuntimeManifestSchema = z
  .object({
    manifestVersion: z.literal(REFERENCE_RUNTIME_MANIFEST_VERSION),
    environmentClass: z.enum(["TEST", "STAGING", "PRODUCTION"]),
    components: z.array(ReferenceRuntimeComponentEntrySchema).min(1),
    faultInjectionAllowed: z.literal(false),
    authoritySeedingOnStartup: z.literal(false),
    manifestHash: z.string().min(1),
  })
  .strict();

export type ReferenceRuntimeManifest = z.infer<
  typeof ReferenceRuntimeManifestSchema
>;

export function computeReferenceRuntimeManifestHash(input: {
  manifestVersion: string;
  environmentClass: string;
  components: readonly ReferenceRuntimeComponentEntry[];
  faultInjectionAllowed: boolean;
  authoritySeedingOnStartup: boolean;
}): string {
  const components = [...input.components]
    .map((c) => ({
      componentId: c.componentId,
      present: c.present,
      ...(c.storageClass !== undefined ? { storageClass: c.storageClass } : {}),
    }))
    .sort((a, b) => a.componentId.localeCompare(b.componentId));
  return createHash("sha256")
    .update(
      JSON.stringify({
        manifestVersion: input.manifestVersion,
        environmentClass: input.environmentClass,
        components,
        faultInjectionAllowed: input.faultInjectionAllowed,
        authoritySeedingOnStartup: input.authoritySeedingOnStartup,
      }),
      "utf8",
    )
    .digest("hex");
}

export function withReferenceRuntimeManifestHash(
  input: Omit<ReferenceRuntimeManifest, "manifestHash">,
): ReferenceRuntimeManifest {
  return ReferenceRuntimeManifestSchema.parse({
    ...input,
    components: [...input.components].sort((a, b) =>
      a.componentId.localeCompare(b.componentId),
    ),
    manifestHash: computeReferenceRuntimeManifestHash(input),
  });
}

export function mintProductionReferenceRuntimeManifest(
  environmentClass: "TEST" | "STAGING" | "PRODUCTION" = "PRODUCTION",
): ReferenceRuntimeManifest {
  const components: ReferenceRuntimeComponentEntry[] =
    REFERENCE_RUNTIME_COMPONENTS.map((componentId) => ({
      componentId,
      present: true,
      ...(componentId === "POSTGRES_PERSISTENCE"
        ? { storageClass: "POSTGRES" as const }
        : {}),
    }));
  return withReferenceRuntimeManifestHash({
    manifestVersion: REFERENCE_RUNTIME_MANIFEST_VERSION,
    environmentClass,
    components,
    faultInjectionAllowed: false,
    authoritySeedingOnStartup: false,
  });
}

export function assertReferenceRuntimeProductionEligible(
  manifest: ReferenceRuntimeManifest,
): void {
  if (manifest.faultInjectionAllowed) {
    throw new QualificationError(
      "REFERENCE_RUNTIME_INVALID",
      "Production reference runtime cannot allow fault injection",
    );
  }
  if (manifest.authoritySeedingOnStartup) {
    throw new QualificationError(
      "REFERENCE_RUNTIME_INVALID",
      "Production reference runtime cannot seed authority on startup",
    );
  }
  for (const required of CRITICAL_REFERENCE_RUNTIME_COMPONENTS) {
    const entry = manifest.components.find((c) => c.componentId === required);
    if (!entry?.present) {
      throw new QualificationError(
        "REFERENCE_RUNTIME_INVALID",
        `Missing critical reference-runtime component: ${required}`,
        { componentId: required },
      );
    }
  }
  const storage = manifest.components.find(
    (c) => c.componentId === "POSTGRES_PERSISTENCE",
  );
  if (storage?.storageClass !== "POSTGRES") {
    throw new QualificationError(
      "REFERENCE_RUNTIME_INVALID",
      "Production reference runtime requires PostgreSQL authoritative storage",
    );
  }
  const recomputed = computeReferenceRuntimeManifestHash(manifest);
  if (recomputed !== manifest.manifestHash) {
    throw new QualificationError(
      "REFERENCE_RUNTIME_DRIFT",
      "Reference runtime manifest hash mismatch",
    );
  }
}

export function computeReferenceRuntimeFingerprint(
  manifest: ReferenceRuntimeManifest,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        manifestHash: manifest.manifestHash,
        environmentClass: manifest.environmentClass,
        faultInjectionAllowed: manifest.faultInjectionAllowed,
        authoritySeedingOnStartup: manifest.authoritySeedingOnStartup,
      }),
      "utf8",
    )
    .digest("hex");
}
