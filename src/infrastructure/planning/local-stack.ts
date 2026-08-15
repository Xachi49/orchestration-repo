import { createLocalIngestionStack } from "../ingestion/local-stack.js";
import type { LocalIngestionStack } from "../ingestion/local-stack.js";
import {
  PlanningReadinessService,
  PlanningService,
  InMemoryPlanningCoordinator,
  InMemoryPlanRepository,
  InMemoryPlanningUsageLedger,
  FakePlanningModel,
  SequencePlanIdentityGenerator,
  type PlanningModel,
} from "../../planning/index.js";
import type { RequesterGrant } from "../../admission/authorization.js";
import type { ResourceBudgetProfile } from "../../control-plane/budgets/budget.js";
import type {
  PlanningMaxOutputTokensByOperation,
  PlanningTokenReservationEstimator,
} from "../../planning/token-reservation.js";
import { InMemoryCapabilityRegistry } from "../control-plane/in-memory-capability-registry.js";
import { EXAMPLE_CAPABILITIES } from "../../control-plane/fixtures.js";

export interface LocalPlanningStack extends LocalIngestionStack {
  planning: PlanningService;
  planningCoordinator: InMemoryPlanningCoordinator;
  plans: InMemoryPlanRepository;
  planningModel: PlanningModel;
  usage: InMemoryPlanningUsageLedger;
  readiness: PlanningReadinessService;
}

/**
 * Local stack for Phase 4. Uses FakePlanningModel by default.
 * Never constructs OpenAIPlanningModel unless explicitly injected.
 */
export function createLocalPlanningStack(options?: {
  grants?: readonly RequesterGrant[];
  clockIso?: string;
  budgets?: readonly ResourceBudgetProfile[];
  model?: PlanningModel;
  tokenEstimator?: PlanningTokenReservationEstimator;
  maxOutputTokensByOperation?: PlanningMaxOutputTokensByOperation;
}): LocalPlanningStack {
  const baseOptions: {
    grants?: readonly RequesterGrant[];
    clockIso?: string;
    budgets?: readonly ResourceBudgetProfile[];
  } = {};
  if (options?.grants) {
    baseOptions.grants = options.grants;
  }
  if (options?.clockIso) {
    baseOptions.clockIso = options.clockIso;
  }
  if (options?.budgets) {
    baseOptions.budgets = options.budgets;
  }
  const base = createLocalIngestionStack(baseOptions);
  const planningCoordinator = new InMemoryPlanningCoordinator();
  const plans = new InMemoryPlanRepository();
  const usage = new InMemoryPlanningUsageLedger();
  const planningModel = options?.model ?? new FakePlanningModel();
  const capabilities = new InMemoryCapabilityRegistry(EXAMPLE_CAPABILITIES);
  const readiness = new PlanningReadinessService({
    runs: base.runs,
    contexts: base.contexts,
    locks: base.locks,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
  });
  const planning = new PlanningService({
    readiness,
    coordinator: planningCoordinator,
    runs: base.runs,
    objectives: base.objectives,
    controlPlane: base.controlPlane,
    contexts: base.contexts,
    locks: base.locks,
    evidence: base.evidence,
    workspace: base.workspace,
    model: planningModel,
    usage,
    plans,
    capabilities,
    identities: new SequencePlanIdentityGenerator(),
    clock: base.clock,
    ...(options?.tokenEstimator
      ? { tokenEstimator: options.tokenEstimator }
      : {}),
    ...(options?.maxOutputTokensByOperation
      ? { maxOutputTokensByOperation: options.maxOutputTokensByOperation }
      : {}),
  });
  return {
    ...base,
    planning,
    planningCoordinator,
    plans,
    planningModel,
    usage,
    readiness,
  };
}
