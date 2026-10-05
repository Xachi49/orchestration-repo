import {
  FakeRecoveryMessagingProvider,
  RevenueRecoveryService,
  createInMemoryRevenueRecoveryRepos,
  loadRecoveryPilotConfig,
  createMessagingProviderForPilot,
  type ProductRuntimeEnvironment,
  type RecoveryMessagingProvider,
  type RecoveryObjectiveReissueOrchestratorPorts,
  type RecoveryRunReplacementOrchestratorPorts,
  type RecoveryPilotConfig,
  type ResendTransport,
} from "../revenue-recovery/index.js";
import type { AdmissionIdentityGenerator } from "../admission/identity.js";
import type { ObjectiveAdmissionService } from "../admission/service.js";
import type { ProjectRegistry } from "../control-plane/projects/registry.js";
import type { PostgresDatabase } from "../infrastructure/postgres/database.js";
import {
  PostgresLeadEventRepository,
  PostgresLeadRepository,
  PostgresProductAuditRepository,
  PostgresRecoveryAttemptRepository,
  PostgresRecoveryCaseRepository,
  PostgresRecoveryConfigRepository,
  PostgresRecoveryTemplateRepository,
  PostgresRevenueAttributionRepository,
  PostgresRevenueRecoveryRecordRepository,
} from "../infrastructure/postgres/repositories/revenue-recovery.js";
import { PostgresRecoveryProviderEventRepository } from "../infrastructure/postgres/repositories/revenue-recovery-provider-events.js";

/** In-memory unit harness — TEST provenance is permitted here only. */
export function createMemoryRevenueRecoveryService(input?: {
  nowIso?: () => string;
  admission?: ObjectiveAdmissionService;
  messaging?: RecoveryMessagingProvider;
  runtimeEnvironment?: ProductRuntimeEnvironment;
  pilotConfig?: RecoveryPilotConfig;
  resendTransport?: ResendTransport;
  projects?: ProjectRegistry;
  orchestrator?: RecoveryObjectiveReissueOrchestratorPorts;
  runReplacement?: {
    orchestrator: RecoveryRunReplacementOrchestratorPorts;
    identities: AdmissionIdentityGenerator;
  };
}): {
  service: RevenueRecoveryService;
  messaging: RecoveryMessagingProvider;
  repos: ReturnType<typeof createInMemoryRevenueRecoveryRepos>;
  pilotConfig: RecoveryPilotConfig;
} {
  const repos = createInMemoryRevenueRecoveryRepos();
  const pilotConfig =
    input?.pilotConfig ??
    ({ mode: "FAKE", livePilotRecipientAllowlist: [] } satisfies RecoveryPilotConfig);
  const messaging =
    input?.messaging ??
    (pilotConfig.mode === "FAKE"
      ? new FakeRecoveryMessagingProvider()
      : createMessagingProviderForPilot(pilotConfig, input?.resendTransport));
  const service = new RevenueRecoveryService({
    nowIso: input?.nowIso ?? (() => new Date().toISOString()),
    ...repos,
    messaging,
    pilotConfig,
    providerEvents: repos.providerEvents,
    runtimeEnvironment: input?.runtimeEnvironment ?? "TEST",
    ...(input?.admission ? { admission: input.admission } : {}),
    ...(input?.projects ? { projects: input.projects } : {}),
    ...(input?.orchestrator ? { orchestrator: input.orchestrator } : {}),
    ...(input?.runReplacement ? { runReplacement: input.runReplacement } : {}),
  });
  return { service, messaging, repos, pilotConfig };
}

/**
 * Durable service composition. Fails closed on economic provenance: callers
 * must opt into TEST explicitly, otherwise PRODUCTION rules apply.
 * Provider mode comes from env unless overridden (tests).
 */
export function createPostgresRevenueRecoveryService(input: {
  db: PostgresDatabase;
  nowIso: () => string;
  admission?: ObjectiveAdmissionService;
  runtimeEnvironment?: ProductRuntimeEnvironment;
  messaging?: RecoveryMessagingProvider;
  pilotConfig?: RecoveryPilotConfig;
  resendTransport?: ResendTransport;
  projects?: ProjectRegistry;
  orchestrator?: RecoveryObjectiveReissueOrchestratorPorts;
  runReplacement?: {
    orchestrator: RecoveryRunReplacementOrchestratorPorts;
    identities: AdmissionIdentityGenerator;
  };
}): {
  service: RevenueRecoveryService;
  messaging: RecoveryMessagingProvider;
  pilotConfig: RecoveryPilotConfig;
} {
  const pilotConfig = input.pilotConfig ?? loadRecoveryPilotConfig();
  const messaging =
    input.messaging ??
    createMessagingProviderForPilot(pilotConfig, input.resendTransport);
  const providerEvents = new PostgresRecoveryProviderEventRepository(input.db);
  const service = new RevenueRecoveryService({
    nowIso: input.nowIso,
    runtimeEnvironment: input.runtimeEnvironment ?? "PRODUCTION",
    leads: new PostgresLeadRepository(input.db),
    leadEvents: new PostgresLeadEventRepository(input.db),
    cases: new PostgresRecoveryCaseRepository(input.db),
    configs: new PostgresRecoveryConfigRepository(input.db),
    attempts: new PostgresRecoveryAttemptRepository(input.db),
    attributions: new PostgresRevenueAttributionRepository(input.db),
    records: new PostgresRevenueRecoveryRecordRepository(input.db),
    templates: new PostgresRecoveryTemplateRepository(input.db),
    audits: new PostgresProductAuditRepository(input.db),
    messaging,
    pilotConfig,
    providerEvents,
    ...(input.admission ? { admission: input.admission } : {}),
    ...(input.projects ? { projects: input.projects } : {}),
    ...(input.orchestrator ? { orchestrator: input.orchestrator } : {}),
    withTemplateScopeLock: (scopeKey, fn) =>
      input.db.withTransaction(async () => {
        await input.db.query(
          `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
          [scopeKey],
        );
        return fn();
      }),
    // Admission adapters join the ambient transaction, so objective, run,
    // case rebind, and audit commit or roll back as one unit.
    withObjectiveReissueLock: (recoveryCaseId, fn) =>
      input.db.withTransaction(async () => {
        await input.db.query(
          `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
          [`rr-objective-reissue:${recoveryCaseId}`],
        );
        return fn();
      }),
    ...(input.runReplacement
      ? {
          runReplacement: {
            orchestrator: input.runReplacement.orchestrator,
            identities: input.runReplacement.identities,
            withReplacementLock: <T>(
              recoveryCaseId: string,
              fn: () => Promise<T>,
            ) =>
              input.db.withTransaction(async () => {
                await input.db.query(
                  `SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`,
                  [`rr-run-replacement:${recoveryCaseId}`],
                );
                return fn();
              }),
          },
        }
      : {}),
  });
  return { service, messaging, pilotConfig };
}
