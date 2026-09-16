/**
 * Helpers for Continuum Revenue Recovery PostgreSQL product qualification.
 * NOT Phase 25. Scenarios A–O + economic headline execute against durable Postgres.
 *
 * Accumulated-DB safe: every invocation must use uniquePostgresTestId material.
 * Do not truncate, drop, or globally clean the database.
 */
import { EXAMPLE_ENVIRONMENT, EXAMPLE_PROJECT } from "../../control-plane/fixtures.js";
import type { RecoveryConfigurationInput } from "../../revenue-recovery/recovery-config.js";
import type { LeadIngestInput } from "../../revenue-recovery/lead.js";
import type { PlanningModel } from "../../planning/model.js";
import type { ProductRuntimeEnvironment } from "../../revenue-recovery/provenance.js";
import type { RecoverySmsPlanBinding } from "../../revenue-recovery/recovery-sms-planning-model.js";
import { createRecoverySmsPlanningModel } from "../../revenue-recovery/recovery-sms-planning-model.js";
import {
  createRecoveryEmailPlanningModel,
  type RecoveryEmailPlanBinding,
} from "../../revenue-recovery/recovery-email-planning-model.js";
import type { RecoveryPilotConfig } from "../../revenue-recovery/pilot-config.js";
import type { RecoveryMessagingProvider } from "../../revenue-recovery/messaging.js";
import type { ResendTransport } from "../../revenue-recovery/resend-provider.js";
import { MutableClock } from "../clock.js";
import { seedDedicatedPostgresTestProject } from "./test-project-isolation.js";
import {
  createTestDatabase,
  uniquePostgresTestId,
  buildPostgresTestAdmissionRequest,
} from "./test-helpers.js";
import {
  createPostgresOrchestratorStack,
  type PostgresOrchestratorStack,
} from "./stack.js";
import type { PostgresDatabase } from "./database.js";
import { PostgresProjectRegistry } from "./repositories/control-plane.js";

/** Legacy demo constants — unit tests only. Prefer uniqueIds() for Postgres. */
export const RR_CUSTOMER = "continuum_demo_tenant";
export const RR_PROJECT = EXAMPLE_PROJECT.projectId;

/** Monday 15:00 UTC — inside Mon–Fri 09–17 UTC window window. */
export const RR_MONDAY_IN_WINDOW = "2026-09-14T15:00:00.000Z";
export const RR_LEAD_CREATED_AT = "2026-09-14T12:00:00.000Z";
/** Saturday — outside Mon–Fri window. */
export const RR_SATURDAY_OUTSIDE_WINDOW = "2026-09-12T15:00:00.000Z";

export function demoRecoveryConfig(
  overrides: Partial<RecoveryConfigurationInput> = {},
): RecoveryConfigurationInput {
  return {
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    responseGapThresholdMinutes: 15,
    allowedChannels: ["SMS", "EMAIL", "CALL_TASK"],
    contactWindow: {
      startHourLocal: 0,
      endHourLocal: 24,
      daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    },
    timezone: "America/Chicago",
    maxSmsAttempts: 3,
    maxEmailAttempts: 2,
    maxCallTasks: 2,
    cooldownMinutes: 30,
    maximumRecoveryAgeDays: 14,
    attributionWindowDays: 30,
    currency: "USD",
    businessName: "Continuum Demo HVAC",
    bookingLink: "https://example.com/book",
    enabled: true,
    ...overrides,
  };
}

export function demoLead(
  overrides: Partial<LeadIngestInput> = {},
): LeadIngestInput {
  return {
    customerAccountId: RR_CUSTOMER,
    projectId: RR_PROJECT,
    externalLeadId: "ext_lead_demo_4800",
    source: "WEBHOOK",
    createdAt: "2026-09-12T12:00:00.000Z",
    firstName: "Alex",
    phone: "+15551234567",
    email: "alex@example.com",
    serviceRequested: "AC replacement estimate",
    serviceArea: "Austin TX",
    estimatedValue: 4800,
    currency: "USD",
    consent: { smsOptIn: true, emailOptIn: true, callOptIn: true },
    ...overrides,
  };
}

export const PRODUCT_POSTGRES_SCENARIOS = [
  "A_GAP_TO_RECOVERY",
  "B_CONTACT_BLOCKED",
  "C_GOVERNED_RECOVERY",
  "D_TARGET_CONTAINMENT",
  "E_RESPONSE_STOPS_FOLLOW_UP",
  "F_APPOINTMENT",
  "G_CONFIRMED_SALE",
  "H_PAYMENT",
  "I_IDEMPOTENT_WEBHOOK",
  "J_LEAD_CONFLICT",
  "K_ATTEMPT_CEILING",
  "L_CONTACT_WINDOW",
  "M_ORCHESTRATOR_BOUNDARY",
  "N_CONTROL_TOWER_READ_MODEL",
  "O_TENANT_ISOLATION",
  "ECONOMIC_HEADLINE_4800",
  "MANUAL_PROVENANCE_NEGATIVE",
  "PHASE7_RETRY_IDEMPOTENCY",
] as const;

export type RrUniqueIds = {
  customerAccountId: string;
  projectId: string;
  externalLeadId: string;
};

/** Fresh tenant/project/lead identity for one Postgres invocation. */
export function uniqueRrIds(label: string): RrUniqueIds {
  return {
    customerAccountId: uniquePostgresTestId(`rr_cust_${label}`),
    projectId: uniquePostgresTestId(`rr_proj_${label}`),
    externalLeadId: uniquePostgresTestId(`rr_ext_${label}`),
  };
}

export function rrConfigFor(
  ids: RrUniqueIds,
  overrides: Partial<RecoveryConfigurationInput> = {},
): RecoveryConfigurationInput {
  return demoRecoveryConfig({
    customerAccountId: ids.customerAccountId,
    projectId: ids.projectId,
    timezone: "UTC",
    contactWindow: {
      startHourLocal: 9,
      endHourLocal: 17,
      daysOfWeek: [1, 2, 3, 4, 5],
    },
    cooldownMinutes: 0,
    responseGapThresholdMinutes: 15,
    maxSmsAttempts: 3,
    ...overrides,
  });
}

export function rrLeadFor(
  ids: RrUniqueIds,
  overrides: Partial<LeadIngestInput> = {},
): LeadIngestInput {
  return demoLead({
    customerAccountId: ids.customerAccountId,
    projectId: ids.projectId,
    externalLeadId: ids.externalLeadId,
    createdAt: RR_LEAD_CREATED_AT,
    ...overrides,
  });
}

/**
 * Seed a SUPERVISED dedicated project so SEND_RECOVERY_* is not
 * rejected by PATCH_ONLY preflight/validation.
 */
export async function seedSupervisedRecoveryProject(
  db: PostgresDatabase,
  projectId: string,
): Promise<string> {
  await seedDedicatedPostgresTestProject(db, projectId);
  const projects = new PostgresProjectRegistry(db);
  const existing = await projects.getById(projectId);
  if (!existing) {
    throw new Error(`expected seeded project ${projectId}`);
  }
  await projects.seed([
    {
      ...existing,
      executionMode: "SUPERVISED",
    },
  ]);
  return projectId;
}

export type RrPostgresEnv = {
  db: PostgresDatabase;
  stack: PostgresOrchestratorStack;
  clock: MutableClock;
  ids: RrUniqueIds;
  planBinding: RecoverySmsPlanBinding;
  emailPlanBinding: RecoveryEmailPlanBinding;
  close: () => Promise<void>;
};

/**
 * Accumulated-DB-safe RR Postgres environment:
 * unique project (SUPERVISED) + MutableClock + TEST provenance + optional SMS/email plan.
 */
export async function createRrPostgresEnv(input: {
  label: string;
  ids?: RrUniqueIds;
  clockIso?: string;
  withRecoverySmsPlan?: boolean;
  withRecoveryEmailPlan?: boolean;
  runtimeEnvironment?: ProductRuntimeEnvironment;
  pilotConfig?: RecoveryPilotConfig;
  messaging?: RecoveryMessagingProvider;
  resendTransport?: ResendTransport;
}): Promise<RrPostgresEnv> {
  process.env["APPROVAL_DELIVERY_SECRET_KEY"] =
    process.env["APPROVAL_DELIVERY_SECRET_KEY"] ??
    Buffer.alloc(32, 11).toString("base64");

  const ids = input.ids ?? uniqueRrIds(input.label);
  const instanceId = uniquePostgresTestId(`rr_stack_${input.label}`);
  const db = await createTestDatabase(instanceId);
  await seedSupervisedRecoveryProject(db, ids.projectId);

  const clock = new MutableClock(input.clockIso ?? RR_MONDAY_IN_WINDOW);
  const planBinding: RecoverySmsPlanBinding = {
    recoveryCaseId: "",
    leadId: "",
    templateId: "",
    templateVersion: 1,
  };
  const emailPlanBinding: RecoveryEmailPlanBinding = {
    recoveryCaseId: "",
    leadId: "",
    templateId: "",
    templateVersion: 1,
  };
  let planningModel: PlanningModel | undefined;
  if (input.withRecoveryEmailPlan) {
    planningModel = createRecoveryEmailPlanningModel(emailPlanBinding);
  } else if (input.withRecoverySmsPlan !== false) {
    planningModel = createRecoverySmsPlanningModel(planBinding);
  }

  const stack = await createPostgresOrchestratorStack({
    db,
    instanceId,
    clock,
    seedControlPlane: true,
    seedRepositorySources: true,
    revenueRecoveryRuntimeEnvironment: input.runtimeEnvironment ?? "TEST",
    ...(planningModel ? { planningModel } : {}),
    ...(input.pilotConfig ? { revenueRecoveryPilotConfig: input.pilotConfig } : {}),
    ...(input.messaging ? { revenueRecoveryMessaging: input.messaging } : {}),
    ...(input.resendTransport
      ? { revenueRecoveryResendTransport: input.resendTransport }
      : {}),
  });

  return {
    db,
    stack,
    clock,
    ids,
    planBinding,
    emailPlanBinding,
    close: async () => {
      await stack.close();
    },
  };
}

export function rrAdmissionRequest(input: {
  label: string;
  projectId: string;
  recoveryCaseId: string;
}) {
  return buildPostgresTestAdmissionRequest({
    testName: `rr-${input.label}`,
    uniqueSuffix: uniquePostgresTestId("obj"),
    projectId: input.projectId,
  });
}

export {
  EXAMPLE_ENVIRONMENT,
  createRecoverySmsPlanningModel,
  createRecoveryEmailPlanningModel,
};
