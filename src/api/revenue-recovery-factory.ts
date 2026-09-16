import {
  FakeRecoveryMessagingProvider,
  RevenueRecoveryService,
  createInMemoryRevenueRecoveryRepos,
  type ProductRuntimeEnvironment,
} from "../revenue-recovery/index.js";
import type { ObjectiveAdmissionService } from "../admission/service.js";
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

/** In-memory unit harness — TEST provenance is permitted here only. */
export function createMemoryRevenueRecoveryService(input?: {
  nowIso?: () => string;
  admission?: ObjectiveAdmissionService;
  messaging?: FakeRecoveryMessagingProvider;
  runtimeEnvironment?: ProductRuntimeEnvironment;
}): {
  service: RevenueRecoveryService;
  messaging: FakeRecoveryMessagingProvider;
  repos: ReturnType<typeof createInMemoryRevenueRecoveryRepos>;
} {
  const repos = createInMemoryRevenueRecoveryRepos();
  const messaging = input?.messaging ?? new FakeRecoveryMessagingProvider();
  const service = new RevenueRecoveryService({
    nowIso: input?.nowIso ?? (() => new Date().toISOString()),
    ...repos,
    messaging,
    runtimeEnvironment: input?.runtimeEnvironment ?? "TEST",
    ...(input?.admission ? { admission: input.admission } : {}),
  });
  return { service, messaging, repos };
}

/**
 * Durable service composition. Fails closed on economic provenance: callers
 * must opt into TEST explicitly, otherwise PRODUCTION rules apply.
 */
export function createPostgresRevenueRecoveryService(input: {
  db: PostgresDatabase;
  nowIso: () => string;
  admission?: ObjectiveAdmissionService;
  runtimeEnvironment?: ProductRuntimeEnvironment;
  messaging?: FakeRecoveryMessagingProvider;
}): {
  service: RevenueRecoveryService;
  messaging: FakeRecoveryMessagingProvider;
} {
  const messaging = input.messaging ?? new FakeRecoveryMessagingProvider();
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
    ...(input.admission ? { admission: input.admission } : {}),
  });
  return { service, messaging };
}
