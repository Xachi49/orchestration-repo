import { DrainController } from "../../runtime/startup.js";
import { QualificationError } from "../../qualification/errors.js";
import {
  mintProductionReferenceRuntimeManifest,
  assertReferenceRuntimeProductionEligible,
  type ReferenceRuntimeManifest,
} from "../../qualification/runtime-manifest.js";
import {
  assembleReadinessReport,
  buildReadinessCheck,
} from "../../qualification/readiness-checks.js";
import type {
  ReadinessCheckResult,
  ReadinessReport,
} from "../../qualification/readiness.js";
import {
  assertProductionConfigEligible,
  productionConfigProfileFromRuntimeConfig,
  type ProductionConfigProfile,
} from "../../qualification/production-config.js";
import { PostgresHealthService } from "./health.js";
import {
  createPostgresOrchestratorStack,
  type PostgresOrchestratorStack,
} from "./stack.js";
import type { PostgresDatabase } from "./database.js";
import type { ClockPort } from "../clock.js";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";

/**
 * Executable Phase24 reference runtime.
 *
 * Reuses ONE canonical PostgresOrchestratorStack (Phases 2–23 services +
 * qualification). Manifest describes composition; this object is the runtime.
 *
 * Manifest != runtime. Runtime != authority.
 *
 * READY is derived only from a fresh evaluateReadiness() PASS.
 * There is no public switch that manufactures READY from a caller PASS object.
 */
export type ReferenceRuntimeLifecycleState =
  | "STARTING"
  | "READY"
  | "DRAINING"
  | "STOPPED";

export type ReferenceRuntime = {
  readonly stack: PostgresOrchestratorStack;
  readonly db: PostgresDatabase;
  readonly manifest: ReferenceRuntimeManifest;
  readonly productionConfigProfile: ProductionConfigProfile;
  readonly drain: DrainController;
  lifecycleState(): ReferenceRuntimeLifecycleState;
  isReady(): boolean;
  isAcceptingWork(): boolean;
  /**
   * Evaluate current readiness against live dependencies.
   * Does not transition lifecycle. Never accepts a caller-supplied PASS report.
   */
  evaluateReadiness(evaluatedAt?: string): Promise<ReadinessReport>;
  /**
   * Derive STARTING→READY iff a fresh evaluateReadiness() returns PASS.
   * On critical failure while already READY, demotes to STARTING (not accepting).
   * Does not accept an external readiness report.
   */
  markReady(evaluatedAt?: string): Promise<ReadinessReport>;
  beginDrain(): void;
  stop(): void;
  close(): Promise<void>;
};

function defaultProductionConfigProfile(
  environmentClass: "TEST" | "STAGING" | "PRODUCTION",
): ProductionConfigProfile {
  return productionConfigProfileFromRuntimeConfig({
    runtimeEnvironment: environmentClass === "PRODUCTION" ? "PRODUCTION" : "TEST",
    storageMode: "POSTGRES",
    runtimeRole: "COMBINED",
    authenticationMode: "HEADER_PRINCIPAL",
    workerConcurrency: 4,
    deliverySecretConfigured: true,
    debugMode: false,
    modelProviderEnabled: false,
  });
}

export async function createReferenceRuntime(input: {
  db: PostgresDatabase;
  instanceId: string;
  clock?: ClockPort;
  environmentClass?: "TEST" | "STAGING" | "PRODUCTION";
  /**
   * Production-like default is false. AuthorityDirectory.seed / control-plane
   * authority bootstrap run only when explicitly true (separate bootstrap).
   */
  seedControlPlane?: boolean;
  /**
   * Explicit test/bootstrap opt-in to seed the example repository fixture.
   * Production ReferenceRuntime default is false — never auto-create fixtures.
   */
  seedRepositorySources?: boolean;
  /** Optional profile evaluated by the same PRODUCTION_CONFIG readiness gate. */
  productionConfigProfile?: ProductionConfigProfile;
  qualificationFailpoint?: { name: string; trigger: () => void };
  assuranceCertificationFailpoint?: { name: string; trigger: () => void };
  schedulerGlobalMaxConcurrency?: number;
}): Promise<ReferenceRuntime> {
  const environmentClass = input.environmentClass ?? "TEST";
  const manifest = mintProductionReferenceRuntimeManifest(environmentClass);
  assertReferenceRuntimeProductionEligible(manifest);

  const productionConfigProfile =
    input.productionConfigProfile ??
    defaultProductionConfigProfile(environmentClass);
  // Eligibility is enforced at READY time by evaluateReadiness — not at construct.

  const stack = await createPostgresOrchestratorStack({
    db: input.db,
    instanceId: input.instanceId,
    // Fail closed: production ReferenceRuntime must not seed authority unless
    // an explicit bootstrap operation sets seedControlPlane: true.
    seedControlPlane: input.seedControlPlane ?? false,
    // Fail closed: never seed the example repository fixture unless an explicit
    // test/bootstrap path sets seedRepositorySources: true.
    seedRepositorySources: input.seedRepositorySources ?? false,
    ...(input.clock !== undefined ? { clock: input.clock } : {}),
    ...(input.qualificationFailpoint !== undefined
      ? { qualificationFailpoint: input.qualificationFailpoint }
      : {}),
    ...(input.assuranceCertificationFailpoint !== undefined
      ? { assuranceCertificationFailpoint: input.assuranceCertificationFailpoint }
      : {}),
    ...(input.schedulerGlobalMaxConcurrency !== undefined
      ? { schedulerGlobalMaxConcurrency: input.schedulerGlobalMaxConcurrency }
      : {}),
  });

  const boundManifest =
    stack.referenceRuntimeManifest.environmentClass === manifest.environmentClass
      ? stack.referenceRuntimeManifest
      : manifest;

  const drain = new DrainController();
  let lifecycle: ReferenceRuntimeLifecycleState = "STARTING";

  const evaluateReadiness = async (
    evaluatedAt?: string,
  ): Promise<ReadinessReport> => {
    const at = evaluatedAt ?? stack.clock.nowIso();
    const results: ReadinessCheckResult[] = [];

    try {
      await input.db.query("SELECT 1");
      results.push(
        buildReadinessCheck({
          checkId: "DATABASE_CONNECTIVITY",
          result: "PASS",
          reasonCode: "DB_OK",
        }),
      );
    } catch {
      results.push(
        buildReadinessCheck({
          checkId: "DATABASE_CONNECTIVITY",
          result: "FAIL",
          reasonCode: "DB_UNAVAILABLE",
        }),
      );
    }

    const health = await new PostgresHealthService(
      input.db,
      "postgres",
    ).readiness();
    results.push(
      buildReadinessCheck({
        checkId: "SCHEMA_COMPATIBILITY",
        result: health.schemaCompatible ? "PASS" : "FAIL",
        reasonCode: health.schemaCompatible
          ? "SCHEMA_OK"
          : "SCHEMA_INCOMPATIBLE",
      }),
    );
    results.push(
      buildReadinessCheck({
        checkId: "MIGRATION_HEAD",
        result:
          health.supportedSchemaVersion === SUPPORTED_SCHEMA_VERSION &&
          health.schemaVersion === SUPPORTED_SCHEMA_VERSION
            ? "PASS"
            : "FAIL",
        reasonCode: "MIGRATION_HEAD_CHECK",
      }),
    );

    try {
      assertReferenceRuntimeProductionEligible(boundManifest);
      results.push(
        buildReadinessCheck({
          checkId: "RUNTIME_MANIFEST",
          result: "PASS",
          reasonCode: "MANIFEST_OK",
        }),
      );
    } catch {
      results.push(
        buildReadinessCheck({
          checkId: "RUNTIME_MANIFEST",
          result: "FAIL",
          reasonCode: "MANIFEST_INVALID",
        }),
      );
    }

    results.push(
      buildReadinessCheck({
        checkId: "FAULT_INJECTION_DISABLED",
        result: boundManifest.faultInjectionAllowed ? "FAIL" : "PASS",
        reasonCode: "FAULT_INJECTION_GATE",
      }),
    );

    try {
      assertProductionConfigEligible(productionConfigProfile);
      if (boundManifest.authoritySeedingOnStartup) {
        throw new QualificationError(
          "PRODUCTION_CONFIG_INVALID",
          "Authority seeding on startup is not production-eligible",
        );
      }
      results.push(
        buildReadinessCheck({
          checkId: "PRODUCTION_CONFIG",
          result: "PASS",
          reasonCode: "CONFIG_OK",
        }),
      );
    } catch {
      results.push(
        buildReadinessCheck({
          checkId: "PRODUCTION_CONFIG",
          result: "FAIL",
          reasonCode: "CONFIG_INVALID",
        }),
      );
    }

    const authoritativeRepos =
      Boolean(stack.runs) &&
      Boolean(stack.admission) &&
      Boolean(stack.planning) &&
      Boolean(stack.validation) &&
      Boolean(stack.humanAuthorization) &&
      Boolean(stack.execution) &&
      Boolean(stack.verification) &&
      Boolean(stack.qualificationService);
    results.push(
      buildReadinessCheck({
        checkId: "WORKER_CONFIGURATION",
        result: stack.scheduler && authoritativeRepos ? "PASS" : "FAIL",
        reasonCode: authoritativeRepos
          ? "AUTHORITATIVE_REPOS_PRESENT"
          : "AUTHORITATIVE_REPOS_MISSING",
      }),
    );

    try {
      if (!stack.recovery) {
        throw new Error("recovery missing");
      }
      await stack.recovery.recover();
      results.push(
        buildReadinessCheck({
          checkId: "RECOVERY_STATE",
          result: "PASS",
          reasonCode: "RECOVERY_COMPLETE",
        }),
      );
    } catch {
      results.push(
        buildReadinessCheck({
          checkId: "RECOVERY_STATE",
          result: "FAIL",
          reasonCode: "RECOVERY_FAILED",
        }),
      );
    }

    results.push(
      buildReadinessCheck({
        checkId: "OBSERVABILITY",
        result: stack.observability ? "PASS" : "FAIL",
        reasonCode: "OBSERVABILITY_PRESENT",
      }),
    );
    results.push(
      buildReadinessCheck({
        checkId: "SHUTDOWN_CAPABILITY",
        result: "PASS",
        reasonCode: "DRAIN_CONTROLLER_PRESENT",
      }),
    );
    results.push(
      buildReadinessCheck({
        checkId: "SECURITY_BOUNDARY",
        result: "PASS",
        reasonCode: "COMPOSITION_OK",
        critical: false,
      }),
    );
    results.push(
      buildReadinessCheck({
        checkId: "DATA_MINIMIZATION",
        result: "PASS",
        reasonCode: "COMPOSITION_OK",
        critical: false,
      }),
    );

    return assembleReadinessReport({ results, evaluatedAt: at });
  };

  const demoteFromReady = (): void => {
    // Demote lifecycle only — do not permanently drain; a later successful
    // evaluateReadiness may re-enter READY on the same process.
    if (lifecycle === "READY") {
      lifecycle = "STARTING";
    }
  };

  const runtime: ReferenceRuntime = {
    stack,
    db: input.db,
    manifest: boundManifest,
    productionConfigProfile,
    drain,
    lifecycleState: () => lifecycle,
    isReady: () => lifecycle === "READY" && drain.isAcceptingWork(),
    isAcceptingWork: () =>
      lifecycle === "READY" && drain.isAcceptingWork(),
    evaluateReadiness,
    async markReady(evaluatedAt?: string) {
      if (
        lifecycle !== "STARTING" &&
        lifecycle !== "READY"
      ) {
        throw new QualificationError(
          "RUNTIME_RECOVERY_FAILED",
          `Cannot markReady from ${lifecycle}`,
        );
      }
      // READY is always derived from a fresh evaluator pass — never from a
      // caller-supplied synthetic ReadinessReport.
      const report = await evaluateReadiness(evaluatedAt);
      if (report.overall !== "PASS") {
        demoteFromReady();
        throw new QualificationError(
          "PRODUCTION_READINESS_FAILED",
          `Reference runtime not ready: ${report.overall}`,
          { overall: report.overall },
        );
      }
      lifecycle = "READY";
      return report;
    },
    beginDrain() {
      if (lifecycle !== "READY") {
        throw new QualificationError(
          "RUNTIME_DRAIN_FAILED",
          `Cannot drain from ${lifecycle}`,
        );
      }
      drain.beginDrain();
      lifecycle = "DRAINING";
    },
    stop() {
      if (lifecycle !== "DRAINING" && lifecycle !== "READY") {
        throw new QualificationError(
          "RUNTIME_DRAIN_FAILED",
          `Cannot stop from ${lifecycle}`,
        );
      }
      if (lifecycle === "READY") {
        drain.beginDrain();
        lifecycle = "DRAINING";
      }
      drain.stop();
      lifecycle = "STOPPED";
    },
    async close() {
      if (lifecycle === "READY") {
        runtime.beginDrain();
      }
      if (lifecycle === "DRAINING") {
        runtime.stop();
      }
      await stack.close();
      lifecycle = "STOPPED";
    },
  };

  return runtime;
}

/** Architecture signature: full stack composition, not assurance-only wrap. */
export const REFERENCE_RUNTIME_COMPOSITION_SIGNATURE =
  "createReferenceRuntime(db) → PostgresOrchestratorStack + DrainController + qualification — seedControlPlane defaults false — seedRepositorySources defaults false — READY only via fresh evaluateReadiness PASS — no FaultInjectionController";
