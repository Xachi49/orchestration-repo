import { ControlTowerService } from "../control-tower/service.js";
import { FakeApprovalDeliveryService } from "../authorization/delivery.js";
import type { LocalObservabilityStack } from "../infrastructure/observability/local-stack.js";
import type { PostgresOrchestratorStack } from "../infrastructure/postgres/stack.js";
import { EXAMPLE_PROJECT_ID } from "../control-plane/fixtures.js";
import type { ControlTowerRouteOptions } from "./control-tower.js";
import type { RuntimeConfig } from "../runtime/config.js";
import type { ProjectAccessDirectory } from "../runtime/access.js";

/** Development default project — not a production-only hardwire. */
export const CONTROL_TOWER_DEV_DEFAULT_PROJECT_ID = EXAMPLE_PROJECT_ID;

export function controlTowerFromStack(
  stack: PostgresOrchestratorStack | LocalObservabilityStack,
): ControlTowerService {
  const fakeDelivery =
    stack.approvalDelivery instanceof FakeApprovalDeliveryService
      ? stack.approvalDelivery
      : undefined;

  const isPostgres = "qualificationService" in stack;

  return new ControlTowerService({
    runs: stack.runs,
    objectives: stack.objectives,
    approvalRequests: stack.approvalRequests,
    decisionCards: stack.decisionCards,
    humanAuthorization: stack.humanAuthorization,
    ...(fakeDelivery ? { fakeDelivery } : {}),
    planning: stack.planning,
    validation: stack.validation,
    ingestion: stack.ingestion,
    execution: stack.execution,
    verification: stack.verification,
    ...(isPostgres
      ? {
          assuranceService: (stack as PostgresOrchestratorStack).assuranceService,
          qualificationService: (stack as PostgresOrchestratorStack)
            .qualificationService,
        }
      : {}),
    defaultProjectId: CONTROL_TOWER_DEV_DEFAULT_PROJECT_ID,
  });
}

/**
 * PRODUCTION never enables local-delivery. Fake delivery nonce channel is
 * DEVELOPMENT/TEST only.
 */
export function controlTowerRouteOptionsFromRuntime(input: {
  config: RuntimeConfig;
  access: ProjectAccessDirectory;
  hasFakeDelivery: boolean;
}): ControlTowerRouteOptions {
  const { config, access, hasFakeDelivery } = input;
  const allowLocalDelivery =
    config.runtimeEnvironment !== "PRODUCTION" && hasFakeDelivery;
  return {
    access,
    authenticationMode: config.authenticationMode,
    runtimeEnvironment: config.runtimeEnvironment,
    allowLocalDelivery,
    controlTowerDevAllowAll: config.controlTowerDevAllowAll,
  };
}
