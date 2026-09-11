import type { ClockPort } from "../clock.js";
import type { PostgresDatabase } from "./database.js";
import { uniquePostgresTestId } from "./test-helpers.js";
import {
  mintProductionReferenceRuntimeManifest,
  type ReleaseCandidateIdentity,
  computeReleaseCandidateFingerprint,
  withBuildArtifactFingerprint,
  type BuildArtifactManifest,
  type ReferenceRuntimeManifest,
} from "../../qualification/index.js";
import { SUPPORTED_SCHEMA_VERSION } from "../../domain/durability/index.js";
import { createHash } from "node:crypto";
import {
  createReferenceRuntime,
  type ReferenceRuntime,
} from "./reference-runtime.js";

export type P24TestEnv = {
  db: PostgresDatabase;
  runtime: ReferenceRuntime;
  /** Canonical stack handle (same as runtime.stack). */
  stack: ReferenceRuntime["stack"];
  close: () => Promise<void>;
};

export async function createP24Env(
  suffix: string,
  opts?: {
    clock?: ClockPort;
    seedControlPlane?: boolean;
    /**
     * Explicit test fixture seeding for EXAMPLE_REPOSITORY_SOURCE.
     * Defaults true only when seedControlPlane is true (golden-path bootstrap).
     * Production-like boots leave this false.
     */
    seedRepositorySources?: boolean;
    qualificationFailpoint?: { name: string; trigger: () => void };
    schedulerGlobalMaxConcurrency?: number;
    productionConfigProfile?: import("../../qualification/production-config.js").ProductionConfigProfile;
  },
): Promise<P24TestEnv> {
  const { createTestDatabase } = await import("./test-helpers.js");
  const seedControlPlane = opts?.seedControlPlane ?? false;
  const seedRepositorySources =
    opts?.seedRepositorySources ?? seedControlPlane;
  const db = await createTestDatabase(uniquePostgresTestId(`p24-${suffix}`));
  const runtime = await createReferenceRuntime({
    db,
    instanceId: uniquePostgresTestId(`p24-rt-${suffix}`),
    environmentClass: "TEST",
    seedControlPlane,
    seedRepositorySources,
    ...(opts?.clock !== undefined ? { clock: opts.clock } : {}),
    ...(opts?.qualificationFailpoint !== undefined
      ? { qualificationFailpoint: opts.qualificationFailpoint }
      : {}),
    ...(opts?.schedulerGlobalMaxConcurrency !== undefined
      ? { schedulerGlobalMaxConcurrency: opts.schedulerGlobalMaxConcurrency }
      : {}),
    ...(opts?.productionConfigProfile !== undefined
      ? { productionConfigProfile: opts.productionConfigProfile }
      : {}),
  });
  let closed = false;
  return {
    db,
    runtime,
    stack: runtime.stack,
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await runtime.close();
      } catch {
        // Idempotent: restart scenarios may already have closed the pool.
      }
    },
  };
}

/**
 * Fresh ReferenceRuntime with its own pg Pool against TEST_DATABASE_URL.
 * Does not reuse Runtime A's PostgresDatabase / Pool (restart isolation).
 * Caller must close Runtime A before relying on B as the sole live handle.
 */
export async function createP24ConcurrentRuntime(
  _sharedDb: PostgresDatabase,
  suffix: string,
  opts?: {
    seedControlPlane?: boolean;
    seedRepositorySources?: boolean;
    schedulerGlobalMaxConcurrency?: number;
  },
): Promise<ReferenceRuntime> {
  const { createIndependentDatabase } = await import("./test-helpers.js");
  const seedControlPlane = opts?.seedControlPlane ?? false;
  const seedRepositorySources =
    opts?.seedRepositorySources ?? seedControlPlane;
  // Fresh pool B — ignore A's db handle (may already be pool.end()'d).
  const db = await createIndependentDatabase(
    uniquePostgresTestId(`p24-c-db-${suffix}`),
  );
  return createReferenceRuntime({
    db,
    instanceId: uniquePostgresTestId(`p24-c-${suffix}`),
    environmentClass: "TEST",
    seedControlPlane,
    seedRepositorySources,
    ...(opts?.schedulerGlobalMaxConcurrency !== undefined
      ? { schedulerGlobalMaxConcurrency: opts.schedulerGlobalMaxConcurrency }
      : {}),
  });
}

/**
 * TEST-ONLY: separate connection to observe blockers while a G step stalls.
 * Returns bounded metadata only — no credentials / connection strings.
 */
export async function p24CapturePostgresWaitSnapshot(): Promise<{
  activity: Array<{
    pid: number;
    state: string | null;
    wait_event_type: string | null;
    wait_event: string | null;
    xact_start: string | null;
    query_start: string | null;
    query_class: string;
    blocking_pids: number[];
  }>;
  locks: Array<{
    pid: number | null;
    locktype: string;
    mode: string;
    granted: boolean;
    relation: string | null;
  }>;
}> {
  const { createIndependentDatabase } = await import("./test-helpers.js");
  const probe = await createIndependentDatabase(
    uniquePostgresTestId("p24-diag"),
  );
  try {
    const activity = await probe.query<{
      pid: number;
      state: string | null;
      wait_event_type: string | null;
      wait_event: string | null;
      xact_start: Date | null;
      query_start: Date | null;
      query: string | null;
      blocking_pids: number[] | null;
    }>(
      `SELECT a.pid, a.state, a.wait_event_type, a.wait_event,
              a.xact_start, a.query_start,
              left(a.query, 120) AS query,
              pg_blocking_pids(a.pid) AS blocking_pids
       FROM pg_stat_activity a
       WHERE a.datname = current_database()
         AND a.pid <> pg_backend_pid()
         AND a.state IS DISTINCT FROM 'idle'
       ORDER BY a.query_start NULLS LAST
       LIMIT 20`,
    );
    const locks = await probe.query<{
      pid: number | null;
      locktype: string;
      mode: string;
      granted: boolean;
      relation: string | null;
    }>(
      `SELECT l.pid, l.locktype, l.mode, l.granted,
              c.relname AS relation
       FROM pg_locks l
       LEFT JOIN pg_class c ON c.oid = l.relation
       WHERE l.pid IN (
         SELECT pid FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
       )
       LIMIT 40`,
    );
    return {
      activity: activity.rows.map((row) => ({
        pid: row.pid,
        state: row.state,
        wait_event_type: row.wait_event_type,
        wait_event: row.wait_event,
        xact_start: row.xact_start?.toISOString() ?? null,
        query_start: row.query_start?.toISOString() ?? null,
        query_class: classifyQuery(row.query),
        blocking_pids: row.blocking_pids ?? [],
      })),
      locks: locks.rows.map((row) => ({
        pid: row.pid,
        locktype: row.locktype,
        mode: row.mode,
        granted: row.granted,
        relation: row.relation,
      })),
    };
  } finally {
    await probe.close();
  }
}

function classifyQuery(query: string | null): string {
  if (!query) return "empty";
  const q = query.replace(/\s+/g, " ").trim();
  if (/scheduler_decisions/i.test(q) && /candidateWorkIds/i.test(q)) {
    return "scheduler_decisions_candidate_jsonb";
  }
  if (/scheduler_decisions/i.test(q)) return "scheduler_decisions";
  if (/scheduler_work_items/i.test(q)) return "scheduler_work_items";
  if (/scheduler_project_config/i.test(q)) return "scheduler_project_config";
  if (/scheduler_fairness/i.test(q)) return "scheduler_fairness";
  if (/coordinator_leases/i.test(q)) return "coordinator_leases";
  return q.slice(0, 80);
}

/**
 * Explicit test-only fixture: seed EXAMPLE_REPOSITORY_SOURCE into an existing stack.
 * Not invoked by production ReferenceRuntime startup.
 */
export async function seedP24ExampleRepositorySource(
  stack: ReferenceRuntime["stack"],
): Promise<void> {
  const { EXAMPLE_REPOSITORY_SOURCE } = await import(
    "../../ingestion/fixtures.js"
  );
  await stack.repositorySources.seed([EXAMPLE_REPOSITORY_SOURCE]);
}

export function p24BuildCandidate(
  overrides: Partial<ReleaseCandidateIdentity> = {},
): {
  candidate: ReleaseCandidateIdentity;
  fingerprint: string;
  runtimeManifest: ReferenceRuntimeManifest;
  buildManifest: BuildArtifactManifest;
} {
  const runtimeManifest = mintProductionReferenceRuntimeManifest("TEST");
  const buildManifest = withBuildArtifactFingerprint({
    buildManifestVersion: "phase24-build-manifest-v1",
    commitSha: overrides.commitSha ?? "p24commit",
    packageLockHash:
      overrides.packageLockHash ??
      createHash("sha256").update("p24-lock").digest("hex"),
    migrationSetFingerprint:
      overrides.migrationSetFingerprint ??
      createHash("sha256").update("migrations-through-019").digest("hex"),
    supportedSchemaVersion:
      overrides.supportedSchemaVersion ?? SUPPORTED_SCHEMA_VERSION,
    runtimeTarget: "node24",
    files: [
      {
        relativePath: "index.js",
        contentHash: createHash("sha256").update("idx").digest("hex"),
      },
    ],
  });
  const candidate: ReleaseCandidateIdentity = {
    repositoryIdentity: overrides.repositoryIdentity ?? "orchestration-repo",
    commitSha: buildManifest.commitSha,
    repositoryFingerprint:
      overrides.repositoryFingerprint ??
      createHash("sha256").update("repo-p24").digest("hex"),
    packageLockHash: buildManifest.packageLockHash,
    buildArtifactFingerprint: buildManifest.buildArtifactFingerprint,
    migrationSetFingerprint: buildManifest.migrationSetFingerprint,
    supportedSchemaVersion: buildManifest.supportedSchemaVersion,
    runtimeVersion: overrides.runtimeVersion ?? "24.0.0",
    productionConfigurationProfileFingerprint:
      overrides.productionConfigurationProfileFingerprint ??
      createHash("sha256").update("prod-cfg-p24").digest("hex"),
    referenceRuntimeManifestHash: runtimeManifest.manifestHash,
    assuranceTargetFingerprint:
      overrides.assuranceTargetFingerprint ?? "pending-target",
    controlCatalogFingerprint:
      overrides.controlCatalogFingerprint ??
      createHash("sha256").update("catalog-p24").digest("hex"),
  };
  return {
    candidate,
    fingerprint: computeReleaseCandidateFingerprint(candidate),
    runtimeManifest,
    buildManifest,
  };
}

/** Scoped operational / authority surface for zero-authority delta proofs. */
export type P24AuthoritySurface = {
  authorityGrants: number;
  assuranceRoleGrants: number;
  governanceMandates: number;
  constitutionalActivations: number;
  federationAgreements: number;
  runs: number;
  approvalRequests: number;
  authorizationRecords: number;
  executionAttempts: number;
};

export async function p24CaptureAuthoritySurface(
  db: PostgresDatabase,
  scope: { projectId: string; institutionId: string; runId?: string },
): Promise<P24AuthoritySurface> {
  const count = async (sql: string, params: unknown[]): Promise<number> => {
    const r = await db.query<{ c: string }>(sql, params);
    return Number(r.rows[0]!.c);
  };

  const approvalParams = scope.runId ? [scope.runId] : [scope.projectId];
  const approvalClause = scope.runId
    ? "AND payload->>'runId' = $1"
    : "AND payload->>'projectId' = $1";
  const runScoped = scope.runId
    ? { clause: "AND payload->>'runId' = $1", params: [scope.runId] as unknown[] }
    : {
        clause:
          "AND payload->>'runId' IN (SELECT run_id FROM runs WHERE project_id = $1)",
        params: [scope.projectId] as unknown[],
      };

  return {
    authorityGrants: await count(
      `SELECT count(*)::text AS c FROM authority_grants WHERE project_id = $1`,
      [scope.projectId],
    ),
    assuranceRoleGrants: await count(
      `SELECT count(*)::text AS c FROM authority_grants
       WHERE project_id = $1
         AND principal_type IN (
           'ASSURANCE_OPERATOR', 'ASSURANCE_CERTIFIER', 'ASSURANCE_REVIEWER'
         )`,
      [scope.projectId],
    ),
    governanceMandates: await count(
      `SELECT count(*)::text AS c FROM governance_mandates WHERE institution_id = $1`,
      [scope.institutionId],
    ),
    constitutionalActivations: await count(
      `SELECT count(*)::text AS c FROM constitutional_activation_records
       WHERE payload->>'institutionId' = $1`,
      [scope.institutionId],
    ),
    federationAgreements: await count(
      `SELECT count(*)::text AS c FROM federation_agreements
       WHERE payload->>'localInstitutionId' = $1
          OR payload->>'remoteInstitutionId' = $1
          OR payload->>'institutionId' = $1`,
      [scope.institutionId],
    ),
    runs: await count(
      `SELECT count(*)::text AS c FROM runs WHERE project_id = $1`,
      [scope.projectId],
    ),
    approvalRequests: await count(
      `SELECT count(*)::text AS c FROM json_documents
       WHERE collection = 'approval_requests' ${approvalClause}`,
      approvalParams,
    ),
    authorizationRecords: await count(
      `SELECT count(*)::text AS c FROM json_documents
       WHERE collection = 'authorization_records' ${runScoped.clause}`,
      runScoped.params,
    ),
    executionAttempts: await count(
      `SELECT count(*)::text AS c FROM json_documents
       WHERE collection = 'execution_attempts' ${runScoped.clause}`,
      runScoped.params,
    ),
  };
}

/** Record trusted qualification evidence required for QUALIFIED_FOR_RELEASE. */
export async function p24RecordCriticalEvidence(input: {
  stack: ReferenceRuntime["stack"];
  qualificationRunId: string;
  certificateId: string;
  certificateHash: string;
  readinessFingerprint: string;
  goldenPathRunId: string;
  goldenPathCompletionHash: string;
  recoveryBoundary: string;
  recoveryFingerprint: string;
  buildArtifactFingerprint: string;
  generatedAt: string;
}): Promise<void> {
  const q = input.stack.qualificationService;
  await q.recordTrustedEvidence({
    qualificationRunId: input.qualificationRunId,
    evidenceKind: "PHASE23_CERTIFICATE_REF",
    referencedIdentity: input.certificateId,
    referencedHash: input.certificateHash,
    resultCode: "PASS",
    generatedAt: input.generatedAt,
    metadata: {},
  });
  await q.recordTrustedEvidence({
    qualificationRunId: input.qualificationRunId,
    evidenceKind: "READINESS_REPORT",
    referencedIdentity: `readiness:${input.qualificationRunId}`,
    referencedHash: input.readinessFingerprint,
    resultCode: "PASS",
    generatedAt: input.generatedAt,
    metadata: {},
  });
  await q.recordTrustedEvidence({
    qualificationRunId: input.qualificationRunId,
    evidenceKind: "GOLDEN_PATH_ACCEPTANCE",
    referencedIdentity: input.goldenPathRunId,
    referencedHash: input.goldenPathCompletionHash,
    resultCode: "PASS",
    generatedAt: input.generatedAt,
    metadata: {},
  });
  await q.recordTrustedEvidence({
    qualificationRunId: input.qualificationRunId,
    evidenceKind: "RESTART_RECOVERY",
    referencedIdentity: input.recoveryBoundary,
    referencedHash: input.recoveryFingerprint,
    resultCode: "PASS",
    generatedAt: input.generatedAt,
    metadata: {},
  });
  await q.recordTrustedEvidence({
    qualificationRunId: input.qualificationRunId,
    evidenceKind: "BUILD_MANIFEST_VERIFICATION",
    referencedIdentity: "build-artifact",
    referencedHash: input.buildArtifactFingerprint,
    resultCode: "PASS",
    generatedAt: input.generatedAt,
    metadata: {},
  });
}
